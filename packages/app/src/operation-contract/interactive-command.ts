import * as Turn from "@rika/persistence/turn"
import { Effect, Function, Schema } from "effect"
import { OperationUnavailable } from "./input.ts"
import type { InteractiveEvent } from "./interactive-event.ts"

const Mode = Schema.Literals(["low", "medium", "high", "ultra"])

export const InteractiveCommand = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Submit"),
    prompt: Schema.String,
    mode: Schema.optionalKey(Mode),
    promptParts: Schema.optionalKey(Schema.Array(Turn.PromptPart)),
    modelTuning: Schema.optionalKey(
      Schema.Struct({
        fastMode: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({ _tag: Schema.tag("Shell"), command: Schema.String, incognito: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.tag("EditQueued"), turnId: Schema.String, prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Dequeue"), turnId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("SteerQueued"), turnId: Schema.String, text: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Steer"), text: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("InterruptAndSend"), prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Cancel") }),
  Schema.Struct({ _tag: Schema.tag("NewThread") }),
  Schema.Struct({
    _tag: Schema.tag("ResolvePermission"),
    waitId: Schema.String,
    kind: Schema.Literals(["permission", "tool-approval"]),
    decision: Schema.Literals(["allow", "deny", "always"]),
  }),
  Schema.Struct({
    _tag: Schema.tag("SelectThread"),
    threadId: Schema.String,
    selectionEpoch: Schema.Int,
  }),
  Schema.Struct({ _tag: Schema.tag("ReadQueue"), threadId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("LoadOlder") }),
  Schema.Struct({ _tag: Schema.tag("PreviewThread"), threadId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ReopenThread"), selectionEpoch: Schema.Int }),
  Schema.Struct({
    _tag: Schema.tag("Replay"),
    turnId: Schema.String,
    afterCursor: Schema.optionalKey(Schema.String),
  }),
])
export type InteractiveCommand = typeof InteractiveCommand.Type

export interface InteractiveSession {
  readonly events: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, OperationUnavailable>
  readonly submit: (
    prompt: string,
    mode?: "low" | "medium" | "high" | "ultra",
    promptParts?: ReadonlyArray<Turn.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
  ) => Effect.Effect<void, OperationUnavailable>
  readonly shell: (command: string, incognito: boolean) => Effect.Effect<void, OperationUnavailable>
  readonly editQueued: (turnId: string, prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly dequeue: (turnId: string) => Effect.Effect<void, OperationUnavailable>
  readonly steerQueued: (turnId: string, text: string) => Effect.Effect<void, OperationUnavailable>
  readonly steer: (text: string) => Effect.Effect<void, OperationUnavailable>
  readonly interruptAndSend: (prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly cancel: Effect.Effect<void, OperationUnavailable>
  readonly newThread: Effect.Effect<void, OperationUnavailable>
  readonly resolvePermission: (
    waitId: string,
    kind: "permission" | "tool-approval",
    decision: "allow" | "deny" | "always",
  ) => Effect.Effect<void, OperationUnavailable>
  readonly selectThread: (threadId: string, selectionEpoch: number) => Effect.Effect<void, OperationUnavailable>
  readonly readQueue: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly loadOlder: Effect.Effect<void, OperationUnavailable>
  readonly previewThread: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly reopenThread: (selectionEpoch: number) => Effect.Effect<void, OperationUnavailable>
  readonly replay: (turnId: string, afterCursor: string | undefined) => Effect.Effect<void, OperationUnavailable>
}

const executeInteractiveCommandImpl = (session: InteractiveSession, command: InteractiveCommand) => {
  switch (command._tag) {
    case "Submit":
      return session.submit(command.prompt, command.mode, command.promptParts, command.modelTuning)
    case "Shell":
      return session.shell(command.command, command.incognito)
    case "EditQueued":
      return session.editQueued(command.turnId, command.prompt)
    case "Dequeue":
      return session.dequeue(command.turnId)
    case "SteerQueued":
      return session.steerQueued(command.turnId, command.text)
    case "Steer":
      return session.steer(command.text)
    case "InterruptAndSend":
      return session.interruptAndSend(command.prompt)
    case "Cancel":
      return session.cancel
    case "NewThread":
      return session.newThread
    case "ResolvePermission":
      return session.resolvePermission(command.waitId, command.kind, command.decision)
    case "SelectThread":
      return session.selectThread(command.threadId, command.selectionEpoch)
    case "ReadQueue":
      return session.readQueue(command.threadId)
    case "LoadOlder":
      return session.loadOlder
    case "PreviewThread":
      return session.previewThread(command.threadId)
    case "ReopenThread":
      return session.reopenThread(command.selectionEpoch)
    case "Replay":
      return session.replay(command.turnId, command.afterCursor)
  }
}

export const executeInteractiveCommand: {
  (command: InteractiveCommand): (session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>
  (session: InteractiveSession, command: InteractiveCommand): Effect.Effect<void, OperationUnavailable>
} = Function.dual(2, executeInteractiveCommandImpl)
