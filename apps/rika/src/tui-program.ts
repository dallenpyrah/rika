import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation, ResidentService } from "@rika/app"
import { Session, ViewState } from "@rika/tui"
import type { PathTarget } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import { Cause, Clock, Effect, Fiber, FileSystem } from "effect"
import * as InteractiveController from "./interactive-controller"
import {
  imagePasteBlockedNotice,
  initialSubmitAction,
  materializePromptParts,
  pasteClipboardPng,
  pastedImagePath,
  persistPastedImage,
} from "./prompt-attachments"
import { makeTuiEventDispatch } from "./tui-event-dispatch"
import { settleTuiInitialization } from "./tui-lifecycle"
import { makeTuiTerminalLifecycle } from "./tui-terminal-lifecycle"
import {
  internal as workspaceActionsInternal,
  defaultOpenArguments,
  editorArguments,
  gitOutput,
  readChangedFiles,
  refreshChangedFilesOn,
} from "./workspace-actions"
const { childExit } = workspaceActionsInternal

export interface ClientOwnedInteractiveDependencies {
  readonly editor: string | undefined
  readonly mkdir: typeof import("./main").mkdir
  readonly rm: typeof import("./main").rm
  readonly provideLayerScoped: typeof import("./main").provideLayerScoped
  readonly resolveWorkspaceFileImpl: ReturnType<
    typeof import("./workspace-files").makeWorkspaceFiles
  >["resolveWorkspaceFileImpl"]
  readonly fffGlob: typeof import("./workspace-files").internal.fffGlob
  readonly failureKind: (cause: Cause.Cause<unknown>) => string
}
const ignoreSelectionResync = (_threadId: string, _selectionEpoch: number) => {}
export const makeClientOwnedInteractive = (dependencies: ClientOwnedInteractiveDependencies) => {
  const { editor, mkdir, rm, provideLayerScoped, resolveWorkspaceFileImpl, fffGlob, failureKind } = dependencies
  return (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ): Effect.Effect<void, Operation.OperationUnavailable> =>
    Effect.gen(function* () {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return
      const context = yield* Effect.context<never>()
      const fork = Effect.runForkWith(context)
      return yield* Effect.callback<void, Operation.OperationUnavailable>((resume) => {
        const tui = makeTuiEventDispatch({
          model: ViewState.initial(input.workspace ?? process.cwd(), input.mode ?? "medium"),
          renderer: undefined,
          closed: false,
          renderSuppressed: false,
          requestSelectionResync: ignoreSelectionResync,
          fork,
          session,
        })
        let initialization: Fiber.Fiber<void, never> | undefined
        const recoverSession = <R>(
          effect: Effect.Effect<void, Operation.OperationUnavailable, R>,
        ): Effect.Effect<void, never, R> =>
          effect.pipe(
            Effect.catchTag("OperationUnavailable", (error) =>
              tui.closed ? Effect.void : Effect.logError(error.message),
            ),
          )
        let previewTimer: Fiber.Fiber<void, never> | undefined
        const fibers = new Set<Fiber.Fiber<void, never>>()
        let selectionFiber: Fiber.Fiber<void, never> | undefined
        let selectionGeneration = 0
        let loadingOlder = false
        const selectionResyncs = new Set<string>()
        const { close, pauseTerminal, teardown, rendererStarted } = makeTuiTerminalLifecycle({
          getModel: () => tui.model,
          getRenderer: () => tui.renderer,
          getClosed: () => tui.closed,
          setClosed: (closed) => (tui.closed = closed),
          getInitialization: () => initialization,
          getPreviewTimer: () => previewTimer,
          clearPreviewTimer: () => (previewTimer = undefined),
          interruptTimers: tui.interruptTimers,
          fibers,
          fork,
          resume: () => resume(Effect.void),
        })
        const submit = (
          prompt: string,
          parts: ReadonlyArray<ViewState.PromptPart>,
          mode: ViewState.Mode,
          tuning?: Session.ModelTuning,
        ) => {
          const classified = ViewState.classifyPrompt(prompt)
          const effect =
            classified._tag === "Shell"
              ? session.shell(classified.command, classified.incognito)
              : materializePromptParts(parts, tui.model.workspace).pipe(
                  Effect.flatMap((materialized) => session.submit(classified.prompt, mode, materialized, tuning)),
                  Effect.catchTag("PromptAttachmentError", (failure) =>
                    Effect.sync(() => {
                      let restored: ViewState.Model = {
                        ...tui.model,
                        input: "",
                        cursor: 0,
                        pastedText: [],
                        busy: false,
                        activity: undefined,
                      }
                      for (const [index, part] of parts.entries()) {
                        if (part.type === "image") {
                          if (index !== failure.index)
                            restored = ViewState.update(restored, { _tag: "ImageInserted", path: part.path })
                        } else {
                          restored = {
                            ...restored,
                            input:
                              restored.input.slice(0, restored.cursor) +
                              part.text +
                              restored.input.slice(restored.cursor),
                            cursor: restored.cursor + part.text.length,
                          }
                        }
                      }
                      tui.model = ViewState.update(restored, { _tag: "ExecutionFailed", message: failure.message })
                      tui.renderer?.surface.update(tui.model)
                    }),
                  ),
                )
          const fiber = effect.pipe(provideLayerScoped(BunServices.layer), recoverSession, fork)
          fibers.add(fiber)
          fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
        }
        const run = <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => {
          const fiber = fork(
            effect.pipe(
              provideLayerScoped(BunServices.layer),
              Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
            ),
          )
          fibers.add(fiber)
          fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
        }
        const loadSelected = (effect: Effect.Effect<void, Operation.OperationUnavailable>, generation: number) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (generation !== selectionGeneration) return
              tui.model = ViewState.update(tui.model, { _tag: "ThreadOpenRequested" })
              tui.renderer?.surface.update(tui.model)
              tui.renderSuppressed = true
            })
            yield* effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (generation !== selectionGeneration) return
                  tui.renderSuppressed = false
                  tui.model = ViewState.update(tui.model, { _tag: "ThreadOpenCompleted" })
                  tui.renderer?.surface.update(tui.model)
                }),
              ),
            )
          })
        const startSelection = (select: (epoch: number) => Effect.Effect<void, Operation.OperationUnavailable>) => {
          const generation = (selectionGeneration += 1)
          const previous = selectionFiber
          let selectedFiber: Fiber.Fiber<void, never>
          selectedFiber = fork(
            (previous === undefined ? Effect.void : Fiber.interrupt(previous)).pipe(
              Effect.andThen(recoverSession(loadSelected(select(generation), generation))),
              Effect.ensuring(
                Effect.sync(() => {
                  fibers.delete(selectedFiber)
                  if (selectionFiber === selectedFiber) selectionFiber = undefined
                }),
              ),
            ),
          )
          selectionFiber = selectedFiber
          fibers.add(selectedFiber)
          return selectedFiber
        }
        tui.requestSelectionResync = (threadId, selectionEpoch) => {
          if (selectionEpoch !== tui.selectionEpoch || tui.model.currentThreadId !== threadId) return
          const key = `${threadId}:${selectionEpoch}`
          if (selectionResyncs.has(key)) return
          selectionResyncs.add(key)
          startSelection((epoch) =>
            session
              .selectThread(threadId, epoch)
              .pipe(Effect.ensuring(Effect.sync(() => selectionResyncs.delete(key)))),
          )
        }
        const loadChangedFiles = () =>
          readChangedFiles(tui.model.workspace).pipe(
            Effect.tap((files) =>
              Effect.sync(() => {
                const current = tui.model
                tui.model = ViewState.update(current, { _tag: "ChangedFilesReplaced", files })
                if (tui.model !== current) tui.renderer?.surface.update(tui.model)
              }),
            ),
            Effect.asVoid,
          )
        const watchChangedFiles = FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            refreshChangedFilesOn(
              fileSystem.watch(tui.model.workspace),
              () => tui.model.changedFilesOpen,
              loadChangedFiles(),
            ),
          ),
          Effect.catchCause((cause) => Effect.logWarning(`changed-files watcher stopped: ${Cause.pretty(cause)}`)),
        )
        const editComposer = () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem
                if (editor === undefined) {
                  tui.renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
                  return
                }
                const relative = `.rika/compose-${now}.md`
                const file = `${tui.model.workspace}/${relative}`
                yield* mkdir(`${tui.model.workspace}/.rika`, { recursive: true })
                yield* fileSystem.writeFileString(file, ViewState.displayInput(tui.model))
                const resumeTerminal = pauseTerminal()
                yield* childExit("run editor", [editor, file], {
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                  detached: false,
                }).pipe(Effect.ensuring(Effect.sync(resumeTerminal)))
                const edited = yield* fileSystem.readFileString(file)
                yield* rm(file, { force: true })
                tui.model = ViewState.update(tui.model, { _tag: "ComposerReplaced", text: edited.replace(/\n$/, "") })
                tui.renderer?.surface.update(tui.model)
              }),
            ),
            Effect.asVoid,
          )
        let openingPath = false
        const openPath = (target: PathTarget) => {
          if (openingPath) return
          openingPath = true
          run(
            resolveWorkspaceFileImpl(tui.model.workspace, target).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  Effect.sync(() => {
                    tui.renderer?.surface.showToast("Refusing to open a path outside the workspace", "#e06c75")
                  }),
                onSuccess: (path) =>
                  Effect.gen(function* () {
                    if (editor === undefined) {
                      const exit = yield* childExit("open file", defaultOpenArguments(path), {
                        stdin: "ignore",
                        stdout: "ignore",
                        stderr: "ignore",
                      }).pipe(Effect.orElseSucceed(() => -1))
                      if (exit === 0) return
                      tui.renderer?.surface.showToast("Could not open the file in the default application", "#e06c75")
                      return
                    }
                    const resumeTerminal = pauseTerminal()
                    const exit = yield* childExit(
                      "open editor",
                      editorArguments(editor, path, target.line, target.column),
                      {
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
                        detached: false,
                      },
                    ).pipe(
                      Effect.orElseSucceed(() => -1),
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (resumeTerminal() && !tui.closed) tui.renderer?.surface.update(tui.model)
                        }),
                      ),
                    )
                    if (exit !== 0)
                      tui.renderer?.surface.showToast("Could not open the file in the configured editor", "#e06c75")
                  }),
              }),
              Effect.asVoid,
              Effect.ensuring(
                Effect.sync(() => {
                  openingPath = false
                }),
              ),
            ),
          )
        }
        const adapter: Session.Adapter = {
          submit,
          quit: () => close(),
          editQueued: (id, prompt) => run(session.editQueued(id, prompt)),
          dequeue: (id) => run(session.dequeue(id)),
          steerQueued: (id, prompt) => run(session.steerQueued(id, prompt)),
          steer: (prompt) => run(session.steer(prompt)),
          interruptAndSend: (prompt) => run(session.interruptAndSend(prompt)),
          cancel: () => run(session.cancel),
          decidePermission: (id, kind, decision) => run(session.resolvePermission(id, kind, decision)),
          selectThread: (id) => {
            startSelection((epoch) => session.selectThread(id, epoch))
          },
        }
        const consumePendingAction = () => {
          const action = tui.model.pendingAction
          const paletteCommand = InteractiveController.paletteCommand(action)
          if (paletteCommand?._tag === "NewThread") startSelection(() => session.newThread)
          else if (action !== undefined) Session.execute(adapter, action as Session.Action)
          tui.model = ViewState.update(tui.model, { _tag: "PaletteActionConsumed" })
        }
        initialization = fork(
          settleTuiInitialization(
            createTui({
              openPath,
              scroll: (offset) => {
                tui.model = ViewState.update(tui.model, { _tag: "ScrollMoved", offset })
                tui.renderer?.surface.update(tui.model)
                if (offset <= 0 && !loadingOlder) {
                  loadingOlder = true
                  run(
                    session.loadOlder.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          loadingOlder = false
                        }),
                      ),
                    ),
                  )
                }
              },
              scrollGeometry: (offset) => {
                tui.model = ViewState.update(tui.model, { _tag: "ScrollMoved", offset })
              },
              scrollFollow: () => {
                tui.model = ViewState.update(tui.model, { _tag: "ScrollFollowed" })
                tui.renderer?.surface.update(tui.model)
              },
              paste: (text) => {
                tui.model = ViewState.update(tui.model, { _tag: "Pasted", text })
                tui.renderer?.surface.update(tui.model)
              },
              expandPaste: (token) => {
                tui.model = ViewState.update(tui.model, { _tag: "PastedTextExpanded", token })
                tui.renderer?.surface.update(tui.model)
              },
              pasteImage: (image) => {
                const blocked = imagePasteBlockedNotice(tui.model)
                if (blocked !== undefined) {
                  tui.renderer?.surface.showToast(blocked)
                  return
                }
                if (image !== undefined) {
                  const path = pastedImagePath(image.bytes, image.mediaType)
                  if (path === undefined) {
                    tui.renderer?.surface.showToast("Pasted image must be a non-empty PNG, JPEG, GIF, or WebP")
                    return
                  }
                  tui.model = ViewState.update(tui.model, { _tag: "ImageInserted", path })
                  tui.renderer?.surface.update(tui.model)
                  run(
                    persistPastedImage(tui.model.workspace, path, image.bytes).pipe(
                      Effect.tap((persisted) =>
                        Effect.sync(() => {
                          if (persisted) return
                          tui.model = ViewState.update(tui.model, { _tag: "ImageRemoved", path })
                          tui.renderer?.surface.update(tui.model)
                          tui.renderer?.surface.showToast("Pasted image could not be saved")
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  )
                  return
                }
                run(
                  pasteClipboardPng(tui.model.workspace).pipe(
                    Effect.tap((path) =>
                      Effect.sync(() => {
                        if (path === undefined) {
                          tui.renderer?.surface.showToast("Clipboard does not contain a supported non-empty PNG image")
                          return
                        }
                        tui.model = ViewState.update(tui.model, { _tag: "ImageInserted", path })
                        tui.renderer?.surface.update(tui.model)
                      }),
                    ),
                    Effect.asVoid,
                  ),
                )
              },
              clickToggle: (unit) => {
                tui.model = ViewState.update(tui.model, { _tag: "DetailToggled", id: unit })
                tui.renderer?.surface.update(tui.model)
              },
              key: (key) => {
                if (key.ctrl && key.name === "c" && !tui.model.busy) {
                  close()
                  return
                }
                if (key.ctrl && key.name === "g") {
                  run(editComposer())
                  return
                }
                const wasChangedFilesOpen = tui.model.changedFilesOpen
                const beforePreviewId = tui.model.threadSwitcher.open
                  ? ViewState.selectedThreadMetadata(tui.model)?.id
                  : undefined
                const submitting = key.name === "return" && !key.shift && !key.ctrl && ViewState.canSubmit(tui.model)
                const prompt = submitting ? tui.model.input : undefined
                const parts = prompt === undefined ? undefined : ViewState.promptParts(prompt, tui.model.pastedText)
                const submittedPrompt =
                  prompt === undefined ? undefined : ViewState.expandPastedText(prompt, tui.model.pastedText)
                tui.model = ViewState.update(tui.model, { _tag: "KeyPressed", key })
                if (submitting) tui.model = ViewState.update(tui.model, { _tag: "Submitted" })
                if (!wasChangedFilesOpen && tui.model.changedFilesOpen)
                  tui.model = ViewState.update(tui.model, { _tag: "ChangedFilesRequested" })
                const afterPreviewId = tui.model.threadSwitcher.open
                  ? ViewState.selectedThreadMetadata(tui.model)?.id
                  : undefined
                if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
                  tui.model = ViewState.update(tui.model, { _tag: "ThreadPreviewRequested" })
                tui.renderer?.surface.update(tui.model)
                if (!wasChangedFilesOpen && tui.model.changedFilesOpen) run(loadChangedFiles())
                if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
                  if (previewTimer !== undefined) fork(Fiber.interrupt(previewTimer))
                  const selectedPreviewTimer = Effect.sleep("120 millis").pipe(
                    Effect.andThen(session.previewThread(afterPreviewId)),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (previewTimer === selectedPreviewTimer) previewTimer = undefined
                      }),
                    ),
                    recoverSession,
                    fork,
                  )
                  previewTimer = selectedPreviewTimer
                }
                if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined)
                  Session.execute(adapter, {
                    _tag: "Submit",
                    prompt: submittedPrompt,
                    parts,
                    mode: tui.model.mode,
                    tuning: { fastMode: tui.model.fastMode },
                  })
                const action = tui.model.pendingAction as Session.Action | undefined
                if (action !== undefined) consumePendingAction()
              },
              resize: (width, height) => {
                tui.model = ViewState.update(tui.model, { _tag: "Resized", width, height })
                tui.renderer?.surface.update(tui.model)
              },
              composerResize: (height) => {
                tui.model = ViewState.update(tui.model, { _tag: "ComposerHeightChanged", height })
                tui.renderer?.surface.update(tui.model)
              },
              sidebarResize: (width) => {
                tui.model = ViewState.update(tui.model, { _tag: "SidebarWidthChanged", width })
                tui.renderer?.surface.update(tui.model)
              },
              threadSidebarSelect: (index) => {
                tui.model = ViewState.update(tui.model, { _tag: "ThreadSidebarSelectionConfirmed", index })
                tui.renderer?.surface.update(tui.model)
                const action = tui.model.pendingAction as Session.Action | undefined
                if (action !== undefined) consumePendingAction()
              },
              threadPreviewScroll: (offset) => {
                tui.model = ViewState.update(tui.model, { _tag: "ThreadPreviewScrolled", offset })
                tui.renderer?.surface.update(tui.model)
              },
            }),
            () => tui.closed,
            (created) => Effect.sync(() => created.releaseTerminal()),
          ).pipe(
            Effect.tap((created) =>
              Effect.sync(() => {
                if (created === undefined) return
                tui.renderer = created
                if (tui.closed) {
                  created.releaseTerminal()
                  return
                }
                rendererStarted()
                tui.model = ViewState.update(tui.model, { _tag: "FilesRequested" })
                created.surface.update(tui.model)
                run(Effect.logInfo("tui.tui.renderer.started"))
                if (tui.closed) return
                run(session.events(tui.feedBatcher.offer))
                run(watchChangedFiles)
                run(
                  fffGlob(tui.model.workspace, "**/*", 10_000).pipe(
                    Effect.tap((files) =>
                      Effect.sync(() => {
                        tui.model = ViewState.update(tui.model, { _tag: "FilesReplaced", files: files.toSorted() })
                        created.surface.update(tui.model)
                      }),
                    ),
                    Effect.asVoid,
                  ),
                )
                run(
                  gitOutput(["git", "-C", tui.model.workspace, "symbolic-ref", "--short", "HEAD"]).pipe(
                    Effect.tap(([text, exit]) =>
                      Effect.sync(() => {
                        const branch = text.trim()
                        if (exit === 0 && branch.length > 0 && branch !== "HEAD") {
                          tui.model = ViewState.update(tui.model, { _tag: "BranchDetected", branch })
                          created.surface.update(tui.model)
                        }
                      }),
                    ),
                    Effect.asVoid,
                  ),
                )
                run(
                  (input.last === true
                    ? Effect.sync(() => startSelection((epoch) => session.reopenThread(epoch))).pipe(
                        Effect.flatMap(Fiber.join),
                      )
                    : input.threadId === undefined
                      ? Effect.void
                      : Effect.sync(() => startSelection((epoch) => session.selectThread(input.threadId!, epoch))).pipe(
                          Effect.flatMap(Fiber.join),
                        )
                  ).pipe(
                    Effect.andThen(
                      initialSubmitAction(input.prompt, tui.model.mode) === undefined
                        ? Effect.void
                        : Effect.sync(() => {
                            Session.execute(adapter, initialSubmitAction(input.prompt, tui.model.mode)!)
                          }),
                    ),
                  ),
                )
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (tui.closed) return
                resume(
                  Effect.logError("tui.tui.renderer.failed").pipe(
                    Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                    Effect.andThen(
                      Effect.fail(
                        Operation.OperationUnavailable.make({
                          operation: "Interactive",
                          message: Cause.pretty(cause),
                        }),
                      ),
                    ),
                  ),
                )
              }),
            ),
            Effect.asVoid,
          ),
        )
        return teardown(false)
      })
    })
}
