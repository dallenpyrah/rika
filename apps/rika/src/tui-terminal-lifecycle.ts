import { ViewState } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import { Effect, Fiber } from "effect"
import { renderGoodbye } from "./goodbye"
import * as Logging from "./logging"
import { interruptTrackedFibers, tuiSignalExitCode } from "./tui-lifecycle"

type Renderer = Effect.Success<ReturnType<typeof createTui>>

interface TuiTerminalLifecycleTarget {
  readonly getModel: () => ViewState.Model
  readonly getRenderer: () => Renderer | undefined
  readonly getClosed: () => boolean
  readonly setClosed: (closed: boolean) => void
  readonly getInitialization: () => Fiber.Fiber<void, never> | undefined
  readonly getPreviewTimer: () => Fiber.Fiber<void, never> | undefined
  readonly clearPreviewTimer: () => void
  readonly interruptTimers: Effect.Effect<void, never>
  readonly fibers: Set<Fiber.Fiber<void, never>>
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly resume: () => void
}

export const makeTuiTerminalLifecycle = (target: TuiTerminalLifecycleTarget) => {
  let closing = false
  let teardownStarted = false
  let terminalPauseCount = 0
  let pendingJobControlPause = false
  let releaseJobControlPause: (() => boolean) | undefined
  const close = (exitCode?: number) => {
    if (closing) return
    closing = true
    if (exitCode !== undefined) process.exitCode = exitCode
    target.fork(teardown(true).pipe(Effect.andThen(Effect.sync(target.resume))))
  }
  const pauseTerminal = () => {
    if (target.getClosed()) return () => false
    if (terminalPauseCount === 0)
      try {
        target.getRenderer()?.suspendTerminal()
      } catch (cause) {
        close(1)
        throw cause
      }
    terminalPauseCount += 1
    let released = false
    return () => {
      if (released) return false
      released = true
      terminalPauseCount = Math.max(0, terminalPauseCount - 1)
      if (target.getClosed() || terminalPauseCount > 0) return false
      try {
        target.getRenderer()?.resumeTerminal()
      } catch (cause) {
        close(1)
        throw cause
      }
      return true
    }
  }
  const goodbye = () => {
    const model = target.getModel()
    const threadId = model.currentThreadId
    const threadTitle =
      model.currentThreadTitle ??
      (model.threads as ReadonlyArray<ViewState.ThreadItem>).find((thread) => thread.id === threadId)?.title
    process.stdout.write(
      renderGoodbye({
        mode: model.mode,
        workspace: model.workspace,
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadTitle === undefined ? {} : { threadTitle }),
      }),
    )
  }
  const interrupt = () => close(tuiSignalExitCode("SIGINT"))
  const terminate = () => close(tuiSignalExitCode("SIGTERM"))
  const suspend = () => {
    if (target.getClosed() || pendingJobControlPause || releaseJobControlPause !== undefined) return
    if (target.getRenderer() === undefined) {
      pendingJobControlPause = true
      return
    }
    try {
      releaseJobControlPause = pauseTerminal()
      process.kill(process.pid, "SIGSTOP")
    } catch {
      releaseJobControlPause?.()
      releaseJobControlPause = undefined
      close(1)
    }
  }
  const continueFromSuspend = () => {
    if (pendingJobControlPause) {
      pendingJobControlPause = false
      return
    }
    if (target.getClosed() || releaseJobControlPause === undefined) return
    const release = releaseJobControlPause
    releaseJobControlPause = undefined
    try {
      if (release()) target.getRenderer()?.surface.update(target.getModel())
    } catch {
      close(1)
    }
  }
  const teardown = (showGoodbye: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (teardownStarted) return Effect.void
      teardownStarted = true
      return Effect.gen(function* () {
        yield* Effect.logInfo("tui.teardown.started")
        target.setClosed(true)
        process.off("SIGINT", interrupt)
        process.off("SIGTERM", terminate)
        process.off("SIGTSTP", suspend)
        process.off("SIGCONT", continueFromSuspend)
        const previewTimer = target.getPreviewTimer()
        if (previewTimer !== undefined) yield* Fiber.interrupt(previewTimer)
        target.clearPreviewTimer()
        yield* target.interruptTimers
        Logging.settleActiveLogs()
        target.getRenderer()?.releaseTerminal()
        const initialization = target.getInitialization()
        if (initialization !== undefined) yield* Fiber.await(initialization)
        yield* interruptTrackedFibers([...target.fibers])
        if (showGoodbye) goodbye()
        yield* Effect.logInfo("tui.teardown.completed")
      })
    })
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  process.on("SIGTSTP", suspend)
  process.on("SIGCONT", continueFromSuspend)
  return {
    close,
    pauseTerminal,
    teardown,
    rendererStarted: () => {
      if (!pendingJobControlPause) return
      pendingJobControlPause = false
      suspend()
    },
  }
}
