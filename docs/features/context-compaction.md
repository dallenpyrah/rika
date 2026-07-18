# Context compaction

Baton compacts an Execution when its pinned route approaches the context window, reserving the route's output allowance. It first bounds old tool output, then keeps a recent token range, then creates a structured summary using the pinned summary route when configured.

Compaction preserves the current prompt and durable transcript. The pinned policy and summary route pass through the Relay execution contract, so durable execution owns compaction state across restart and replay.
