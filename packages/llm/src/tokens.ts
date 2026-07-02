import type * as Provider from "./provider"

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const estimateMessages = (messages: ReadonlyArray<Provider.Message>): number =>
  estimateTokens(JSON.stringify(messages))
