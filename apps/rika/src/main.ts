#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import {
  ConfigOperations,
  ContextFileSystem,
  ExtensionOperations,
  Operation,
  ResidentService,
  ResolvedContext,
} from "@rika/app"
import { ConfigContract, ConfigService } from "@rika/config"
import { McpOAuth, SkillRegistry } from "@rika/extensions"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ReadWebPage, Runtime as ToolRuntime, WebSearch } from "@rika/tools"
import { Palette } from "@rika/tui"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Cause, Config, Console, Context, Crypto, Effect, FileSystem, Function, Layer, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { createHash } from "node:crypto"
import { configuredBackendLayer, failureKind, lazyBackendLayer } from "./backend-composition"
import { loadSettingsFile } from "./backend-settings"
import { clientDispatcherLayer } from "./client-dispatcher"
import { executionRoutePin, executionRoutePinFromPrepared, modelRoutesForExecution } from "./model-routing"
export * from "./backend-composition"
export * from "./backend-settings"
export * from "./model-routing"
export * from "./test-model-script"
import { command, version } from "./command"
import * as InteractiveController from "./interactive-controller"
import * as ModelProviderRuntime from "./model-provider-runtime"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { layer as residentLayer } from "./resident-client-transport"
import { serve as serveResident } from "./resident-host-transport"
import * as ResidentProcessStartup from "./resident-process-startup"
import { makeClientOwnedInteractive } from "./tui-program"
import { makeObservedProgram } from "./process-observation"
import { makeResidentOwner } from "./resident-owner"
export * from "./prompt-attachments"
export {
  defaultOpenArguments,
  editorArguments,
  gitOutput,
  parseChangedFiles,
  readChangedFiles,
  refreshChangedFilesOn,
} from "./workspace-actions"
export * from "./startup-runtime"
export * from "./tui-lifecycle"
export { WorkspaceFileError } from "./workspace-files"
import {
  makeStartupRuntime,
  persistedModelRoutesForStartup,
  persistedTitleModelRoutesForStartup,
} from "./startup-runtime"
import { internal as workspaceFilesInternal, makeWorkspaceFiles } from "./workspace-files"

InteractiveController.installPaletteCommands(Palette.commands as Array<InteractiveController.PaletteCommand>)
const pathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const basename = pathService.basename
const dirname = pathService.dirname
const isAbsolute = pathService.isAbsolute
const join = pathService.join
const relativePathFrom = pathService.relative
const resolve = pathService.resolve
const fffGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  workspaceFilesInternal.fffGlob(workspace, pattern, maximumFiles).pipe(Effect.provideService(Path.Path, pathService))
const { resolveWorkspaceFile, resolveWorkspaceFileImpl, resolveWorkspacePath } = makeWorkspaceFiles({
  isAbsolute,
  relative: relativePathFrom,
  resolve,
})
export { resolveWorkspaceFile, resolveWorkspacePath }
export const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const mkdirImpl = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))
export const mkdir: {
  (options?: { readonly recursive?: boolean }): (path: string) => ReturnType<typeof mkdirImpl>
  (path: string, options?: { readonly recursive?: boolean }): ReturnType<typeof mkdirImpl>
} = Function.dual((args) => typeof args[0] === "string", mkdirImpl)
const realpath = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.realPath(path)))
const rmImpl = (path: string, options?: { readonly force?: boolean }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      options?.force === true ? fileSystem.remove(path).pipe(Effect.ignore) : fileSystem.remove(path),
    ),
  )
export const rm: {
  (options?: { readonly force?: boolean }): (path: string) => ReturnType<typeof rmImpl>
  (path: string, options?: { readonly force?: boolean }): ReturnType<typeof rmImpl>
} = Function.dual((args) => typeof args[0] === "string", rmImpl)

class OperationProductError extends Schema.TaggedErrorClass<OperationProductError>()("OperationError", {
  message: Schema.String,
}) {}

const main = Command.run(command, { version }).pipe(
  Effect.catchTags({
    OperationUnavailable: (error: Operation.OperationUnavailable) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    InvalidInput: (error: Operation.InvalidInput) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  }),
)

const { canonicalDatabaseRoot } = makeStartupRuntime({ basename, dirname, mkdir, realpath, resolve })
export { canonicalDatabaseRoot }

if (import.meta.main) {
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      relayDatabase: Config.option(Config.string("RIKA_RELAY_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testModelScriptFile: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT_FILE")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
      residentHost: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_HOST")),
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  const database =
    hostDataRoot === undefined
      ? environment.database._tag === "Some"
        ? environment.database.value
        : `${defaultDataRoot}/rika.db`
      : join(hostDataRoot, "rika.db")
  const relayDatabase =
    hostDataRoot === undefined
      ? environment.relayDatabase._tag === "Some"
        ? environment.relayDatabase.value
        : `${defaultDataRoot}/relay.db`
      : join(hostDataRoot, "relay.db")
  const globalConfig = `${home}/.config/rika/settings.json`
  const workspaceConfig = `${process.cwd()}/.rika/settings.json`
  const extensionLayer = Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: `${home}/.config/rika/skills`,
      workspaceRoot: `${process.cwd()}/.rika/skills`,
      configPath: `${process.cwd()}/.rika/mcp.json`,
      trustPath: `${home}/.config/rika/mcp-trust.json`,
      generationsPath: `${process.cwd()}/.rika/extensions.json`,
    }),
    SkillRegistry.fileSystemLayer,
    McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostLayer),
      Layer.provide(McpOAuth.tokenStoreLayer(`${home}/.config/rika/mcp-oauth.json`)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
  const profile = environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default"
  const profileIdentity = createHash("sha256").update(profile).digest("hex")
  const openAiAuthLayer = OpenAiAuthAdapter.layer.pipe(
    Layer.provide(
      OpenAiCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openai.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )
  const authOperations: Operation.AuthOperationOptions = {
    layer: openAiAuthLayer,
    assertOpenAiDirect: (workspace) =>
      Effect.gen(function* () {
        const globalSettings = yield* loadSettingsFile(globalConfig)
        const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
        const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({
          webProviders: WebSearch.providerRegistry,
          global: globalSettings,
          workspace: settings,
        })
        const resolved = yield* ConfigService.effective().pipe(provideLayerScoped(workspaceConfigLayer))
        if (resolved.settings.providers.openai?.baseUrl !== ConfigContract.defaults.providers.openai?.baseUrl) {
          return yield* OperationProductError.make({
            message:
              "OpenAI account login cannot be used while providers.openai.baseUrl is customized; remove the override first",
          })
        }
      }).pipe(
        provideLayerScoped(BunServices.layer),
        Effect.mapError((error) =>
          Schema.is(OperationProductError)(error) ? error : OperationProductError.make({ message: String(error) }),
        ),
      ),
  }
  const editor =
    environment.visual._tag === "Some"
      ? environment.visual.value
      : environment.editor._tag === "Some"
        ? environment.editor.value
        : undefined
  const productDatabase = Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.all(
        [mkdir(dirname(database), { recursive: true }), mkdir(dirname(relayDatabase), { recursive: true })],
        { concurrency: 2 },
      )
      return Database.layer(database)
    }),
  )
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabase), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadSummaryRepositoryLayer = ThreadSummaryRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const resolvedContextLayer = ResolvedContext.layer(fffGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  const clientOwnedInteractiveFunction = makeClientOwnedInteractive({
    editor,
    mkdir,
    rm,
    provideLayerScoped,
    resolveWorkspaceFileImpl,
    fffGlob,
    failureKind,
  })
  const operationLayer = (
    injectedInteractive: (
      input: ResidentService.InteractiveInput,
      session: Operation.InteractiveSession,
    ) => Effect.Effect<void, Operation.OperationUnavailable>,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const globalSettings = yield* loadSettingsFile(globalConfig)
        const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
        const applicationConfigLayer = ConfigService.liveEnvironmentLayer({
          webProviders: WebSearch.providerRegistry,
          global: globalSettings,
          workspace: workspaceSettings,
        })
        const effectiveConfig = yield* ConfigService.effective().pipe(provideLayerScoped(applicationConfigLayer))
        const testModelConfigured =
          environment.testModelResponse._tag === "Some" ||
          environment.testModelScript._tag === "Some" ||
          environment.testModelScriptFile._tag === "Some"
        const providerRuntimeContext = yield* Layer.build(
          testModelConfigured
            ? ModelProviderRuntime.bypassLayer
            : ModelProviderRuntime.Service.layer.pipe(Layer.provide(openAiAuthLayer)),
        )
        const modelProviders = Context.get(providerRuntimeContext, ModelProviderRuntime.Service)
        const effectiveConfigForWorkspace = (workspace: string) =>
          Effect.gen(function* () {
            const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
            return yield* ConfigService.effective().pipe(
              provideLayerScoped(
                ConfigService.liveEnvironmentLayer({
                  webProviders: WebSearch.providerRegistry,
                  global: globalSettings,
                  workspace: settings,
                }),
              ),
            )
          }).pipe(provideLayerScoped(BunServices.layer))
        const workspaceExecutionRoutePlan = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const resolvedWorkspaceConfig = yield* effectiveConfigForWorkspace(workspace)
            const routes = modelRoutesForExecution(resolvedWorkspaceConfig.settings, mode, tuning)
            if (testModelConfigured)
              return {
                routes,
                executionRoute: executionRoutePin(resolvedWorkspaceConfig.settings, mode, tuning),
                registrations: [],
              }
            const prepared = yield* modelProviders.prepare(routes)
            return {
              routes,
              executionRoute: executionRoutePinFromPrepared(mode, prepared),
              registrations: prepared.registrations,
            }
          }).pipe(provideLayerScoped(BunServices.layer))
        const resolveWorkspaceExecutionRoute = (
          mode: "low" | "medium" | "high" | "ultra",
          tuning: { readonly fastMode?: boolean } | undefined,
          workspace = process.cwd(),
        ) =>
          Effect.gen(function* () {
            const resolvedRoute = yield* workspaceExecutionRoutePlan(mode, tuning, workspace)
            if (resolvedRoute.registrations.length > 0) {
              const backend = yield* ExecutionBackend.Service
              if (backend.registerModels !== undefined) yield* backend.registerModels(resolvedRoute.registrations)
            }
            return resolvedRoute.executionRoute
          })
        const webSearchCredentials = effectiveConfig.environment.webSearchCredentials
        const repositories = Layer.succeedContext(
          yield* Layer.build(
            Layer.mergeAll(
              repositoryLayer,
              turnRepositoryLayer,
              threadSummaryRepositoryLayer,
              transcriptRepositoryLayer,
            ),
          ),
        )
        const persistedTitleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(
          provideLayerScoped(productDatabase.pipe(Layer.provide(BunServices.layer))),
        )
        const persistedModelRoutes = yield* TurnRepository.Service.pipe(
          Effect.flatMap((turns) => turns.listNonterminal),
          Effect.map((turns) => [...persistedModelRoutesForStartup(turns), ...persistedTitleRoutes]),
          provideLayerScoped(repositories),
        )
        const resolveLegacyRoute = (input: ExecutionBackend.StartInput) =>
          Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const thread = yield* threads.get(Thread.ThreadId.make(input.threadId))
            if (thread === undefined)
              return yield* ExecutionBackend.BackendError.make({
                message: `Thread ${input.threadId} does not exist for legacy route resolution`,
              })
            const resolved = yield* workspaceExecutionRoutePlan("medium", undefined, thread.workspace)
            return { executionRoute: resolved.executionRoute, registrations: resolved.registrations }
          }).pipe(
            provideLayerScoped(repositories),
            Effect.mapError((error) =>
              Schema.is(ExecutionBackend.BackendError)(error)
                ? error
                : ExecutionBackend.BackendError.make({ message: String(error) }),
            ),
          )
        const backendLayer = configuredBackendLayer({
          filename: relayDatabase,
          workspace: process.cwd(),
          repositoryLayer: repositories,
          turnRepositoryLayer: repositories,
          settings: effectiveConfig.settings,
          persistedModelRoutes,
          webSearchCredentials,
          resolveLegacyRoute,
          ...(effectiveConfig.settings.permissions.shell === undefined
            ? {}
            : { shellPermission: effectiveConfig.settings.permissions.shell }),
          globalSettings,
        }).pipe(
          Layer.provide(Layer.succeedContext(providerRuntimeContext)),
          Layer.provide(BunServices.layer),
          Layer.provide(BunCrypto.layer),
        )
        const configAdapter = Layer.effect(
          ConfigOperations.Adapter,
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            return ConfigOperations.Adapter.of({
              exists: (filename) =>
                fileSystem
                  .exists(filename)
                  .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: String(error) }))),
              edit: (filename) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    if (editor === undefined)
                      return yield* ConfigOperations.AdapterError.make({
                        message: "Set VISUAL or EDITOR to edit configuration",
                      })
                    yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
                    if (!(yield* fileSystem.exists(filename))) yield* fileSystem.writeFileString(filename, "{}\n")
                    const handle = yield* spawner.spawn(ChildProcess.make(editor, [filename]))
                    const code = yield* handle.exitCode
                    if (Number(code) !== 0)
                      return yield* ConfigOperations.AdapterError.make({ message: `Editor exited with status ${code}` })
                  }),
                ).pipe(
                  Effect.mapError((error) =>
                    Schema.is(ConfigOperations.AdapterError)(error)
                      ? error
                      : ConfigOperations.AdapterError.make({ message: String(error) }),
                  ),
                ),
            })
          }),
        )
        const product = Operation.productLayer({
          repositoryLayer: repositories,
          turnRepositoryLayer: repositories,
          threadSummaryRepositoryLayer: repositories,
          transcriptRepositoryLayer: repositories,
          resolvedContextLayer,
          backendLayer: lazyBackendLayer(backendLayer).pipe(
            Layer.catchCause((cause) =>
              Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
            ),
          ),
          resolveExecutionRoute: (...arguments_) =>
            resolveWorkspaceExecutionRoute(...arguments_).pipe(
              Effect.mapError((error) =>
                OperationProductError.make({
                  message: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          toolRuntimeLayer: (workspace) =>
            Layer.unwrap(
              effectiveConfigForWorkspace(workspace).pipe(
                Effect.map((config) => {
                  const credentials = config.environment.webSearchCredentials
                  const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
                  return ToolRuntime.layer(workspace).pipe(
                    Layer.provide(
                      MediaView.analyzerTestLayer(() =>
                        Effect.fail(MediaView.MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
                      ),
                    ),
                    Layer.provide(
                      Layer.merge(
                        WebSearch.factoryLayer(RelayExecutionBackend.webSearchFactories(credentials).factories),
                        ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                      ).pipe(Layer.provide(FetchHttpClient.layer)),
                    ),
                    Layer.provide(BunServices.layer),
                  )
                }),
              ),
            ).pipe(Layer.orDie),
          defaultWorkspace: process.cwd(),
          shellPermission: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
              const layer = ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: settings,
              })
              const config = yield* ConfigService.effective().pipe(provideLayerScoped(layer))
              return config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!
            }).pipe(provideLayerScoped(BunServices.layer), Effect.orDie),
          makeThreadId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Thread.ThreadId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
          makeTurnId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Turn.TurnId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
          configOperations: {
            layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(
              Layer.provide(BunServices.layer),
              Layer.catchCause((cause) =>
                Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
              ),
            ),
            options: {
              globalConfigPath: globalConfig,
              workspaceConfigPath: workspaceConfig,
              productDatabasePath: database,
              relayDatabasePath: relayDatabase,
              upstream: [
                { name: "baton", present: true },
                { name: "relay", present: true },
              ],
            },
            forWorkspace: (workspace) =>
              Effect.gen(function* () {
                const settings = yield* loadSettingsFile(`${workspace}/.rika/settings.json`)
                return {
                  layer: Layer.merge(
                    configAdapter,
                    ConfigService.liveEnvironmentLayer({
                      webProviders: WebSearch.providerRegistry,
                      global: globalSettings,
                      workspace: settings,
                    }),
                  ).pipe(
                    Layer.provide(BunServices.layer),
                    Layer.catchCause((cause) =>
                      Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
                    ),
                  ),
                  options: {
                    globalConfigPath: globalConfig,
                    workspaceConfigPath: `${workspace}/.rika/settings.json`,
                    productDatabasePath: database,
                    relayDatabasePath: relayDatabase,
                    upstream: [
                      { name: "baton", present: true },
                      { name: "relay", present: true },
                    ],
                  },
                }
              }).pipe(
                provideLayerScoped(BunServices.layer),
                Effect.mapError((error) => OperationProductError.make({ message: String(error) })),
              ),
          },
          extensionOperations: { layer: extensionLayer },
          authOperations,
          interactive: injectedInteractive,
        })
        return product
      }),
    )
  const residentOwner = makeResidentOwner({ operationLayer, authOperations, cwd: () => process.cwd() })
  const observedProgram = makeObservedProgram({ globalConfig, workspaceConfig, version, failureKind })
  const dispatcherLayer = clientDispatcherLayer({
    database,
    relayDatabase,
    environment,
    executablePath: import.meta.path,
    cwd: () => process.cwd(),
    interactive: clientOwnedInteractiveFunction,
    observedProgram,
  })
  const clientProgram = main.pipe(
    provideLayerScoped(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        FetchHttpClient.layer,
        dispatcherLayer.pipe(Layer.provide(residentLayer)),
      ),
    ),
  )
  const hostProgram =
    hostDataRoot === undefined
      ? Effect.die("Resident host data root is unavailable")
      : Effect.scoped(
          serveResident({
            profile: environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(
              environment.residentGrace._tag === "Some" ? environment.residentGrace.value : "500",
            ),
            startupHoldMilliseconds: Number(
              environment.residentStartupHold._tag === "Some" ? environment.residentStartupHold.value : "10000",
            ),
            onReady: ResidentProcessStartup.signalReady,
            owner: residentOwner,
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            const failure = Cause.squash(cause)
            const message =
              failure !== null && typeof failure === "object" && "message" in failure
                ? String(failure.message)
                : String(failure)
            return ResidentProcessStartup.signalFailure(message).pipe(Effect.ignore)
          }),
          provideLayerScoped(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        )
  if (environment.residentHost._tag === "Some" && environment.residentHost.value === "1")
    BunRuntime.runMain(observedProgram("resident", hostDataRoot ?? defaultDataRoot, hostProgram))
  else BunRuntime.runMain(clientProgram)
}
