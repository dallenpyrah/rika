import * as OpenAiAuth from "../openai-auth"
import { Console, Context, Effect, Layer } from "effect"
import { OperationUnavailable } from "../operation-contract"
import type { Input } from "../operation-contract"
import type { AuthOperationOptions } from "./options"
const unavailable = (input: Input, message = `${input._tag} is specified but not implemented yet`) =>
  OperationUnavailable.make({ operation: input._tag, message })

export const runAuth = Effect.fn("Operation.runAuth")(function* (
  input: Extract<Input, { readonly _tag: "Auth" }>,
  options: AuthOperationOptions,
  defaultWorkspace: string,
) {
  if (input.action === "login") {
    yield* options
      .assertOpenAiDirect(input.clientWorkspace ?? defaultWorkspace)
      .pipe(Effect.mapError((error) => unavailable(input, error.message)))
  }
  const context = yield* Layer.build(options.layer).pipe(Effect.mapError((error) => unavailable(input, String(error))))
  const auth = Context.get(context, OpenAiAuth.Service)
  if (input.action === "login") {
    yield* (input.deviceCode === true ? auth.loginDevice : auth.loginBrowser()).pipe(
      Effect.flatMap(() => Console.log("OpenAI account login complete.")),
      Effect.mapError((error) => unavailable(input, error.message)),
    )
    return
  }
  if (input.action === "logout") {
    const result = yield* auth.logout.pipe(Effect.mapError((error) => unavailable(input, error.message)))
    yield* Console.log(
      result.removed
        ? "OpenAI account credentials removed. Server revocation is not supported."
        : "No OpenAI account credentials were stored. Server revocation is not supported.",
    )
    return
  }
  const status = yield* auth.status.pipe(Effect.mapError((error) => unavailable(input, error.message)))
  yield* Console.log(
    status._tag === "Unauthenticated"
      ? "OpenAI account: unauthenticated"
      : status._tag === "Present"
        ? "OpenAI account: credentials present (remote validity not checked)"
        : status._tag === "RefreshRequired"
          ? "OpenAI account: refresh required (remote validity not checked)"
          : "OpenAI account: credential store is corrupt; log in again after removing it",
  )
})
