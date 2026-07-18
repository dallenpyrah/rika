# Usage and cost

Rika derives model cost from Relay `model.usage.reported` events and exposes totals per Turn, Thread, and terminal session. Reported provider cost is authoritative; token-only reports use the matching model tier. Child Run usage is attributed to its parent Turn and Thread by traversing Relay's durable child tree.

Each usage cursor is counted once, so replay and recovery do not duplicate cost. Thread totals cover all of that Thread's Turns. The terminal's global total covers Turns found in its bounded load of up to one hundred Threads. Transcript pages carry the projected Turn cost and authoritative Thread total; missing or malformed usage reports remain unknown or zero rather than being estimated from transcript text.
