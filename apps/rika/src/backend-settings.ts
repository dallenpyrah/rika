import { ConfigContract } from "@rika/config"
import { Effect, FileSystem, Schema } from "effect"

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => ConfigContract.ConfigFileError.make({ path: filename, message: String(error) })))
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      ConfigContract.ConfigFileError.make({ path: filename, message: `Invalid JSON: ${String(error)}` }),
    ),
  )
  return ConfigContract.decodeSettingsInput(filename, value)
})
