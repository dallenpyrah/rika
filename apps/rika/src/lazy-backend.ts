import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Effect, Fiber, Layer, Ref } from "effect"

export const lazyBackendLayer = <E>(backendLayer: Layer.Layer<ExecutionBackend.Service, E, never>) =>
  Layer.effect(
    ExecutionBackend.Service,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const active = yield* Ref.make<ExecutionBackend.Interface | undefined>(undefined)
      const promoter = yield* Ref.make<ExecutionBackend.TurnPromoter | undefined>(undefined)
      const load = yield* Effect.cached(
        Effect.forkIn(
          Layer.buildWithScope(backendLayer, scope).pipe(
            Effect.map((context) => Context.get(context, ExecutionBackend.Service)),
            Effect.tap((backend) => Ref.set(active, backend)),
            Effect.tap((backend) =>
              Ref.get(promoter).pipe(
                Effect.flatMap((registered) =>
                  registered === undefined || backend.registerTurnPromoter === undefined
                    ? Effect.void
                    : backend.registerTurnPromoter(registered),
                ),
              ),
            ),
            Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: String(cause) })),
          ),
          scope,
        ).pipe(Effect.flatMap(Fiber.join), Effect.uninterruptible),
      )
      return ExecutionBackend.Service.of({
        registerModels: (registrations) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.registerModels === undefined ? Effect.void : backend.registerModels(registrations),
            ),
          ),
        invokeChild: (input) => load.pipe(Effect.flatMap((backend) => backend.invokeChild(input))),
        createFanOut: (input) => load.pipe(Effect.flatMap((backend) => backend.createFanOut(input))),
        inspectFanOut: (fanOutId) => load.pipe(Effect.flatMap((backend) => backend.inspectFanOut(fanOutId))),
        cancelFanOut: (fanOutId, cancelledAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelFanOut(fanOutId, cancelledAt, reason))),
        registerWorkflows: () => load.pipe(Effect.flatMap((backend) => backend.registerWorkflows())),
        startWorkflow: (name, runId, revision, ownerTurnId, workflowWorkspace) =>
          load.pipe(
            Effect.flatMap((backend) => backend.startWorkflow(name, runId, revision, ownerTurnId, workflowWorkspace)),
          ),
        inspectWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.inspectWorkflow(runId, ownerTurnId, workflowWorkspace))),
        cancelWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelWorkflow(runId, ownerTurnId, workflowWorkspace))),
        wakeThreadHost: (wake) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.wakeThreadHost === undefined ? Effect.void : backend.wakeThreadHost(wake),
            ),
          ),
        registerTurnPromoter: (registered) =>
          Ref.set(promoter, registered).pipe(
            Effect.andThen(Ref.get(active)),
            Effect.flatMap((backend) =>
              backend?.registerTurnPromoter === undefined ? Effect.void : backend.registerTurnPromoter(registered),
            ),
          ),
        start: (input) => load.pipe(Effect.flatMap((backend) => backend.start(input))),
        follow: (turnId, afterCursor, onEvent) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.follow === undefined
                ? backend.replay(turnId, afterCursor)
                : backend.follow(turnId, afterCursor, onEvent),
            ),
          ),
        replay: (turnId, afterCursor) => load.pipe(Effect.flatMap((backend) => backend.replay(turnId, afterCursor))),
        cancel: (turnId, cancelledAt) => load.pipe(Effect.flatMap((backend) => backend.cancel(turnId, cancelledAt))),
        inspect: (turnId) => load.pipe(Effect.flatMap((backend) => backend.inspect(turnId))),
        steer: (turnId, text, createdAt) =>
          load.pipe(Effect.flatMap((backend) => backend.steer(turnId, text, createdAt))),
        listApprovals: (turnId) => load.pipe(Effect.flatMap((backend) => backend.listApprovals(turnId))),
        resolveToolApproval: (waitId, approved, resolvedAt, comment) =>
          load.pipe(Effect.flatMap((backend) => backend.resolveToolApproval(waitId, approved, resolvedAt, comment))),
        resolvePermission: (waitId, answer, resolvedAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.resolvePermission(waitId, answer, resolvedAt, reason))),
      })
    }),
  )
