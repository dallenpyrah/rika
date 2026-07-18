# Resident transport

Stateful clients use an authenticated, versioned WebSocket connection to the Resident Rika Service on loopback. The typed contract carries operations, interactive commands, output, heartbeats, sequenced feed events, acknowledgements, replay, resync, completion, and typed failures; identities, nonces, and connection identifiers prevent a client from attaching to the wrong resident.

Frames, fragments, feeds, and outbound queues are bounded. Feed overflow or an oversized live event requests an ordered resync from durable state instead of failing the Execution. A reconnect may restore reads, but a client does not automatically resend a mutation when its outcome is unknown.
