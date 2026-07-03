---
name: use-foldkit-mcp
description: Operates the FoldKit devtools MCP against a running FoldKit app — read the live Model, drive Messages, and time-travel through history from an agent. Use when debugging a running FoldKit app, wiring up the devtools MCP relay, or driving an app's Model/Messages from an agent. Triggers: "foldkit MCP", "devtools MCP", "foldkit_get_model", "dispatch a message", "inspect the running app", "why is the model wrong", "replay/time-travel", "list_runtimes".
---

# Use the FoldKit devtools MCP

`@foldkit/devtools-mcp` exposes a **running** FoldKit app to MCP agents through a vite-plugin relay: the dev server hosts the app's live runtimes, and the MCP server bridges your agent to them. Read-only tools (get the Model, list Messages, replay history) work the moment the relay is up. Dispatching a Message additionally requires the app to have passed its `Message` schema into `devTools`, so the server can decode what you send.

This is state- and message-oriented, not visual: there are no screenshots. Pair it with browser automation when you need to confirm what the user actually sees.

## Wire an app for the MCP

Three edits, then restart both the dev server and the agent.

1. **Vite plugin** — open the relay on a chosen port:

   ```ts
   import { foldkit } from "@foldkit/vite-plugin"

   export default defineConfig({
     plugins: [foldkit({ devToolsMcpPort: 9988 })],
   })
   ```

2. **App entry** — pass `devTools` into the runtime. `overlay` (from `@foldkit/devtools`) is the optional in-page inspector; `Message` is the app's Message schema and is what unlocks `dispatch_message` — without it, dispatch is unavailable and only read tools work.

   ```ts
   import { overlay } from "@foldkit/devtools"

   Runtime.run(
     Runtime.makeApplication({
       init,
       update,
       view,
       devTools: { overlay, Message },
     }),
   )
   ```

3. **`.mcp.json`** — register the server so the agent launches it:

   ```json
   {
     "mcpServers": {
       "foldkit-devtools": {
         "command": "npx",
         "args": ["-y", "@foldkit/devtools-mcp"]
       }
     }
   }
   ```

   `npx @foldkit/devtools-mcp init` writes this entry for you.

Then restart the dev server and the agent so both pick up the changes.

- **Port**: the MCP server reads `FOLDKIT_DEVTOOLS_MCP_PORT`; it must match the `devToolsMcpPort` in the vite config. Override both together to move off the default.
- **Dev-only**: the relay is a dev-server concern — never ship `devToolsMcpPort` (or the overlay) in a production build.
- **Gotcha — tests hold the process open**: if your test runner loads the vite config, the relay port keeps the process alive and hangs the run. Gate it out of test runs, e.g. `foldkit(process.env.VITEST ? {} : { devToolsMcpPort: 9988 })`.

## Tool catalog

All tools are prefixed `foldkit_`. Every tool takes an optional `runtime_id` to target a specific runtime; omit it when only one runtime exists.

| Tool                    | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `list_runtimes`         | **Call first.** Lists the running app tabs/runtimes and their ids.                  |
| `get_model`             | Reads the current Model; narrow with a `path` and `expand` depth.                   |
| `get_model_at`          | Reads the Model at a historical message index.                                      |
| `get_init`              | Reads the initial Model (`init` result).                                            |
| `get_runtime_state`     | Reports runtime status (running, paused, message count).                            |
| `list_messages`         | Lists Messages; filters: `changed_paths_match`, `from_end`, `since_index`, `limit`. |
| `count_messages_by_tag` | Frequency of each Message tag — spot the hot path.                                  |
| `diff_models`           | Structural diff of the Model between `from` and `to` indices.                       |
| `get_message`           | Full decoded Message at an index.                                                   |
| `get_message_schema`    | The Message schema; narrow to one variant with `variant_tag` before dispatching.    |
| `list_keyframes`        | Lists recorded keyframes you can replay to.                                         |
| `replay_to_keyframe`    | Rewinds to a keyframe and **pauses** the runtime.                                   |
| `resume`                | Resumes a paused runtime.                                                           |
| `dispatch_message`      | Sends a Message (decoded against the schema) into the runtime.                      |

## The bug-hunting loop

1. `list_runtimes` → confirm the tab is there, grab its `runtime_id`.
2. `get_model` → read current state (narrow with `path`/`expand` on large models).
3. `get_message_schema` (with `variant_tag`) → `dispatch_message` → drive the action you're investigating.
4. `get_model` / `diff_models` → assert the transition did what you expected.
5. For high-frequency flows: `count_messages_by_tag` to find the busy tag → `list_messages` with `changed_paths_match` to keep only messages that touched a subtree → `from_end` to tail the recent ones → `diff_models` across an index pair to **bisect** exactly which Message mutated the wrong path.
6. To reproduce a past state: `list_keyframes` → `replay_to_keyframe` (pauses) → inspect with `get_model_at` / `get_message` → `resume`.

## Done when

- The MCP is configured (vite `devToolsMcpPort`, entry `devTools`, `.mcp.json`), the dev server and agent are restarted.
- `foldkit_list_runtimes` sees the running tab.
- You can read the Model and (if `Message` is wired) dispatch a Message and observe the resulting transition.

For driving the app's visual surface alongside state, use /agent-browser; for the program under inspection see /ui.
