import type { Provider } from "@rika/llm"
import { Event, Message, Tool } from "@rika/schema"
import { Prompt } from "effect/unstable/ai"

export const summaryPrefix = "[Conversation summary — earlier context was compacted]"

export const messagesFromEvents = (events: ReadonlyArray<Event.Event>): ReadonlyArray<Provider.Message> =>
  withCompaction(events, (compaction, tail) => [
    ...(compaction === undefined ? [] : [summaryProviderMessage(compaction)]),
    ...tail.flatMap((event) => providerMessagesFromEvent(event)),
  ])

export const promptMessagesFromEvents = (events: ReadonlyArray<Event.Event>): ReadonlyArray<Prompt.MessageEncoded> =>
  withCompaction(events, (compaction, tail) => [
    ...(compaction === undefined ? [] : [summaryPromptMessage(compaction)]),
    ...tail.flatMap((event) => promptMessagesFromEvent(event)),
  ])

export const providerMessageToPromptMessage = (message: Provider.Message): Prompt.MessageEncoded => {
  switch (message.role) {
    case "system":
    case "developer":
      return { role: "system", content: providerContentText(message.content) }
    case "assistant":
      return { role: "assistant", content: providerContentText(message.content) }
    case "tool":
    case "user":
      return { role: "user", content: providerContentToPromptParts(message.content) }
  }
  return { role: "user", content: providerContentToPromptParts(message.content) }
}

const withCompaction = <A>(
  events: ReadonlyArray<Event.Event>,
  assemble: (compaction: Event.ContextCompacted | undefined, tail: ReadonlyArray<Event.Event>) => ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const compaction = events.findLast((event): event is Event.ContextCompacted => event.type === "context.compacted")
  if (compaction === undefined) return assemble(undefined, events)
  return assemble(
    compaction,
    events.filter((event) => event.sequence >= compaction.data.tail_start_sequence),
  )
}

const providerMessagesFromEvent = (event: Event.Event): ReadonlyArray<Provider.Message> => {
  switch (event.type) {
    case "message.added":
      return messageToProviderMessages(event.data.message)
    case "tool.call.completed": {
      const message: Provider.Message = { role: "tool", content: JSON.stringify(event.data.result) }
      return [message]
    }
    default:
      return []
  }
}

const promptMessagesFromEvent = (event: Event.Event): ReadonlyArray<Prompt.MessageEncoded> => {
  switch (event.type) {
    case "message.added":
      return messageToPromptMessages(event.data.message)
    case "tool.call.requested":
      return [toolCallPromptMessage(event.data.call)]
    case "tool.call.completed":
      return [toolResultPromptMessage([event.data.result])]
    default:
      return []
  }
}

const summaryProviderMessage = (event: Event.ContextCompacted): Provider.Message => ({
  role: "user",
  content: `${summaryPrefix}\n${event.data.summary}`,
})

const summaryPromptMessage = (event: Event.ContextCompacted): Prompt.MessageEncoded => ({
  role: "user",
  content: `${summaryPrefix}\n${event.data.summary}`,
})

const messageToProviderMessages = (message: Message.Message): ReadonlyArray<Provider.Message> => {
  const content = Message.displayText(message)
  if (content.length === 0) return []
  switch (message.role) {
    case "system":
      return [{ role: "system", content }]
    case "assistant":
      return [{ role: "assistant", content }]
    case "tool":
      return [{ role: "tool", content }]
    case "user":
      return [{ role: "user", content }]
  }
  return []
}

const messageToPromptMessages = (message: Message.Message): ReadonlyArray<Prompt.MessageEncoded> => {
  switch (message.role) {
    case "system":
    case "assistant": {
      const content = messageText(message)
      if (content.length === 0) return []
      return [{ role: message.role, content }]
    }
    case "tool": {
      const content = messageText(message)
      if (content.length === 0) return []
      return [{ role: "user", content }]
    }
    case "user": {
      const content = userPromptParts(message)
      return content.length === 0 ? [] : [{ role: "user", content }]
    }
  }
  return []
}

const messageText = (message: Message.Message) => Message.displayText(message)

const userPromptParts = (message: Message.Message): ReadonlyArray<Prompt.UserMessagePartEncoded> =>
  message.content.flatMap((part): ReadonlyArray<Prompt.UserMessagePartEncoded> => {
    switch (part.type) {
      case "text":
        return part.text.length === 0 ? [] : [{ type: "text", text: part.text }]
      case "image":
        return [
          {
            type: "file",
            mediaType: part.media_type,
            fileName: part.filename,
            data: imageData(part.data),
          },
        ]
      default:
        return []
    }
  })

const toolCallPromptMessage = (call: Tool.Call): Prompt.MessageEncoded => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      id: call.id,
      name: call.name,
      params: call.input,
      providerExecuted: false,
    },
  ],
})

export const assistantToolPromptMessage = (content: string, calls: ReadonlyArray<Tool.Call>): Prompt.MessageEncoded => {
  const parts: Array<Prompt.AssistantMessagePartEncoded> = content.length === 0 ? [] : [{ type: "text", text: content }]
  for (const call of calls) {
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.name,
      params: call.input,
      providerExecuted: false,
    })
  }
  return { role: "assistant", content: parts }
}

export const toolResultPromptMessage = (results: ReadonlyArray<Tool.Result>): Prompt.MessageEncoded => ({
  role: "tool",
  content: results.map((result) => ({
    type: "tool-result",
    id: result.id,
    name: result.name,
    isFailure: result.status === "error",
    result:
      result.status === "success"
        ? (result.output ?? null)
        : (result.error ?? { kind: "tool", message: "Tool failed" }),
  })),
})

const providerContentText = (content: Provider.MessageContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

const providerContentToPromptParts = (
  content: Provider.MessageContent,
): string | ReadonlyArray<Prompt.UserMessagePartEncoded> => {
  if (typeof content === "string") return content
  return content.flatMap((part): ReadonlyArray<Prompt.UserMessagePartEncoded> => {
    if (part.type === "text") return part.text.length === 0 ? [] : [{ type: "text", text: part.text }]
    return [
      {
        type: "file",
        mediaType: part.media_type,
        fileName: part.filename,
        data: imageData(part.data),
      },
    ]
  })
}

const imageData = (data: string): Uint8Array => Buffer.from(data, "base64")
