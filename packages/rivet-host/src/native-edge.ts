import { createHash, timingSafeEqual } from "node:crypto"
import { PresenceHub, ThreadDigest, ThreadSearchQuery, WorkspaceAccess, WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbChanges, OrbFiles, OrbManager, OrbPty, OrbPtyWebSocket as OrbPtyWs } from "@rika/orb"
import { ArtifactStore, Database, OrbStore, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Artifact, Codec, Common, Event, Ide, Ids, Orb, Remote } from "@rika/schema"
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as ThreadActor from "./thread-actor"
import * as ThreadClient from "./thread-client"
import * as ThreadDirectory from "./thread-directory"

export interface ServeInput {
  readonly hostname?: string
  readonly port?: number
  readonly token?: string
  readonly workspace_root?: string
  readonly orb?: boolean
  readonly base_commit?: string
}

export interface ServedEdge {
  readonly url: string
  readonly close: () => Effect.Effect<void>
}

export interface Interface {
  readonly handle: (request: Request) => Effect.Effect<Response>
  readonly serve: (input?: ServeInput) => Effect.Effect<ServedEdge, NativeEdgeError>
}

export class NativeEdgeError extends Schema.TaggedErrorClass<NativeEdgeError>()("NativeEdgeError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
  thread_id: Schema.optional(Ids.ThreadId),
  active_user_id: Schema.optional(Ids.UserId),
}) {}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/NativeEdge") {}

const noopDiagnostics: Diagnostics.Interface = {
  emit: () => Effect.void,
  redactEntry: (entry) => entry,
  redactFields: (fields) => fields,
}

export const layer = (options: ServeInput = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const threadClient = yield* ThreadClient.Service
      const database = yield* Database.Service
      const eventLog = yield* ThreadEventLog.Service
      const projection = yield* ThreadProjection.Service
      const threadDirectory = yield* ThreadDirectory.Service
      const artifacts = yield* ArtifactStore.Service
      const ideBridge = yield* IdeBridge.Service
      const workspaceAccess = yield* WorkspaceAccess.Service
      const presence = yield* PresenceHub.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      const config = yield* Config.Service
      const diagnostics = Option.getOrUndefined(yield* Effect.serviceOption(Diagnostics.Service))
      const orbChanges = Option.getOrUndefined(yield* Effect.serviceOption(OrbChanges.Service))
      const orbFiles = Option.getOrUndefined(yield* Effect.serviceOption(OrbFiles.Service))
      const orbPty = Option.getOrUndefined(yield* Effect.serviceOption(OrbPty.Service))
      const orbStore = Option.getOrUndefined(yield* Effect.serviceOption(OrbStore.Service))
      const orbManager = Option.getOrUndefined(yield* Effect.serviceOption(OrbManager.Service))
      const projectStore = Option.getOrUndefined(yield* Effect.serviceOption(ProjectStore.Service))
      const token = tokenValue(options.token)
      const layerOrbMode = resolveOrbMode(options)
      const handle = (request: Request) =>
        route({
          threadClient,
          database,
          eventLog,
          projection,
          threadDirectory,
          artifacts,
          ideBridge,
          workspaceAccess,
          presence,
          idGenerator,
          time,
          config,
          diagnostics,
          orbChanges,
          orbFiles,
          orbStore,
          orbManager,
          projectStore,
          orbMode: layerOrbMode,
          request,
          requiredToken: token,
        }).pipe(
          Effect.catchCause((cause: Cause.Cause<NativeEdgeError>) => Effect.succeed(errorResponseFromCause(cause))),
        )

      return Service.of({
        handle: Effect.fn("NativeEdge.handle")(function* (request: Request) {
          return yield* handle(request)
        }),
        serve: Effect.fn("NativeEdge.serve")(function* (input: ServeInput = {}) {
          const resolved = resolveServeInput(options, input)
          const orbMode = yield* orbModeFromResolved(resolved)
          if (!isLoopbackHost(resolved.hostname) && resolved.requiredToken === undefined) {
            return yield* new NativeEdgeError({
              message: "refusing to bind non-loopback host without token",
              operation: "serve",
              status: 400,
            })
          }
          if (
            !isLoopbackHost(resolved.hostname) &&
            userIdFromToken(resolved.requiredToken) === undefined &&
            orbMode === undefined
          ) {
            return yield* new NativeEdgeError({
              message: "refusing to bind non-loopback host without a user-scoped token",
              operation: "serve",
              status: 400,
            })
          }
          const serveHandle = (request: Request) =>
            route({
              threadClient,
              database,
              eventLog,
              projection,
              threadDirectory,
              artifacts,
              ideBridge,
              workspaceAccess,
              presence,
              idGenerator,
              time,
              config,
              diagnostics,
              orbChanges,
              orbFiles,
              orbStore,
              orbManager,
              projectStore,
              orbMode,
              request,
              requiredToken: resolved.requiredToken,
            }).pipe(
              Effect.catchCause((cause: Cause.Cause<NativeEdgeError>) => Effect.succeed(errorResponseFromCause(cause))),
            )
          const server = yield* Effect.try({
            try: () =>
              Bun.serve(
                serveOptions({
                  hostname: resolved.hostname,
                  port: resolved.port,
                  fetch: (request, upgradeServer) => {
                    const upgraded = OrbPtyWs.upgradeOrbPty(
                      orbPty,
                      diagnostics ?? noopDiagnostics,
                      request,
                      upgradeServer,
                      resolved.requiredToken,
                      orbMode,
                    )
                    if (upgraded._tag === "response") return upgraded.response
                    if (upgraded._tag === "upgraded") return undefined
                    return Effect.runPromise(serveHandle(request))
                  },
                  websocket: {
                    ...OrbPtyWs.orbPtyWebSocketHandler,
                    backpressureLimit: 1024 * 1024,
                    closeOnBackpressureLimit: true,
                  },
                }),
              ),
            catch: (cause) =>
              new NativeEdgeError({
                message: cause instanceof Error ? cause.message : String(cause),
                operation: "serve",
                status: 500,
              }),
          })
          return {
            url: `http://${server.hostname}:${server.port}`,
            close: () => Effect.sync(() => server.stop(true)),
          }
        }),
      })
    }),
  )

export const serveOptions = (
  input: Required<Pick<ServeInput, "hostname" | "port">> & {
    readonly fetch: (
      request: Request,
      server: Bun.Server<OrbPtyWs.OrbPtySocketData>,
    ) => Response | undefined | Promise<Response | undefined>
    readonly websocket?: Bun.WebSocketHandler<OrbPtyWs.OrbPtySocketData>
  },
) =>
  ({
    hostname: input.hostname,
    port: input.port,
    idleTimeout: 0,
    fetch: input.fetch,
    websocket: input.websocket ?? OrbPtyWs.orbPtyWebSocketHandler,
  }) satisfies Parameters<typeof Bun.serve<OrbPtyWs.OrbPtySocketData>>[0]

export interface ResolvedServeInput {
  readonly hostname: string
  readonly port: number
  readonly requiredToken?: string
  readonly workspace_root?: string
  readonly orb?: boolean
  readonly base_commit?: string
}

export const resolveServeInput = (layerOptions: ServeInput = {}, input: ServeInput = {}): ResolvedServeInput => {
  const requiredToken = tokenValue(input.token ?? layerOptions.token)
  const workspaceRoot = input.workspace_root ?? layerOptions.workspace_root
  const orb = input.orb ?? layerOptions.orb
  const baseCommit = input.base_commit ?? layerOptions.base_commit
  return {
    hostname: input.hostname ?? layerOptions.hostname ?? "127.0.0.1",
    port: input.port ?? layerOptions.port ?? 0,
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
    ...(orb === undefined ? {} : { orb }),
    ...(baseCommit === undefined ? {} : { base_commit: baseCommit }),
    ...(requiredToken === undefined ? {} : { requiredToken }),
  }
}

const orbModeFromResolved = (input: ResolvedServeInput): Effect.Effect<OrbRouteMode | undefined, NativeEdgeError> => {
  if (input.orb !== true) return Effect.succeed(undefined)
  if (input.workspace_root === undefined || input.base_commit === undefined) {
    return Effect.fail(
      new NativeEdgeError({
        message: "orb server mode requires --workspace and --base-commit",
        operation: "serve",
        status: 400,
      }),
    )
  }
  return Effect.succeed({ workspace_root: input.workspace_root, base_commit: input.base_commit })
}

const resolveOrbMode = (input: ServeInput): OrbRouteMode | undefined =>
  input.orb === true && input.workspace_root !== undefined && input.base_commit !== undefined
    ? { workspace_root: input.workspace_root, base_commit: input.base_commit }
    : undefined

export const handle = Effect.fn("NativeEdge.handle.call")(function* (request: Request) {
  const service = yield* Service
  return yield* service.handle(request)
})

export const serve = Effect.fn("NativeEdge.serve.call")(function* (input: ServeInput = {}) {
  const service = yield* Service
  return yield* service.serve(input)
})

interface RouteInput {
  readonly threadClient: ThreadClient.Interface
  readonly database: Database.Interface
  readonly eventLog: ThreadEventLog.Interface
  readonly projection: ThreadProjection.Interface
  readonly threadDirectory: ThreadDirectory.Interface
  readonly artifacts: ArtifactStore.Interface
  readonly ideBridge: IdeBridge.Interface
  readonly workspaceAccess: WorkspaceAccess.Interface
  readonly presence: PresenceHub.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
  readonly config: Config.Interface
  readonly diagnostics: Diagnostics.Interface | undefined
  readonly orbChanges: OrbChanges.Interface | undefined
  readonly orbFiles: OrbFiles.Interface | undefined
  readonly orbStore: OrbStore.Interface | undefined
  readonly orbManager: OrbManager.Interface | undefined
  readonly projectStore: ProjectStore.Interface | undefined
  readonly orbMode: OrbRouteMode | undefined
  readonly request: Request
  readonly requiredToken: string | undefined
}

interface OrbRouteMode {
  readonly workspace_root: string
  readonly base_commit: string
}

const route = (input: RouteInput): Effect.Effect<Response, NativeEdgeError> =>
  Effect.gen(function* () {
    const url = new URL(input.request.url)
    if (url.pathname === "/health") {
      return isAuthorized(input.request, input.requiredToken)
        ? yield* backendHealth(input.config, serverUrl(url)).pipe(jsonEffect(Remote.BackendHealth))
        : json(Codec.encode(Remote.PublicBackendHealth)({ status: "ok" }))
    }

    const unauthorized = unauthorizedResponse(input.request, input.requiredToken)
    if (unauthorized !== undefined) return unauthorized

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments[0] !== "v1") return notFound()
    if (input.orbMode !== undefined && segments[1] !== "orb") return notFound()

    if (input.request.method === "GET" && segments[1] === "orb" && segments[2] === "changes" && segments.length === 3) {
      return yield* orbChanges(input).pipe(jsonEffect(Remote.OrbChangesResponse))
    }

    if (input.request.method === "GET" && segments[1] === "orb" && segments[2] === "files" && segments.length === 3) {
      return yield* orbFiles(input, url.searchParams.get("path") ?? "").pipe(jsonEffect(Remote.OrbFilesResponse))
    }

    if (input.request.method === "GET" && segments[1] === "orb" && segments[2] === "file" && segments.length === 3) {
      const path = yield* orbFilePath(url)
      return yield* orbFile(input, path).pipe(jsonEffect(Remote.OrbFileResponse))
    }

    if (input.request.method === "POST" && segments[1] === "orbs" && segments.length === 2) {
      const request = yield* decodeBody(input.request, Remote.CreateOrbThreadRequest)
      return yield* createOrbThread(input, request).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (input.request.method === "GET" && segments[1] === "orbs" && segments.length === 2) {
      return yield* listOrbs(input).pipe(jsonEffect(Schema.Array(Remote.OrbSummary)))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "orbs" &&
      segments[2] === "by-thread" &&
      segments[3] !== undefined &&
      segments.length === 4
    ) {
      return yield* getOrbByThread(input, Ids.ThreadId.make(decodeURIComponent(segments[3]))).pipe(
        jsonEffect(Remote.OrbSummary),
      )
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "pause" &&
      segments.length === 4
    ) {
      return yield* pauseOrb(input, Ids.OrbId.make(decodeURIComponent(segments[2]))).pipe(jsonEffect(Remote.OrbSummary))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "resume" &&
      segments.length === 4
    ) {
      return yield* resumeOrb(input, Ids.OrbId.make(decodeURIComponent(segments[2]))).pipe(
        jsonEffect(Remote.OrbSummary),
      )
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "kill" &&
      segments.length === 4
    ) {
      return yield* killOrb(input, Ids.OrbId.make(decodeURIComponent(segments[2]))).pipe(jsonEffect(Remote.OrbSummary))
    }

    if (input.request.method === "GET" && segments[1] === "projects" && segments.length === 2) {
      return yield* listProjects(input).pipe(jsonEffect(Schema.Array(Remote.ProjectSummary)))
    }

    if (input.request.method === "POST" && segments[1] === "projects" && segments.length === 2) {
      const request = yield* decodeBody(input.request, Remote.CreateProjectRequest)
      return yield* createProject(input, request).pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments.length === 3
    ) {
      return yield* getProject(input, Ids.ProjectId.make(decodeURIComponent(segments[2]))).pipe(
        jsonEffect(Remote.ProjectDetail),
      )
    }

    if (
      input.request.method === "PATCH" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Remote.UpdateProjectRequest)
      return yield* updateProject(input, Ids.ProjectId.make(decodeURIComponent(segments[2])), request).pipe(
        jsonEffect(Remote.ProjectDetail),
      )
    }

    if (
      input.request.method === "PUT" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments[3] === "secrets" &&
      segments[4] !== undefined &&
      segments.length === 5
    ) {
      const request = yield* decodeBody(input.request, Remote.SetProjectSecretRequest)
      return yield* setProjectSecret(
        input,
        Ids.ProjectId.make(decodeURIComponent(segments[2])),
        decodeURIComponent(segments[4]),
        request,
      ).pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (
      input.request.method === "DELETE" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments[3] === "secrets" &&
      segments[4] !== undefined &&
      segments.length === 5
    ) {
      return yield* deleteProjectSecret(
        input,
        Ids.ProjectId.make(decodeURIComponent(segments[2])),
        decodeURIComponent(segments[4]),
      ).pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (input.request.method === "POST" && segments[1] === "threads" && segments.length === 2) {
      const request = yield* decodeBody(input.request, Remote.CreateThreadRequest)
      return yield* createThread(input, request).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (input.request.method === "GET" && segments[1] === "threads" && segments.length === 2) {
      return yield* listThreads(input, listThreadsRequest(url)).pipe(jsonEffect(Schema.Array(Remote.ThreadSummary)))
    }

    if (input.request.method === "GET" && segments[1] === "artifacts" && segments.length === 2) {
      const request = yield* listArtifactsRequest(url)
      return yield* listArtifacts(input, request).pipe(jsonEffect(Schema.Array(Artifact.Artifact)))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "artifacts" &&
      segments[2] !== undefined &&
      segments.length === 3
    ) {
      return yield* getArtifact(input, {
        artifact_id: Ids.ArtifactId.make(decodeURIComponent(segments[2])),
        ...userIdField(userIdParam(url)),
      }).pipe(jsonEffect(Artifact.Artifact))
    }

    if (input.request.method === "GET" && segments[1] === "ide" && segments[2] === "status" && segments.length === 3) {
      return yield* ideStatus(input).pipe(jsonEffect(Ide.Status))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "ide" &&
      segments[2] === "connect" &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Ide.ConnectRequest)
      return yield* connectIde(input, request).pipe(jsonEffect(Ide.ConnectResponse))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "ide" &&
      segments[2] === "disconnect" &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Ide.DisconnectRequest)
      return yield* disconnectIde(input, request).pipe(jsonEffect(Ide.Status))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "ide" &&
      segments[2] === "context" &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Ide.UpdateContextRequest)
      return yield* updateIdeContext(input, request).pipe(jsonEffect(Ide.Status))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "ide" &&
      segments[2] === "open-file" &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Ide.OpenFileRequest)
      return yield* openIdeFile(input, request).pipe(jsonEffect(Ide.OpenFileResult))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "ide" &&
      segments[2] === "navigation-requests" &&
      segments.length === 3
    ) {
      return yield* ideNavigationRequests(input).pipe(jsonEffect(Schema.Array(Ide.OpenFileRequest)))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] === "search" &&
      segments.length === 3
    ) {
      return yield* searchThreads(input, searchThreadsRequest(url)).pipe(
        jsonEffect(Schema.Array(Remote.ThreadSearchResult)),
      )
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments.length === 3
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "openThread", threadId)
      return yield* threadRecord(input, threadId, identity, "openThread").pipe(jsonEffect(Remote.ThreadRecord))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "preview" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "previewThread", threadId)
      return yield* threadRecord(input, threadId, identity, "previewThread", previewLimit(url)).pipe(
        jsonEffect(Remote.ThreadRecord),
      )
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "share" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "shareThread", threadId)
      return yield* shareThread(input, threadId, identity).pipe(jsonEffect(Remote.ThreadExport))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "reference" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "referenceThread", threadId)
      return yield* referenceThread(
        input,
        threadId,
        identity,
        url.searchParams.get("query") ?? undefined,
        intParam(url, "max_chars"),
      ).pipe(jsonEffect(Remote.ThreadReference))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "compact" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "compactThread", threadId)
      return yield* compactThread(input, threadId, identity).pipe(jsonEffect(Event.ContextCompacted))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "fork" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const request = yield* decodeBody(input.request, Remote.ForkThreadRequest)
      if (request.thread_id !== threadId) {
        return yield* new NativeEdgeError({
          message: `Fork request thread_id ${request.thread_id} does not match path thread ${threadId}`,
          operation: "forkThread",
          status: 400,
          thread_id: threadId,
        })
      }
      const identity = yield* identityForRequest(input, request.user_id, "forkThread", threadId)
      return yield* forkThread(input, request, identity).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "visibility" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const body = yield* decodeBody(input.request, Remote.SetThreadVisibilityBody)
      return yield* setThreadVisibility(input, threadId, body.visibility, userIdParam(url)).pipe(
        jsonEffect(Remote.ThreadSummary),
      )
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "archive" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      return yield* setThreadArchived(input, threadId, true, userIdParam(url)).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "unarchive" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      return yield* setThreadArchived(input, threadId, false, userIdParam(url)).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      input.request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "events" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const identity = yield* identityForRequest(input, userIdParam(url), "subscribeThreadEvents", threadId)
      return yield* threadEventStream(input, {
        thread_id: threadId,
        ...userIdField(identity?.user_id),
        ...afterSequenceField(intParam(url, "after_sequence")),
      })
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "presence" &&
      segments.length === 4
    ) {
      const threadId = Ids.ThreadId.make(decodeURIComponent(segments[2]))
      const request = yield* decodeBody(input.request, Remote.PresenceRequest)
      return yield* setThreadPresence(input, threadId, request).pipe(jsonEffect(Remote.PresenceFrame))
    }

    if (input.request.method === "POST" && segments[1] === "turns" && segments.length === 2) {
      const request = yield* decodeBody(input.request, Remote.StartTurnRequest)
      return yield* startTurn(input, request).pipe(jsonEffect(Remote.StartTurnResponse))
    }

    if (
      input.request.method === "POST" &&
      segments[1] === "turns" &&
      segments[2] === "interrupt" &&
      segments.length === 3
    ) {
      const request = yield* decodeBody(input.request, Remote.InterruptTurnRequest)
      return yield* interruptTurn(input, request).pipe(jsonEffect(Event.TurnTerminal))
    }

    return notFound()
  })

const orbChanges = (input: RouteInput): Effect.Effect<Remote.OrbChangesResponse, NativeEdgeError> =>
  Effect.gen(function* () {
    const orbMode = yield* requireOrbMode(input, "orbChanges")
    const service = yield* requireOrbChanges(input)
    return yield* service
      .changes({ workspace_root: orbMode.workspace_root, base_commit: orbMode.base_commit })
      .pipe(Effect.mapError((error) => edgeError(error, "orbChanges")))
  })

const orbFiles = (input: RouteInput, path: string): Effect.Effect<Remote.OrbFilesResponse, NativeEdgeError> =>
  Effect.gen(function* () {
    const orbMode = yield* requireOrbMode(input, "orbFiles")
    const service = yield* requireOrbFiles(input)
    return yield* service
      .list({ workspace_root: orbMode.workspace_root, path })
      .pipe(Effect.mapError((error) => orbFilesError(error)))
  })

const orbFile = (input: RouteInput, path: string): Effect.Effect<Remote.OrbFileResponse, NativeEdgeError> =>
  Effect.gen(function* () {
    const orbMode = yield* requireOrbMode(input, "orbFile")
    const service = yield* requireOrbFiles(input)
    return yield* service
      .read({ workspace_root: orbMode.workspace_root, path })
      .pipe(Effect.mapError((error) => orbFilesError(error)))
  })

const requireOrbMode = (input: RouteInput, operation: string): Effect.Effect<OrbRouteMode, NativeEdgeError> =>
  input.orbMode === undefined
    ? Effect.fail(new NativeEdgeError({ message: "Not found", operation, status: 404 }))
    : Effect.succeed(input.orbMode)

const requireOrbChanges = (input: RouteInput): Effect.Effect<OrbChanges.Interface, NativeEdgeError> =>
  input.orbChanges === undefined
    ? Effect.fail(
        new NativeEdgeError({
          message: "Orb changes service is unavailable",
          operation: "orbChanges",
          status: 500,
        }),
      )
    : Effect.succeed(input.orbChanges)

const requireOrbFiles = (input: RouteInput): Effect.Effect<OrbFiles.Interface, NativeEdgeError> =>
  input.orbFiles === undefined
    ? Effect.fail(
        new NativeEdgeError({
          message: "Orb files service is unavailable",
          operation: "orbFiles",
          status: 500,
        }),
      )
    : Effect.succeed(input.orbFiles)

const orbFilePath = (url: URL): Effect.Effect<string, NativeEdgeError> => {
  const path = url.searchParams.get("path")
  if (path !== null && path.length > 0) return Effect.succeed(path)
  return Effect.fail(
    new NativeEdgeError({
      message: "path query parameter is required",
      operation: "orbFile",
      status: 400,
    }),
  )
}

const orbFilesError = (error: OrbFiles.OrbFilesError) =>
  new NativeEdgeError({
    message: error.message,
    operation: error.operation,
    status:
      error.kind === "invalid_path" || error.kind === "not_file" || error.kind === "not_directory"
        ? 400
        : error.kind === "not_found"
          ? 404
          : 500,
  })

const createOrbThread = (
  input: RouteInput,
  request: Remote.CreateOrbThreadRequest,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const manager = yield* requireOrbManager(input, "createOrbThread")
    const values = yield* input.config.get
    const threadId = request.thread_id ?? Ids.ThreadId.make(yield* input.idGenerator.next("thread"))
    const workspaceId = WorkspaceIdentity.resolveWorkspaceId({
      workspace_root: values.workspace_root,
      project_id: request.project_id,
    })
    const identity = yield* identityForRequest(input, undefined, "createOrbThread", threadId)
    if (identity !== undefined) {
      yield* input.workspaceAccess
        .ensureWorkspaceForCreate({
          workspace_id: workspaceId,
          user_id: identity.user_id,
          action: "write",
        })
        .pipe(Effect.mapError((error) => edgeError(error, "createOrbThread", threadId)))
    }
    if (request.thread_id !== undefined) {
      yield* validateOrbThreadWorkspace(input, threadId, workspaceId, "createOrbThread")
    }
    const orb = yield* manager
      .provisionForThread({
        thread_id: threadId,
        project_id: request.project_id,
        workspace_root: values.workspace_root,
      })
      .pipe(Effect.mapError((error) => edgeError(error, "createOrbThread", threadId)))
    yield* ensureProjectedOrbThread(input, manager, orb, workspaceId, identity)
    return {
      thread_id: threadId,
      workspace_id: workspaceId,
      diff: { additions: 0, modifications: 0, deletions: 0 },
      orb_status: orb.status,
      archived: false,
      visibility: "private",
      created_at: orb.created_at,
      updated_at: orb.last_active_at,
    }
  })

const ensureProjectedOrbThread = (
  input: RouteInput,
  manager: OrbManager.Interface,
  orb: Orb.OrbRecord,
  workspaceId: Ids.WorkspaceId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
): Effect.Effect<void, NativeEdgeError> =>
  input.threadClient
    .ensureThread({
      thread_id: orb.thread_id,
      workspace_id: workspaceId,
      ...identityField(identity),
    })
    .pipe(
      Effect.mapError((error) => edgeError(error, "createOrbThread", orb.thread_id)),
      Effect.andThen(projectThreadEvents(input, orb.thread_id, "createOrbThread")),
      Effect.catch((error) =>
        manager.forceKill(orb.orb_id).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    )

const validateOrbThreadWorkspace = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  workspaceId: Ids.WorkspaceId,
  operation: string,
): Effect.Effect<void, NativeEdgeError> =>
  Effect.gen(function* () {
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    if (events.length === 0) return
    const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    if (created?.data.workspace_id === workspaceId) return
    yield* Effect.fail(
      new NativeEdgeError({
        message: `Thread ${threadId} already belongs to another workspace`,
        operation,
        status: 409,
        thread_id: threadId,
      }),
    )
  })

const listOrbs = (input: RouteInput): Effect.Effect<ReadonlyArray<Remote.OrbSummary>, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireOrbStore(input, "listOrbs")
    const records = yield* store.list().pipe(Effect.mapError((error) => edgeError(error, "listOrbs")))
    return yield* Effect.forEach(records, (record) => toOrbSummary(store, record))
  })

const getOrbByThread = (input: RouteInput, threadId: Ids.ThreadId): Effect.Effect<Remote.OrbSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireOrbStore(input, "getOrbByThread")
    const record = yield* store
      .getByThread(threadId)
      .pipe(Effect.mapError((error) => edgeError(error, "getOrbByThread")))
    if (record === undefined) return yield* orbNotFound({ thread_id: threadId }, "getOrbByThread")
    return yield* toOrbSummary(store, record)
  })

const pauseOrb = (input: RouteInput, orbId: Ids.OrbId): Effect.Effect<Remote.OrbSummary, NativeEdgeError> =>
  lifecycleOrb(input, orbId, "pauseOrb", (manager) => manager.pause(orbId))

const resumeOrb = (input: RouteInput, orbId: Ids.OrbId): Effect.Effect<Remote.OrbSummary, NativeEdgeError> =>
  lifecycleOrb(input, orbId, "resumeOrb", (manager) => manager.resume(orbId))

const killOrb = (input: RouteInput, orbId: Ids.OrbId): Effect.Effect<Remote.OrbSummary, NativeEdgeError> =>
  lifecycleOrb(input, orbId, "killOrb", (manager) => manager.kill(orbId))

const lifecycleOrb = (
  input: RouteInput,
  orbId: Ids.OrbId,
  operation: string,
  run: (manager: OrbManager.Interface) => Effect.Effect<Orb.OrbRecord, OrbManager.OrbProvisionError>,
): Effect.Effect<Remote.OrbSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireOrbStore(input, operation)
    const manager = yield* requireOrbManager(input, operation)
    const record = yield* run(manager).pipe(Effect.mapError((error) => edgeError(error, operation)))
    return yield* toOrbSummary(store, record)
  })

const toOrbSummary = Effect.fn("NativeEdge.toOrbSummary")(function* (store: OrbStore.Interface, orb: Orb.OrbRecord) {
  const usage = yield* store
    .usage({ orb_id: orb.orb_id })
    .pipe(Effect.mapError((error) => edgeError(error, "orbUsage")))
  return {
    orb_id: orb.orb_id,
    thread_id: orb.thread_id,
    project_id: orb.project_id,
    status: orb.status,
    base_commit: orb.base_commit,
    created_at: orb.created_at,
    last_active_at: orb.last_active_at,
    running_minutes: usage[0]?.total_running_minutes ?? 0,
  } satisfies Remote.OrbSummary
})

const requireOrbStore = (input: RouteInput, operation: string): Effect.Effect<OrbStore.Interface, NativeEdgeError> =>
  input.orbStore === undefined
    ? Effect.fail(new NativeEdgeError({ message: "Orb store is not configured", operation, status: 501 }))
    : Effect.succeed(input.orbStore)

const requireOrbManager = (
  input: RouteInput,
  operation: string,
): Effect.Effect<OrbManager.Interface, NativeEdgeError> =>
  input.orbManager === undefined
    ? Effect.fail(new NativeEdgeError({ message: "Orb manager is not configured", operation, status: 501 }))
    : Effect.succeed(input.orbManager)

const orbNotFound = (input: { readonly orb_id?: Ids.OrbId; readonly thread_id?: Ids.ThreadId }, operation: string) =>
  new NativeEdgeError({
    message:
      input.orb_id === undefined
        ? `Orb for thread ${input.thread_id} was not found`
        : `Orb ${input.orb_id} was not found`,
    operation,
    status: 404,
  })

const listProjects = (input: RouteInput): Effect.Effect<ReadonlyArray<Remote.ProjectSummary>, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "listProjects")
    const projects = yield* store.list().pipe(Effect.mapError((error) => edgeError(error, "listProjects")))
    return projects.map(toProjectSummary)
  })

const createProject = (
  input: RouteInput,
  request: Remote.CreateProjectRequest,
): Effect.Effect<Remote.ProjectDetail, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "createProject")
    const project = yield* store
      .create({
        name: request.name,
        repo_origin: publicRepoOrigin(request.repo_origin),
        ...(request.default_branch === undefined ? {} : { default_branch: request.default_branch }),
        ...(request.template_id === undefined ? {} : { template_id: request.template_id }),
        ...(request.env === undefined ? {} : { env: request.env }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "createProject")))
    return toProjectDetail(project)
  })

const getProject = (
  input: RouteInput,
  projectId: Ids.ProjectId,
): Effect.Effect<Remote.ProjectDetail, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "getProject")
    const project = yield* store.get(projectId).pipe(Effect.mapError((error) => edgeError(error, "getProject")))
    if (project === undefined) return yield* projectNotFound(projectId, "getProject")
    return toProjectDetail(project)
  })

const updateProject = (
  input: RouteInput,
  projectId: Ids.ProjectId,
  request: Remote.UpdateProjectRequest,
): Effect.Effect<Remote.ProjectDetail, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "updateProject")
    const project = yield* store
      .update(projectId, {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.repo_origin === undefined ? {} : { repo_origin: publicRepoOrigin(request.repo_origin) }),
        ...(request.default_branch === undefined ? {} : { default_branch: request.default_branch }),
        ...(request.template_id === undefined ? {} : { template_id: request.template_id }),
        ...(request.env === undefined ? {} : { env: request.env }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "updateProject")))
    return toProjectDetail(project)
  })

const setProjectSecret = (
  input: RouteInput,
  projectId: Ids.ProjectId,
  name: string,
  request: Remote.SetProjectSecretRequest,
): Effect.Effect<Remote.ProjectDetail, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "setProjectSecret")
    const project = yield* store
      .setSecret(projectId, name, request.value)
      .pipe(Effect.mapError((error) => edgeError(error, "setProjectSecret")))
    return toProjectDetail(project)
  })

const deleteProjectSecret = (
  input: RouteInput,
  projectId: Ids.ProjectId,
  name: string,
): Effect.Effect<Remote.ProjectDetail, NativeEdgeError> =>
  Effect.gen(function* () {
    const store = yield* requireProjectStore(input, "deleteProjectSecret")
    const project = yield* store
      .unsetSecret(projectId, name)
      .pipe(Effect.mapError((error) => edgeError(error, "deleteProjectSecret")))
    return toProjectDetail(project)
  })

const requireProjectStore = (
  input: RouteInput,
  operation: string,
): Effect.Effect<ProjectStore.Interface, NativeEdgeError> =>
  input.projectStore === undefined
    ? Effect.fail(new NativeEdgeError({ message: "Project store is not configured", operation, status: 501 }))
    : Effect.succeed(input.projectStore)

const toProjectSummary = (project: Orb.ProjectRecord): Remote.ProjectSummary => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: publicRepoOrigin(project.repo_origin),
  default_branch: project.default_branch,
  template_id: project.template_id,
  env_keys: Object.keys(project.env).toSorted(),
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const toProjectDetail = (project: Orb.ProjectRecord): Remote.ProjectDetail => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: publicRepoOrigin(project.repo_origin),
  default_branch: project.default_branch,
  template_id: project.template_id,
  env: project.env,
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const publicRepoOrigin = (repoOrigin: string): string => {
  try {
    const url = new URL(repoOrigin)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return repoOrigin
  }
}

const projectNotFound = (projectId: Ids.ProjectId, operation: string) =>
  new NativeEdgeError({
    message: `Project ${projectId} was not found`,
    operation,
    status: 404,
  })

const backendHealth = (config: Config.Interface, url: string): Effect.Effect<Remote.BackendHealth> =>
  Effect.gen(function* () {
    const values = yield* config.get
    return {
      status: "healthy",
      url,
      workspace_root: values.workspace_root,
      data_dir: values.data_dir,
      backend_id: values.backend_id ?? "native-rivet-edge",
      pid: process.pid,
      version: "0.0.0",
    }
  })

const createThread = (
  input: RouteInput,
  request: Remote.CreateThreadRequest,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const values = yield* input.config.get
    const threadId = request.thread_id ?? Ids.ThreadId.make(yield* input.idGenerator.next("thread"))
    const workspaceId =
      request.workspace_id ??
      WorkspaceIdentity.resolveWorkspaceId({
        workspace_root: values.workspace_root,
        ...(request.project_id === undefined ? {} : { project_id: request.project_id }),
      })
    yield* input.threadClient
      .ensureThread({
        thread_id: threadId,
        workspace_id: workspaceId,
        ...(yield* identityFieldForRequest(input, request.user_id, "createThread", threadId)),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "createThread", threadId)))
    yield* projectThreadEvents(input, threadId, "createThread")
    return yield* actorSummary(input, threadId, "createThread")
  })

const listThreads = (
  input: RouteInput,
  request: Remote.ListThreadsRequest,
): Effect.Effect<ReadonlyArray<Remote.ThreadSummary>, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, request.user_id, "listThreads")
    const summaries = yield* discoverySummaries(input, "listThreads")
    const candidates = summaries
      .filter((summary) => request.workspace_id === undefined || summary.workspace_id === request.workspace_id)
      .filter((summary) => identity !== undefined || request.include_archived === true || !summary.archived)
    if (identity === undefined) {
      return yield* Effect.forEach(candidates.slice(0, listLimit(request.limit)), (summary) =>
        enrichSummaryWithOrbStatus(input, projectionSummaryToRemote(summary), "listThreads"),
      )
    }
    const records = yield* actorBackedRecords(input, candidates, identity, "listThreads")
    return records
      .map((record) => record.summary)
      .filter((summary) => request.workspace_id === undefined || summary.workspace_id === request.workspace_id)
      .filter((summary) => request.include_archived === true || !summary.archived)
      .toSorted(compareThreadSummaries)
      .slice(0, listLimit(request.limit))
  })

const searchThreads = (
  input: RouteInput,
  request: Remote.SearchThreadsRequest,
): Effect.Effect<ReadonlyArray<Remote.ThreadSearchResult>, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, request.user_id, "searchThreads")
    const parsed = ThreadSearchQuery.parseThreadSearchQuery(request.query ?? "")
    const projectWorkspaceId = yield* projectWorkspaceIdForSearch(input, parsed.project)
    if (parsed.project !== undefined && projectWorkspaceId === undefined) return []
    if (
      request.workspace_id !== undefined &&
      projectWorkspaceId !== undefined &&
      request.workspace_id !== projectWorkspaceId
    ) {
      return []
    }
    const workspaceId = projectWorkspaceId ?? request.workspace_id
    const after = yield* resolvedSearchBound(input, "after", request.after, parsed.after)
    const before = yield* resolvedSearchBound(input, "before", request.before, parsed.before)
    const fileThreadIds =
      identity === undefined ? yield* searchFileThreadIds(input, parsed.file_globs) : new Set<Ids.ThreadId>()
    const summaries = yield* discoverySummaries(input, "searchThreads")
    const includeArchived = parsed.archived === true ? true : request.include_archived
    const candidates =
      identity === undefined
        ? projectedSearchCandidates(summaries, {
            includeArchived,
            archived: parsed.archived,
            workspaceId,
            fileGlobs: parsed.file_globs,
            fileThreadIds,
            after,
            before,
          })
        : summaries.filter((summary) => workspaceId === undefined || summary.workspace_id === workspaceId)
    const records = yield* actorBackedRecords(input, candidates, identity, "searchThreads")
    const filteredRecords = records
      .filter((record) => includeArchived === true || !record.summary.archived)
      .filter((record) => parsed.archived === undefined || record.summary.archived === parsed.archived)
      .filter((record) => workspaceId === undefined || record.summary.workspace_id === workspaceId)
      .filter((record) => actorRecordMatchesFileGlobs(record, parsed.file_globs))
      .filter((record) => after === undefined || record.summary.updated_at >= after)
      .filter((record) => before === undefined || record.summary.updated_at <= before)
    const scored = filteredRecords.map((record) => scoreSearchResult(record.summary, record.events, parsed.terms))
    return scored
      .filter((result) => parsed.terms.length === 0 || result.score > 0)
      .toSorted((left, right) => right.score - left.score || right.summary.updated_at - left.summary.updated_at)
      .slice(0, searchLimit(request.limit))
  })

const threadRecord = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  operation: string,
  limit?: number,
): Effect.Effect<Remote.ThreadRecord, NativeEdgeError> =>
  Effect.gen(function* () {
    yield* input.threadClient
      .replayThread({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    if (events.length === 0) {
      return yield* new NativeEdgeError({
        message: `Thread ${threadId} was not found`,
        operation,
        status: 404,
        thread_id: threadId,
      })
    }
    yield* observeThreadEvents(input, events, operation, threadId)
    const summary = yield* actorSummaryFromEvents(input, threadId, events, operation)
    return { summary, events: limit === undefined ? events : events.slice(-limit) }
  })

const shareThread = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
): Effect.Effect<Remote.ThreadExport, NativeEdgeError> =>
  Effect.gen(function* () {
    const record = yield* threadRecord(input, threadId, identity, "shareThread")
    const exportedAt = yield* input.time.nowMillis
    return {
      schema_version: 1,
      exported_at: exportedAt,
      thread_id: threadId,
      summary: record.summary,
      events: record.events,
    }
  })

const referenceThread = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  query: string | undefined,
  maxChars: number | undefined,
): Effect.Effect<Remote.ThreadReference, NativeEdgeError> =>
  Effect.gen(function* () {
    const record = yield* threadRecord(input, threadId, identity, "referenceThread")
    const charLimit = clamp(maxChars ?? 2_000, 400, 10_000)
    const entries = referenceEntries(record, ThreadSearchQuery.parseThreadSearchQuery(query ?? "").terms)
    const rendered = capText(entries.join("\n"), charLimit)
    return {
      thread_id: threadId,
      rendered: rendered.text,
      entries,
      total_chars: rendered.text.length,
      truncated: rendered.truncated,
    }
  })

const referenceEntries = (record: ActorBackedRecord, terms: ReadonlyArray<string>) => {
  const messages = record.events.flatMap(ThreadDigest.messageEntry)
  const relevant =
    terms.length === 0 ? messages : messages.filter((message) => terms.some((term) => includesTerm(message, term)))
  return uniqueNonEmpty([
    `Thread ${record.summary.thread_id}`,
    `Workspace: ${record.summary.workspace_id}`,
    `Visibility: ${record.summary.visibility}`,
    `Archived: ${record.summary.archived}`,
    ...(record.summary.latest_message_text === undefined
      ? []
      : [`Latest: ${oneLine(record.summary.latest_message_text)}`]),
    ...firstAndLast(relevant.length === 0 ? messages : relevant, 6),
    ...ThreadDigest.toolEntries(record.events).slice(-4),
    ...ThreadDigest.fileEntries(record.events)
      .slice(0, 8)
      .map((path) => `File: ${path}`),
  ])
}

const compactThread = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
): Effect.Effect<Event.ContextCompacted, NativeEdgeError> =>
  Effect.gen(function* () {
    const event = yield* input.threadClient
      .compactThread({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "compactThread", threadId)))
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "compactThread", threadId)))
    yield* mirrorObservedEvents(input, events, "compactThread", threadId)
    return event
  })

const forkThread = (
  input: RouteInput,
  request: Remote.ForkThreadRequest,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const forkThreadId = Ids.ThreadId.make(yield* input.idGenerator.next("thread"))
    const forkIdentity = identity ?? localNativeEdgeIdentity()
    yield* input.threadClient
      .forkThread({
        thread_id: request.thread_id,
        fork_thread_id: forkThreadId,
        ...identityField(identity),
        import_identity: forkIdentity,
        ...userIdField(forkIdentity.user_id),
        ...(request.at_turn === undefined ? {} : { at_turn: request.at_turn }),
        ...(request.title_text === undefined ? {} : { title_text: request.title_text }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "forkThread", request.thread_id)))
    const events = yield* input.threadClient
      .getEvents({ thread_id: forkThreadId, ...identityField(forkIdentity) })
      .pipe(Effect.mapError((error) => edgeError(error, "forkThread", forkThreadId)))
    yield* mirrorObservedEvents(input, events, "forkThread", forkThreadId)
    return yield* summaryFromEvents(forkThreadId, events, "forkThread")
  })

const setThreadVisibility = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  visibility: Event.ThreadVisibility,
  requestedUserId: Ids.UserId | undefined,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, requestedUserId, "setThreadVisibility", threadId)
    yield* input.threadClient
      .setVisibility({ thread_id: threadId, ...identityField(identity), visibility })
      .pipe(Effect.mapError((error) => edgeError(error, "setThreadVisibility", threadId)))
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "setThreadVisibility", threadId)))
    yield* mirrorObservedEvents(input, events, "setThreadVisibility", threadId)
    return yield* summaryFromEvents(threadId, events, "setThreadVisibility")
  })

const setThreadArchived = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  archived: boolean,
  requestedUserId: Ids.UserId | undefined,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const operation = archived ? "archiveThread" : "unarchiveThread"
    const identity = yield* identityForRequest(input, requestedUserId, operation, threadId)
    const payload = { thread_id: threadId, ...identityField(identity) }
    yield* (archived ? input.threadClient.archiveThread(payload) : input.threadClient.unarchiveThread(payload)).pipe(
      Effect.mapError((error) => edgeError(error, operation, threadId)),
    )
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    yield* mirrorObservedEvents(input, events, operation, threadId)
    return yield* summaryFromEvents(threadId, events, operation)
  })

const threadEventStream = (
  input: RouteInput,
  request: Remote.SubscribeThreadEventsRequest,
): Effect.Effect<Response, NativeEdgeError> =>
  Effect.gen(function* () {
    yield* input.threadClient
      .replayThread({ thread_id: request.thread_id, ...identityFieldFromRequestUserId(input, request.user_id) })
      .pipe(Effect.mapError((error) => edgeError(error, "subscribeThreadEvents", request.thread_id)))
    yield* actorSummary(input, request.thread_id, "subscribeThreadEvents")
    return ndjson(
      Stream.merge(
        tailThreadEvents(input, {
          thread_id: request.thread_id,
          ...identityFieldFromRequestUserId(input, request.user_id),
          ...afterSequenceField(request.after_sequence),
        }),
        threadPresenceStream(input, request),
        { haltStrategy: "both" },
      ),
    )
  })

const threadPresenceStream = (
  input: RouteInput,
  request: Remote.SubscribeThreadEventsRequest,
): Stream.Stream<Remote.PresenceFrame, NativeEdgeError> => {
  const identity = identityFieldFromRequestUserId(input, request.user_id).identity
  if (identity === undefined) return input.presence.subscribe(request.thread_id)
  return input.presence.subscribe(request.thread_id).pipe(
    Stream.mapEffect((frame) =>
      input.threadClient.getEvents({ thread_id: request.thread_id, identity }).pipe(
        Effect.as(frame),
        Effect.mapError((error) => edgeError(error, "subscribeThreadPresence", request.thread_id)),
      ),
    ),
  )
}

const setThreadPresence = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  request: Remote.PresenceRequest,
): Effect.Effect<Remote.PresenceFrame, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, request.user_id, "setThreadPresence", threadId)
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "setThreadPresence", threadId)))
    yield* summaryFromEvents(threadId, events, "setThreadPresence")
    return yield* input.presence
      .heartbeat({
        thread_id: threadId,
        user_id: identity?.user_id ?? request.user_id,
        state: request.state,
      })
      .pipe(Effect.mapError((error) => edgeError(error, "setThreadPresence", threadId)))
  })

const listArtifacts = (
  input: RouteInput,
  request: Remote.ListArtifactsRequest,
): Effect.Effect<ReadonlyArray<Artifact.Artifact>, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, request.user_id, "listArtifacts", request.thread_id)
    const events = yield* input.threadClient
      .getEvents({ thread_id: request.thread_id, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "listArtifacts", request.thread_id)))
    yield* summaryFromEvents(request.thread_id, events, "listArtifacts")
    return yield* input.artifacts
      .list({
        thread_id: request.thread_id,
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "listArtifacts", request.thread_id)))
  })

const getArtifact = (
  input: RouteInput,
  request: Remote.GetArtifactRequest,
): Effect.Effect<Artifact.Artifact, NativeEdgeError> =>
  Effect.gen(function* () {
    const artifact = yield* input.artifacts
      .get(request.artifact_id)
      .pipe(Effect.mapError((error) => edgeError(error, "getArtifact")))
    if (Option.isNone(artifact)) {
      return yield* new NativeEdgeError({
        message: `Artifact ${request.artifact_id} was not found`,
        operation: "getArtifact",
        status: 404,
      })
    }
    const identity = yield* identityForRequest(input, request.user_id, "getArtifact", artifact.value.thread_id)
    const events = yield* input.threadClient
      .getEvents({ thread_id: artifact.value.thread_id, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "getArtifact", artifact.value.thread_id)))
    yield* summaryFromEvents(artifact.value.thread_id, events, "getArtifact")
    return artifact.value
  })

const connectIde = (
  input: RouteInput,
  request: Ide.ConnectRequest,
): Effect.Effect<Ide.ConnectResponse, NativeEdgeError> =>
  input.ideBridge.connect(request).pipe(Effect.mapError((error) => edgeError(error, "connectIde")))

const disconnectIde = (input: RouteInput, request: Ide.DisconnectRequest): Effect.Effect<Ide.Status, NativeEdgeError> =>
  input.ideBridge.disconnect(request).pipe(Effect.mapError((error) => edgeError(error, "disconnectIde")))

const updateIdeContext = (
  input: RouteInput,
  request: Ide.UpdateContextRequest,
): Effect.Effect<Ide.Status, NativeEdgeError> =>
  input.ideBridge.updateContext(request).pipe(Effect.mapError((error) => edgeError(error, "updateIdeContext")))

const ideStatus = (input: RouteInput): Effect.Effect<Ide.Status, NativeEdgeError> => input.ideBridge.status()

const openIdeFile = (
  input: RouteInput,
  request: Ide.OpenFileRequest,
): Effect.Effect<Ide.OpenFileResult, NativeEdgeError> => input.ideBridge.openFile(request)

const ideNavigationRequests = (input: RouteInput): Effect.Effect<ReadonlyArray<Ide.OpenFileRequest>, NativeEdgeError> =>
  input.ideBridge.navigationRequests()

interface TailState {
  readonly thread_id: Ids.ThreadId
  readonly identity?: ThreadActor.VerifiedUserIdentity
  readonly after_sequence?: number
}

const tailThreadEvents = (input: RouteInput, state: TailState): Stream.Stream<Event.Event, NativeEdgeError> =>
  input.threadClient
    .subscribeEvents(state)
    .pipe(Stream.mapError((error) => edgeError(error, "subscribeThreadEvents", state.thread_id)))

const startTurn = (
  input: RouteInput,
  request: Remote.StartTurnRequest,
): Effect.Effect<Remote.StartTurnResponse, NativeEdgeError> =>
  Effect.gen(function* () {
    const values = yield* input.config.get
    const identity = yield* identityForRequest(input, request.user_id, "startTurn", request.thread_id)
    const existingEvents = yield* input.threadClient
      .getEvents({ thread_id: request.thread_id, ...identityField(identity) })
      .pipe(Effect.mapError((error) => edgeError(error, "startTurn", request.thread_id)))
    const existingSummary =
      existingEvents.length === 0 ? undefined : yield* summaryFromEvents(request.thread_id, existingEvents, "startTurn")
    if (existingEvents.length > 0) {
      yield* observeThreadEvents(input, existingEvents, "startTurn", request.thread_id)
    }
    const workspaceId =
      existingSummary?.workspace_id ??
      request.workspace_id ??
      WorkspaceIdentity.resolveWorkspaceId({
        workspace_root: values.workspace_root,
        ...(request.project_id === undefined ? {} : { project_id: request.project_id }),
      })
    const currentIdeContext =
      request.ide_context === undefined
        ? Option.getOrUndefined(yield* input.ideBridge.currentContext())
        : request.ide_context
    const afterSequence = existingEvents.at(-1)?.sequence ?? 0
    const response = yield* input.threadClient
      .startTurn({
        thread_id: request.thread_id,
        workspace_id: workspaceId,
        ...identityField(identity),
        content: request.content,
        ...(request.content_parts === undefined ? {} : { content_parts: request.content_parts }),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.fast_mode === undefined ? {} : { fast_mode: request.fast_mode }),
        ...(request.cancelled === undefined ? {} : { cancelled: request.cancelled }),
        ...(currentIdeContext === undefined ? {} : { ide_context: currentIdeContext }),
        ...(request.tool_access === undefined ? {} : { tool_access: request.tool_access }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "startTurn", request.thread_id)))
    const page = yield* mirrorThreadEventPage(
      input,
      request.thread_id,
      identity,
      afterSequence,
      undefined,
      "startTurn",
    ).pipe(
      Effect.catchCause((cause) =>
        logMirrorFailure(input, request.thread_id, "startTurn", cause).pipe(
          Effect.as(mirroredPageFallback(afterSequence)),
        ),
      ),
    )
    if (!page.terminal) {
      yield* mirrorThreadUntilTerminal(
        input,
        request.thread_id,
        identity,
        page.after_sequence,
        page.target_turn_id,
        "startTurn",
      ).pipe(
        Effect.catchCause((cause) => logMirrorFailure(input, request.thread_id, "startTurn", cause)),
        Effect.forkDetach,
        Effect.asVoid,
      )
    }
    return response
  })

const interruptTurn = (
  input: RouteInput,
  request: Remote.InterruptTurnRequest,
): Effect.Effect<Event.TurnTerminal, NativeEdgeError> =>
  Effect.gen(function* () {
    const identity = yield* identityForRequest(input, request.user_id, "interruptTurn", request.thread_id)
    const terminal = yield* input.threadClient
      .interruptTurn({
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        ...identityField(identity),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      })
      .pipe(Effect.mapError((error) => edgeError(error, "interruptTurn", request.thread_id)))
    yield* projectThreadEvents(input, request.thread_id, "interruptTurn")
    return terminal
  })

interface MirroredPage {
  readonly after_sequence: number
  readonly target_turn_id?: Ids.TurnId
  readonly terminal: boolean
}

const mirroredPageFallback = (afterSequence: number): MirroredPage => ({
  after_sequence: afterSequence,
  terminal: false,
})

const mirrorThreadUntilTerminal = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  afterSequence: number,
  targetTurnId: Ids.TurnId | undefined,
  operation: string,
): Effect.Effect<void, NativeEdgeError> =>
  Effect.gen(function* () {
    let nextAfterSequence = afterSequence
    let nextTargetTurnId = targetTurnId
    let terminal = false
    while (!terminal) {
      const page = yield* mirrorThreadEventPage(
        input,
        threadId,
        identity,
        nextAfterSequence,
        nextTargetTurnId,
        operation,
      )
      nextAfterSequence = page.after_sequence
      nextTargetTurnId = page.target_turn_id
      terminal = page.terminal
      if (!terminal) yield* Effect.sleep("25 millis")
    }
  })

const mirrorThreadEventPage = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  afterSequence: number,
  targetTurnId: Ids.TurnId | undefined,
  operation: string,
): Effect.Effect<MirroredPage, NativeEdgeError> =>
  Effect.gen(function* () {
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId, ...identityField(identity), after_sequence: afterSequence })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    yield* mirrorObservedEvents(input, events, operation, threadId)
    const latest = events.at(-1)
    const nextTargetTurnId = targetTurnId ?? events.find(isTurnStarted)?.turn_id
    return {
      after_sequence: latest?.sequence ?? afterSequence,
      ...(nextTargetTurnId === undefined ? {} : { target_turn_id: nextTargetTurnId }),
      terminal:
        nextTargetTurnId !== undefined && events.some((event) => isTerminalTurnEventFor(event, nextTargetTurnId)),
    }
  })

const logMirrorFailure = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  operation: string,
  cause: Cause.Cause<NativeEdgeError>,
): Effect.Effect<void> => {
  if (input.diagnostics === undefined) return Effect.void
  return Diagnostics.event("native_edge.mirror_events", () => Effect.failCause(cause), {
    thread_id: threadId,
    operation,
  }).pipe(
    Effect.provideService(Diagnostics.Service, input.diagnostics),
    Effect.catchCause(() => Effect.void),
  )
}

const projectThreadEvents = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  operation: string,
): Effect.Effect<void, NativeEdgeError> =>
  Effect.gen(function* () {
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    yield* mirrorObservedEvents(input, events, operation, threadId)
  })

const mirrorObservedEvents = (
  input: RouteInput,
  events: ReadonlyArray<Event.Event>,
  operation: string,
  threadId: Ids.ThreadId,
): Effect.Effect<void, NativeEdgeError> =>
  Effect.gen(function* () {
    yield* observeThreadEvents(input, events, operation, threadId)
    yield* Effect.forEach(events, (event) =>
      input.eventLog.appendIfAbsentAndProject(event).pipe(Effect.provideService(Database.Service, input.database)),
    ).pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
  })

const observeThreadEvents = (
  input: RouteInput,
  events: ReadonlyArray<Event.Event>,
  operation: string,
  threadId: Ids.ThreadId,
): Effect.Effect<void, NativeEdgeError> =>
  input.threadDirectory.applyEvents(events).pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))

const isTurnStarted = (event: Event.Event): event is Event.TurnStarted => event.type === "turn.started"

const isTerminalTurnEventFor = (
  event: Event.Event,
  turnId: Ids.TurnId,
): event is Event.TurnCompleted | Event.TurnFailed =>
  (event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === turnId

const actorSummary = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  operation: string,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const events = yield* input.threadClient
      .getEvents({ thread_id: threadId })
      .pipe(Effect.mapError((error) => edgeError(error, operation, threadId)))
    return yield* actorSummaryFromEvents(input, threadId, events, operation)
  })

const actorSummaryFromEvents = (
  input: RouteInput,
  threadId: Ids.ThreadId,
  events: ReadonlyArray<Event.Event>,
  operation: string,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  summaryFromEvents(threadId, events, operation).pipe(
    Effect.flatMap((summary) => enrichSummaryWithOrbStatus(input, summary, operation)),
  )

const enrichSummaryWithOrbStatus = (
  input: RouteInput,
  summary: Remote.ThreadSummary,
  operation: string,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    if (input.orbStore === undefined) return summary
    const orb = yield* input.orbStore
      .getByThread(summary.thread_id)
      .pipe(Effect.mapError((error) => edgeError(error, operation, summary.thread_id)))
    return orb === undefined ? summary : { ...summary, orb_status: orb.status }
  })

const summaryFromEvents = (
  threadId: Ids.ThreadId,
  events: ReadonlyArray<Event.Event>,
  operation: string,
): Effect.Effect<Remote.ThreadSummary, NativeEdgeError> =>
  Effect.gen(function* () {
    const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    if (created === undefined) {
      return yield* new NativeEdgeError({
        message: `Thread ${threadId} was not found`,
        operation,
        status: 404,
        thread_id: threadId,
      })
    }
    const state = ThreadActor.stateFromEvents(threadId, events)
    const latest = events.at(-1) ?? created
    const turnState = turnSummaryStateFromEvents(events)
    const visibility = events.reduce<Event.ThreadVisibility>(
      (current, event) =>
        event.type === "thread.visibility.set" && "visibility" in event.data ? event.data.visibility : current,
      "private",
    )
    return {
      thread_id: threadId,
      workspace_id: created.data.workspace_id,
      ...(created.data.user_id === undefined ? {} : { user_id: created.data.user_id }),
      ...(created.data.title_text === undefined ? {} : { title_text: created.data.title_text }),
      ...(state.latest_message_text === undefined ? {} : { latest_message_text: state.latest_message_text }),
      diff: ThreadDirectory.diffStatsFromEvents(events),
      ...(turnState.activeTurnId === undefined ? {} : { active_turn_id: turnState.activeTurnId }),
      ...(turnState.activeTurnStatus === undefined ? {} : { active_turn_status: turnState.activeTurnStatus }),
      ...(turnState.contextTokens === undefined ? {} : { context_tokens: turnState.contextTokens }),
      archived: state.archived,
      visibility,
      created_at: created.created_at,
      updated_at: latest.created_at,
    }
  })

const turnSummaryStateFromEvents = (events: ReadonlyArray<Event.Event>): TurnSummaryState =>
  events.reduce<TurnSummaryState>((state, event) => {
    if (event.type === "turn.started") {
      return { ...state, activeTurnId: event.turn_id, activeTurnStatus: "active" }
    }
    if (event.type === "turn.failed") {
      if (state.activeTurnId === undefined) {
        return { ...state, activeTurnId: event.turn_id, activeTurnStatus: "failed" }
      }
      if (state.activeTurnId === event.turn_id && state.activeTurnStatus === "active") {
        return { ...state, activeTurnStatus: "failed" }
      }
      return state
    }
    if (event.type !== "turn.completed") return state
    if (state.activeTurnId === undefined) {
      return {
        activeTurnId: event.turn_id,
        activeTurnStatus: "completed",
        contextTokens: event.data.usage?.input_tokens ?? state.contextTokens,
      }
    }
    if (state.activeTurnId === event.turn_id && state.activeTurnStatus === "active") {
      return {
        activeTurnId: state.activeTurnId,
        activeTurnStatus: "completed",
        contextTokens: event.data.usage?.input_tokens ?? state.contextTokens,
      }
    }
    return state
  }, {})

interface TurnSummaryState {
  readonly activeTurnId?: Ids.TurnId
  readonly activeTurnStatus?: "active" | "completed" | "failed"
  readonly contextTokens?: number
}

const projectionSummaryToRemote = (summary: ThreadProjection.ThreadSummary): Remote.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.last_user_id === undefined ? {} : { last_user_id: summary.last_user_id }),
  ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  diff: summary.diff,
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  ...(summary.context_tokens === undefined ? {} : { context_tokens: summary.context_tokens }),
  archived: summary.archived,
  visibility: summary.visibility,
  created_at: Common.TimestampMillis.make(summary.created_at),
  updated_at: Common.TimestampMillis.make(summary.updated_at),
})

const compareThreadSummaries = (left: Remote.ThreadSummary, right: Remote.ThreadSummary) =>
  right.updated_at - left.updated_at || left.thread_id.localeCompare(right.thread_id)

interface ActorBackedRecord {
  readonly summary: Remote.ThreadSummary
  readonly events: ReadonlyArray<Event.Event>
}

interface ProjectedSearchCandidateInput {
  readonly includeArchived: boolean | undefined
  readonly archived: boolean | undefined
  readonly workspaceId: Ids.WorkspaceId | undefined
  readonly fileGlobs: ReadonlyArray<string>
  readonly fileThreadIds: ReadonlySet<Ids.ThreadId>
  readonly after: Common.TimestampMillis | undefined
  readonly before: Common.TimestampMillis | undefined
}

const projectedSearchCandidates = (
  summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
  input: ProjectedSearchCandidateInput,
) =>
  summaries
    .filter((summary) => input.includeArchived === true || !summary.archived)
    .filter((summary) => input.archived === undefined || summary.archived === input.archived)
    .filter((summary) => input.workspaceId === undefined || summary.workspace_id === input.workspaceId)
    .filter(
      (summary) =>
        input.fileGlobs.length === 0 || input.fileThreadIds.size === 0 || input.fileThreadIds.has(summary.thread_id),
    )
    .filter((summary) => input.after === undefined || summary.updated_at >= input.after)
    .filter((summary) => input.before === undefined || summary.updated_at <= input.before)

const discoverySummaries = (
  input: RouteInput,
  operation: string,
): Effect.Effect<ReadonlyArray<ThreadProjection.ThreadSummary>, NativeEdgeError> =>
  Effect.gen(function* () {
    const directory = yield* input.threadDirectory
      .listThreads()
      .pipe(Effect.mapError((error) => edgeError(error, operation)))
    const projection = yield* input.projection.listThreads().pipe(
      Effect.provideService(Database.Service, input.database),
      Effect.mapError((error) => edgeError(error, operation)),
    )
    return mergeProjectionSummaries(directory, projection)
  })

const mergeProjectionSummaries = (
  primary: ReadonlyArray<ThreadProjection.ThreadSummary>,
  secondary: ReadonlyArray<ThreadProjection.ThreadSummary>,
) => {
  const summaries = new Map<string, ThreadProjection.ThreadSummary>()
  for (const summary of secondary) {
    summaries.set(summary.thread_id, summary)
  }
  for (const summary of primary) {
    summaries.set(summary.thread_id, summary)
  }
  return [...summaries.values()].toSorted(
    (left, right) => right.updated_at - left.updated_at || left.thread_id.localeCompare(right.thread_id),
  )
}

const actorBackedRecords = (
  input: RouteInput,
  candidates: ReadonlyArray<ThreadProjection.ThreadSummary>,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  operation: string,
): Effect.Effect<ReadonlyArray<ActorBackedRecord>, NativeEdgeError> =>
  Effect.gen(function* () {
    const records = yield* Effect.forEach(candidates, (summary) =>
      actorBackedRecord(input, summary, identity, operation),
    )
    const present = records.filter(Option.isSome).map((record) => record.value)
    if (identity === undefined) return present
    const discoverable = yield* input.workspaceAccess
      .filterDiscoverableThreads(
        present.map((record) => remoteSummaryToProjection(record.summary)),
        identity.user_id,
      )
      .pipe(Effect.mapError((error) => edgeError(error, operation)))
    const ids = new Set(discoverable.map((summary) => summary.thread_id))
    return present.filter((record) => ids.has(record.summary.thread_id))
  })

const actorBackedRecord = (
  input: RouteInput,
  summary: ThreadProjection.ThreadSummary,
  identity: ThreadActor.VerifiedUserIdentity | undefined,
  operation: string,
): Effect.Effect<Option.Option<ActorBackedRecord>, NativeEdgeError> => {
  if (identity === undefined) {
    return input.threadClient.getEvents({ thread_id: summary.thread_id }).pipe(
      Effect.flatMap((events) => {
        if (events.length === 0) return projectionBackedRecord(input, summary, operation)
        return actorSummaryFromEvents(input, summary.thread_id, events, operation).pipe(
          Effect.tap(() => observeThreadEvents(input, events, operation, summary.thread_id)),
          Effect.map((freshSummary) => Option.some({ summary: freshSummary, events })),
        )
      }),
      Effect.catch((error: unknown) =>
        suppressActorCandidateError(error)
          ? projectionBackedRecord(input, summary, operation)
          : Effect.fail(edgeError(error, operation, summary.thread_id)),
      ),
    )
  }
  return input.threadClient.getEvents({ thread_id: summary.thread_id, ...identityField(identity) }).pipe(
    Effect.flatMap((events) =>
      actorSummaryFromEvents(input, summary.thread_id, events, operation).pipe(
        Effect.map((freshSummary) => Option.some({ summary: freshSummary, events })),
      ),
    ),
    Effect.tap((record) =>
      Option.isSome(record)
        ? mirrorObservedEvents(input, record.value.events, operation, summary.thread_id)
        : Effect.void,
    ),
    Effect.catch((error: unknown) =>
      suppressActorCandidateError(error)
        ? Effect.succeed(Option.none())
        : Effect.fail(edgeError(error, operation, summary.thread_id)),
    ),
  )
}

const projectionBackedRecord = (
  input: RouteInput,
  summary: ThreadProjection.ThreadSummary,
  operation: string,
): Effect.Effect<Option.Option<ActorBackedRecord>, NativeEdgeError> =>
  input.eventLog.readThread({ thread_id: summary.thread_id }).pipe(
    Effect.provideService(Database.Service, input.database),
    Effect.flatMap((events) =>
      enrichSummaryWithOrbStatus(input, projectionSummaryToRemote(summary), operation).pipe(
        Effect.map((remoteSummary) => Option.some({ summary: remoteSummary, events })),
      ),
    ),
    Effect.mapError((error) => edgeError(error, operation, summary.thread_id)),
  )

const suppressActorCandidateError = (error: unknown) =>
  (error instanceof NativeEdgeError && error.status === 404) ||
  hasTag(error, "WorkspaceAccessDenied") ||
  (error instanceof ThreadActor.ThreadActorActionError && error.message.includes("was not found"))

const remoteSummaryToProjection = (summary: Remote.ThreadSummary): ThreadProjection.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.last_user_id === undefined ? {} : { last_user_id: summary.last_user_id }),
  ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  diff: summary.diff,
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  ...(summary.context_tokens === undefined ? {} : { context_tokens: summary.context_tokens }),
  archived: summary.archived,
  visibility: summary.visibility,
  created_at: summary.created_at,
  updated_at: summary.updated_at,
})

const scoreSearchResult = (
  summary: Remote.ThreadSummary,
  events: ReadonlyArray<Event.Event>,
  terms: ReadonlyArray<string>,
): Remote.ThreadSearchResult => {
  const fields = searchableFields(summary, events)
  const matched =
    terms.length === 0 ? [] : uniqueNonEmpty(fields.filter((field) => terms.some((term) => includesTerm(field, term))))
  const score =
    terms.length === 0
      ? 0
      : terms.reduce((total, term) => total + fields.filter((field) => includesTerm(field, term)).length, 0)
  return { summary, score, matched: matched.slice(0, 8) }
}

const searchableFields = (summary: Remote.ThreadSummary, events: ReadonlyArray<Event.Event>) =>
  uniqueNonEmpty([
    summary.thread_id,
    summary.workspace_id,
    summary.user_id ?? "",
    summary.latest_message_text ?? "",
    ...events.flatMap(ThreadDigest.messageEntry),
    ...ThreadDigest.fileEntries(events),
    ...ThreadDigest.toolEntries(events),
    ...events.map((event) => JSON.stringify(event.metadata ?? {})),
  ])

const includesTerm = (value: string, term: string) => value.toLowerCase().includes(term)
const uniqueNonEmpty = (values: ReadonlyArray<string>) => [...new Set(values.filter((value) => value.length > 0))]
const firstAndLast = (values: ReadonlyArray<string>, limit: number) => {
  if (values.length <= limit) return values
  const head = values.slice(0, Math.ceil(limit / 2))
  const tail = values.slice(-Math.floor(limit / 2))
  return [...head, ...tail]
}
const capText = (text: string, maxChars: number) =>
  text.length <= maxChars
    ? { text, truncated: false }
    : { text: `${text.slice(0, maxChars)}\n… truncated`, truncated: true }
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.floor(value), min), max)
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()

const projectWorkspaceIdForSearch = (input: RouteInput, projectName: string | undefined) =>
  Effect.gen(function* () {
    if (projectName === undefined || input.projectStore === undefined) return undefined
    const project = yield* input.projectStore
      .getByName(projectName)
      .pipe(Effect.mapError((error) => edgeError(error, "searchThreads")))
    return project === undefined ? undefined : Ids.WorkspaceId.make(`project:${project.project_id}`)
  })

const resolvedSearchBound = (
  input: RouteInput,
  key: "after" | "before",
  request: Common.TimestampMillis | undefined,
  parsed: ThreadSearchQuery.DateFilter | undefined,
) =>
  Effect.gen(function* () {
    const now = yield* input.time.nowMillis
    const parsedMillis = parsed === undefined ? undefined : ThreadSearchQuery.resolveDateFilter(parsed, now)
    if (key === "after") return maxTimestamp(request, parsedMillis)
    return minTimestamp(request, parsedMillis)
  })

const searchFileThreadIds = (
  input: RouteInput,
  globs: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<Ids.ThreadId>, NativeEdgeError> => {
  if (globs.length === 0) return Effect.succeed(new Set())
  return Effect.all([
    input.threadDirectory.listThreadFiles(),
    input.projection.listThreadFiles().pipe(Effect.provideService(Database.Service, input.database)),
  ]).pipe(
    Effect.map(
      ([directoryFiles, projectionFiles]) =>
        new Set(
          mergeThreadFiles(directoryFiles, projectionFiles)
            .filter((file) => globs.some((glob) => ThreadSearchQuery.matchesFileGlob(file.path, glob)))
            .map((file) => file.thread_id),
        ),
    ),
    Effect.mapError((error) => edgeError(error, "searchThreads")),
  )
}

const mergeThreadFiles = (
  primary: ReadonlyArray<ThreadProjection.ThreadFile>,
  secondary: ReadonlyArray<ThreadProjection.ThreadFile>,
) => {
  const files = new Map<string, ThreadProjection.ThreadFile>()
  for (const file of secondary) {
    files.set(`${file.thread_id}\0${file.path}`, file)
  }
  for (const file of primary) {
    files.set(`${file.thread_id}\0${file.path}`, file)
  }
  return [...files.values()]
}

const actorRecordMatchesFileGlobs = (record: ActorBackedRecord, globs: ReadonlyArray<string>) =>
  globs.length === 0 ||
  ThreadDigest.fileEntries(record.events).some((path) =>
    globs.some((glob) => ThreadSearchQuery.matchesFileGlob(path, glob)),
  )

const maxTimestamp = (
  left: Common.TimestampMillis | undefined,
  right: Common.TimestampMillis | undefined,
): Common.TimestampMillis | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  return Common.TimestampMillis.make(Math.max(left, right))
}

const minTimestamp = (
  left: Common.TimestampMillis | undefined,
  right: Common.TimestampMillis | undefined,
): Common.TimestampMillis | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  return Common.TimestampMillis.make(Math.min(left, right))
}

const listLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 100, 1), 1_000)
const searchLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 20, 1), 1_000)
const previewLimitValue = (limit: number | undefined) => Math.min(Math.max(limit ?? 500, 1), 500)
const previewLimit = (url: URL) => previewLimitValue(intParam(url, "limit"))

const listThreadsRequest = (url: URL): Remote.ListThreadsRequest => {
  const includeArchived = url.searchParams.get("include_archived")
  const workspaceId = url.searchParams.get("workspace_id")
  const userId = url.searchParams.get("user_id")
  const limit = intParam(url, "limit")
  return {
    ...(includeArchived === null ? {} : { include_archived: includeArchived === "true" }),
    ...(workspaceId === null ? {} : { workspace_id: Ids.WorkspaceId.make(workspaceId) }),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(limit === undefined ? {} : { limit }),
  }
}

const searchThreadsRequest = (url: URL): Remote.SearchThreadsRequest => {
  const queryValue = url.searchParams.get("query")
  const includeArchived = url.searchParams.get("include_archived")
  const workspaceId = url.searchParams.get("workspace_id")
  const userId = url.searchParams.get("user_id")
  const after = intParam(url, "after")
  const before = intParam(url, "before")
  const limit = intParam(url, "limit")
  return {
    ...(queryValue === null ? {} : { query: queryValue }),
    ...(includeArchived === null ? {} : { include_archived: includeArchived === "true" }),
    ...(workspaceId === null ? {} : { workspace_id: Ids.WorkspaceId.make(workspaceId) }),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  }
}

const listArtifactsRequest = (url: URL): Effect.Effect<Remote.ListArtifactsRequest, NativeEdgeError> => {
  const threadId = url.searchParams.get("thread_id")
  if (threadId === null) {
    return Effect.fail(
      new NativeEdgeError({
        message: "thread_id query parameter is required",
        operation: "listArtifacts",
        status: 400,
      }),
    )
  }
  const userId = url.searchParams.get("user_id")
  const kind = url.searchParams.get("kind")
  const limit = intParam(url, "limit")
  return Effect.try({
    try: () => ({
      thread_id: Ids.ThreadId.make(threadId),
      ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
      ...(kind === null ? {} : { kind: Schema.decodeUnknownSync(Artifact.Kind)(kind) }),
      ...(limit === undefined ? {} : { limit }),
    }),
    catch: (cause) =>
      new NativeEdgeError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "listArtifacts",
        status: 400,
      }),
  })
}

const ndjson = (events: Stream.Stream<Remote.StreamFrame, NativeEdgeError>) => {
  const encoder = new TextEncoder()
  const encodeFrame = (frame: Remote.StreamFrame) =>
    encoder.encode(`${JSON.stringify(Codec.encode(Remote.StreamFrame)(frame))}\n`)
  const body = events.pipe(
    Stream.catchCause((cause: Cause.Cause<NativeEdgeError>) => Stream.make(errorFrameFromCause(cause))),
    Stream.map(encodeFrame),
    Stream.toReadableStream,
  )
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
}

const decodeBody = <const S extends Schema.ConstraintDecoder<unknown>>(
  request: Request,
  schema: S,
): Effect.Effect<S["Type"], NativeEdgeError> =>
  Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(schema)(await request.json()),
    catch: (cause) =>
      new NativeEdgeError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "decodeBody",
        status: 400,
      }),
  })

const jsonEffect =
  <const S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  <E>(effect: Effect.Effect<S["Type"], E>): Effect.Effect<Response, E> =>
    effect.pipe(Effect.map((value) => json(Codec.encode(schema)(value))))

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const notFound = () => json({ error: { message: "Not found", code: "not_found" } }, 404)

const unauthorizedResponse = (request: Request, requiredToken: string | undefined) => {
  if (requiredToken === undefined) return undefined
  if (isAuthorized(request, requiredToken)) return undefined
  return json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)
}

const isAuthorized = (request: Request, requiredToken: string | undefined) =>
  requiredToken !== undefined &&
  constantTimeTokenEquals(request.headers.get("authorization"), `Bearer ${requiredToken}`)

const tokenValue = (token: string | undefined) => (token === undefined || token.length === 0 ? undefined : token)

const constantTimeTokenEquals = (actual: string | null | undefined, expected: string): boolean => {
  const actualValue = actual ?? ""
  const actualDigest = tokenDigest(actualValue)
  const expectedDigest = tokenDigest(expected)
  return timingSafeEqual(actualDigest, expectedDigest) && actualValue.length === expected.length
}

const tokenDigest = (value: string) => createHash("sha256").update(value, "utf8").digest()

const errorResponseFromCause = (cause: Cause.Cause<NativeEdgeError>) => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return errorResponse(failure.value)
  if (Cause.hasInterruptsOnly(cause))
    return json({ error: { message: "Request interrupted", code: "interrupted" } }, 499)
  return errorResponse(causeError(cause, "handle"))
}

const errorFrameFromCause = (cause: Cause.Cause<NativeEdgeError>): Remote.ApiError => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return errorToApi(failure.value)
  return errorToApi(causeError(cause, "stream"))
}

const errorResponse = (error: NativeEdgeError) => json(errorToApi(error), error.status)

const errorToApi = (error: NativeEdgeError): Remote.ApiError => ({
  error: {
    message: error.message,
    code: error.operation,
    details: {
      status: error.status,
      ...(error.active_user_id === undefined ? {} : { active_user_id: error.active_user_id }),
      ...(error.thread_id === undefined ? {} : { thread_id: error.thread_id }),
    },
  },
})

const causeError = (cause: Cause.Cause<NativeEdgeError>, operation: string) =>
  new NativeEdgeError({ message: Cause.pretty(cause), operation, status: 500 })

const edgeError = (error: unknown, operation: string, threadId?: Ids.ThreadId) =>
  new NativeEdgeError({
    message: errorMessage(error),
    operation,
    status: statusFromError(error),
    ...(threadId === undefined ? {} : { thread_id: threadId }),
    ...activeUserIdField(error),
  })

const statusFromError = (error: unknown) => {
  if (error instanceof NativeEdgeError) return error.status
  if (error instanceof IdeBridge.IdeBridgeError) return typeof error.status === "number" ? error.status : 500
  if (error instanceof ThreadActor.ThreadActorActiveTurn) return 409
  if (error instanceof ThreadActor.ThreadActorForkError && error.reason === "turn_open") return 409
  if (error instanceof ThreadActor.ThreadActorForkError) return 404
  if (error instanceof ThreadActor.ThreadActorActionError) return statusFromThreadActorActionError(error)
  if (error instanceof OrbStore.OrbStoreError) return statusFromOrbStoreError(error)
  if (error instanceof OrbManager.OrbProvisionError) return statusFromOrbProvisionError(error)
  if (error instanceof ProjectStore.ProjectStoreError && error.message.toLowerCase().includes("not found")) return 404
  if (error instanceof ProjectStore.ProjectStoreError) return 500
  if (hasTag(error, "WorkspaceAccessDenied")) return 403
  if (hasTag(error, "WorkspaceAccessError")) return 404
  return 500
}

const statusFromOrbStoreError = (error: OrbStore.OrbStoreError) =>
  error.reason === "not_found" ? 404 : error.reason === "invalid_transition" ? 409 : 500

const statusFromThreadActorActionError = (error: ThreadActor.ThreadActorActionError) => {
  if (error.message.includes("was not found")) return 404
  if (error.message.includes("another workspace")) return 409
  return 500
}

const statusFromOrbProvisionError = (error: OrbManager.OrbProvisionError) => {
  const message = error.message.toLowerCase()
  if (message.includes("not found")) return 404
  if (
    message.includes("cannot pause from") ||
    message.includes("cannot resume from") ||
    message.includes("cannot kill from") ||
    message.includes("invalid orb status transition")
  ) {
    return 409
  }
  return 500
}

const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error)

const hasTag = (error: unknown, tag: string) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag

const activeUserIdField = (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "active_user_id" in error &&
    typeof error.active_user_id === "string"
  ) {
    return { active_user_id: Ids.UserId.make(error.active_user_id) }
  }
  return {}
}

const identityForRequest = (
  input: RouteInput,
  requestedUserId: Ids.UserId | undefined,
  operation: string,
  threadId?: Ids.ThreadId,
): Effect.Effect<ThreadActor.VerifiedUserIdentity | undefined, NativeEdgeError> =>
  Effect.gen(function* () {
    const authorized = userIdFromToken(input.requiredToken)
    if (requestedUserId !== undefined && requestedUserId !== authorized) {
      return yield* new NativeEdgeError({
        message: "Request user_id is not verified by the bearer token",
        operation,
        status: 403,
        ...(threadId === undefined ? {} : { thread_id: threadId }),
      })
    }
    return authorized === undefined ? undefined : { _tag: "VerifiedUserIdentity", user_id: authorized }
  })

const identityFieldForRequest = (
  input: RouteInput,
  requestedUserId: Ids.UserId | undefined,
  operation: string,
  threadId?: Ids.ThreadId,
) => identityForRequest(input, requestedUserId, operation, threadId).pipe(Effect.map(identityField))

const identityFieldFromRequestUserId = (input: RouteInput, requestedUserId: Ids.UserId | undefined) => {
  const authorized = userIdFromToken(input.requiredToken)
  if (requestedUserId !== undefined && requestedUserId === authorized) {
    return { identity: { _tag: "VerifiedUserIdentity" as const, user_id: requestedUserId } }
  }
  return authorized === undefined ? {} : { identity: { _tag: "VerifiedUserIdentity" as const, user_id: authorized } }
}

const identityField = (identity: ThreadActor.VerifiedUserIdentity | undefined) =>
  identity === undefined ? {} : { identity }

const localNativeEdgeIdentity = (): ThreadActor.VerifiedUserIdentity => ({
  _tag: "VerifiedUserIdentity",
  user_id: Ids.UserId.make("local-native-edge"),
})

const userIdField = (userId: Ids.UserId | undefined) => (userId === undefined ? {} : { user_id: userId })

const afterSequenceField = (afterSequence: number | undefined) =>
  afterSequence === undefined ? {} : { after_sequence: afterSequence }

const userIdParam = (url: URL) => {
  const value = url.searchParams.get("user_id")
  return value === null ? undefined : Ids.UserId.make(value)
}

const intParam = (url: URL, key: string) => {
  const value = url.searchParams.get(key)
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const serverUrl = (url: URL) => `${url.protocol}//${url.host}`

const userIdFromToken = (token: string | undefined): Ids.UserId | undefined => {
  if (token === undefined || !token.startsWith("user:")) return undefined
  const separator = token.indexOf(":", "user:".length)
  if (separator <= "user:".length) return undefined
  try {
    return Ids.UserId.make(decodeURIComponent(token.slice("user:".length, separator)))
  } catch {
    return undefined
  }
}

const isLoopbackHost = (host: string) => {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}
