import { ThreadTools } from "@rika/tools"
import { Effect } from "effect"
import { Service } from "./thread-query"

const error = (tool: string, cause: { readonly _tag: string }) =>
  ThreadTools.ToolError.make({ tool, message: JSON.stringify(cause) })

export const handlerLayer = ThreadTools.toolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* Service
    return {
      search_threads: (input) => query.find(input).pipe(Effect.mapError((cause) => error("search_threads", cause))),
      read_thread_transcript: (input) =>
        query.read(input).pipe(Effect.mapError((cause) => error("read_thread_transcript", cause))),
    }
  }),
)
