# Effect Module Conventions

## Services

Behavior-bearing modules export an `Interface`, a `Context.Service` class, tagged boundary errors, explicit live or adapter layers, and a test or memory layer.

Service methods and named workflows use `Effect.fn("Module.method")`. Generators bind services to named variables before method calls. Package internals return Effect values and never interpret them.

## Packages

Package entrypoints export intentional module namespaces. Non-index modules use named exports. External clients remain behind adapters and never cross domain-facing interfaces.

## CLI

Argument-bearing commands use `effect/unstable/cli`. Leaf modules export command values. The root command module exports `command` and `run(argv)`. The app entrypoint alone defines and interprets `main`.

## Errors

Failures crossing service boundaries use `Schema.TaggedErrorClass`. Foreign exceptions are normalized at the adapter boundary. Expected rejection, domain error, defect, interruption, and foreign failure remain distinguishable.

## Runtime

Use Effect primitives for config, concurrency, time, randomness, streams, scopes, retries, SQL, HTTP, and WebSockets. Raw platform calls are confined to adapters when no Effect primitive exists.
