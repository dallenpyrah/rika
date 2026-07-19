# Usage and cost

Rika derives model cost from Relay `model.usage.reported` events and exposes totals per Turn, Thread, and terminal session. Only an event-local `cost_usd` or `costUsd` field reported by the provider is authoritative. Generic, nested, or cumulative cost fields are ignored. Token counts, context windows, and budgets are not prices and do not create cost. Child Run usage is attributed to its parent Turn and Thread by traversing Relay's durable child tree.

Each usage cursor is counted once, so replay and recovery do not duplicate cost. Thread totals cover all of that Thread's Turns. The terminal's global total covers Turns found in its bounded load of up to one hundred Threads. Transcript pages carry the projected Turn cost and authoritative Thread total; missing or malformed usage reports remain unknown or zero rather than being estimated from transcript text.
