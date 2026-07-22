import { Effect, Layer, Ref } from "effect"
import { Input, Service } from "../operation-contract"

export const testLayer = (calls: Ref.Ref<ReadonlyArray<Input>>) =>
  Layer.succeed(
    Service,
    Service.of({
      run: Effect.fn("Operation.test.run")(function* (input) {
        yield* Ref.update(calls, (current) => [...current, input])
      }),
    }),
  )
