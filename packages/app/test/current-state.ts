import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import { Effect, Function } from "effect"

export const executionRoute = () => Turn.testExecutionRoute()

type CreateInput = Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity"> & {
  readonly executionRoute?: Turn.ExecutionRoutePin
}

export const createTurn: {
  (
    input: CreateInput,
  ): (
    repository: TurnRepository.Interface,
  ) => Effect.Effect<TurnRepository.Submission, TurnRepository.QueueFull | TurnRepository.RepositoryError>
  (
    repository: TurnRepository.Interface,
    input: CreateInput,
  ): Effect.Effect<TurnRepository.Submission, TurnRepository.QueueFull | TurnRepository.RepositoryError>
} = Function.dual(2, (repository: TurnRepository.Interface, input: CreateInput) =>
  repository.createForSubmission({ executionRoute: executionRoute(), queueCapacity: 128, ...input }),
)
