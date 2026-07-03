---
name: author-component
description: Use when adding a new component to the foldcn registry (apps/www/registry/ui). Encodes the port recipe from shadcn/ui, the three authoring patterns, the class translation rules, and the validation checklist.
---

# Authoring a foldcn registry component

Every foldcn component is a port of the matching shadcn/ui component's look onto a `@foldkit/ui` behavior primitive (or plain markup when shadcn's version has no behavior). Never reimplement behavior; if the primitive lacks a capability, document the gap and file it upstream against `@foldkit/ui`.

Before following any `FOLDKIT_ROOT/...` path, resolve `FOLDKIT_ROOT` from the Rika repository root: prefer `../foldkit`, then `repos/foldkit`, then fall back to installed package types under `apps/web/node_modules/@foldkit/ui` and say exemplar source is unavailable.

## Port recipe

1. Read the shadcn source: prefer the sibling checkout at `../ui/apps/v4/registry/new-york-v4/ui/<name>.tsx` from the Rika repository root. Collect every part's class string and `data-slot` name.
2. Read the primitive: `FOLDKIT_ROOT/packages/ui/src/<name>/index.ts`. Identify whether it is a stateless render helper (exports `view(config)` with a `toView` callback) or a Submodel (exports Model/Message/update and a RenderInfo of attribute groups).
3. Pick the pattern and copy its exemplar:
   - Pure markup: `apps/www/registry/ui/card.ts`
   - cva variants on markup: `apps/www/registry/ui/badge.ts`
   - Stateless wrapper: `apps/www/registry/ui/button.ts` or `input.ts`
   - Submodel wrapper: `apps/www/registry/ui/dialog.ts` (re-export machinery untouched; add `content(config, toChildren)` returning ViewInputs plus part functions)
4. Register the item in `apps/www/registry.json`: dependencies only for what the file imports, `registryDependencies: ['utils']` plus any foldcn components it imports.
5. Validate (all must pass): `bun run format && bun run lint && bun turbo typecheck build`, then `cd apps/www && bun ../../packages/foldcn/dist/bin.js build registry.json --output public/r`.

## Class translation rules (shadcn to FoldKit)

- Port class strings verbatim except the cases below. Fidelity to shadcn is the product.
- `disabled:` stays `disabled:` only when the primitive sets native `Disabled` (Input does). When the primitive uses `AriaDisabled` plus `data-disabled` (Button does), translate to `data-[disabled]:`. Check each primitive; disabled styling is bimodal.
- `data-[state=open]` / `data-[state=closed]` become the bare FoldKit attributes `data-open:` / `data-[closed]:` when wrapping Submodels; the primitive documents which data attributes it emits.
- shadcn's `animate-in`/`animate-out` (tw-animate-css) become transition classes on FoldKit's animation contract: `transition duration-200 ease-out data-[closed]:opacity-0 data-[closed]:scale-95`. These only fire when the consumer passes `isAnimated: true` to `init`.
- `data-slot="x"` becomes `h.DataAttribute('slot', 'x')` so shadcn's cross-component selectors (`has-data-[slot=card-action]`) keep working.
- Icons: inline `h.svg` with the lucide path data (see `xIcon` in dialog.ts). No icon library dependency.

## Hard rules

- One `h.Class` per element, always last in the attribute array, always `cn(base, variants, config.class)`. Consumer `attributes` spread before it.
- Imports from `@foldkit/ui` use subpath namespace imports: `import * as ButtonPrimitive from '@foldkit/ui/button'`. Aliased named imports are banned by ast-grep.
- Registry sources use the final consumer import paths (`@/lib/utils`, `@/components/ui/button`); the docs app maps those aliases onto the registry directories, so files are copied verbatim with no rewriting.
- FoldKit conventions apply: Effect Schema types, section-header comments only (`// MODEL`, `// MESSAGE`, `// UPDATE`, `// VIEW`), `Array<T>`, `Readonly<{...}>` inline object types, no abbreviations, verb-first past-tense Messages in any example code.
- Submodel wrappers must keep consumer wiring byte-identical to headless usage: same `h.submodel` shape, same `update` delegation, same OutMessage handling. foldcn adds styling only.
- Every stateful part that renders conditionally (`isVisible ? [...] : []`) follows the keyed-view rules from FoldKit's CLAUDE.md in demo code.

## Known pitfalls

- `title`/`description` parts of dialog-family components must round-trip the primitive's `titleId(model)`/`descriptionId(model)` so ARIA references resolve.
- Submodel ids must be document-unique; duplicate ids break the framework's resource cleanup.
- The alert-dialog cannot disable backdrop dismissal (the primitive bakes `OnClick(RequestedClose)` into the backdrop group); render the overlay without the backdrop attributes and document the difference.
