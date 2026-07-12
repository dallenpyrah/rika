# Dynamic Workflows

## Definition

A Workflow is versioned, serializable Rika data compiled to supported Relay durable operations. It is not arbitrary model-generated TypeScript and does not expose Effect Workflow internals to the model.

## Supported Product Surface

Rika exposes only the built-in `delivery` and `research-synthesis` definitions through the `rika workflows` CLI. Users may start either definition with an explicit run id and inspect the same durable run later. Inspection is Relay-backed and reports the pinned revision and digest after restart.

The built-ins currently use sequence, bounded parallel fan-out, all-member join, and child execution. The compiler can encode additional closed Relay operation tags for compatibility testing, but Rika does not expose a generic workflow authoring product surface. In particular, conditional branches and human approval are not claimed as product behavior until a definition uses them with real conditions or permission decisions. Timer, retry, budget, cancellation, compensation, tool, and structured-completion tags are likewise not independently advertised as user-reachable primitives.

## Dynamic Behavior

Generic model-authored or user-authored dynamic workflow fragments are not a supported product surface.

## Replay

Executions pin the built-in workflow revision and digest. Relay-backed inspection recovers that durable identity and status without starting another run.

## Product Definitions

Rika compiles schema version 1 product data to Relay workflow definition version 2. The `delivery` workflow runs investigate, implement, review, fix, and verify child executions in sequence. The `research-synthesis` workflow dispatches grounded Oracle and Librarian children with bounded concurrency, durably joins all members, and then dispatches synthesis.

Registration creates immutable Relay revisions and each start may select a revision. Relay records the selected revision and digest on the run; inspection reports that pin after restart.

Relay remains responsible for operation state, fan-out admission, join policy, and process restart recovery used by the two built-ins. Rika owns validation, compilation, registration, start, and product-facing run inspection.
