import type { Provider } from "@rika/llm"
import { Event, Message } from "@rika/schema"

export const messagesFromEvents = (events: ReadonlyArray<Event.Event>): ReadonlyArray<Provider.Message> =>
  events.flatMap((event) => {
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
