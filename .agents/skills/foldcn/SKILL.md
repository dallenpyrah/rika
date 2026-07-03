---
name: foldcn
description: Use whenever adding or using foldcn components in a FoldKit app. Triggers on components.json in a project, imports from '@/components/ui/', or prompts mentioning foldcn or "shadcn for FoldKit". Covers the init/add workflow, wiring each component kind, the h.Class contract, and theming.
---

# foldcn

You are working with foldcn: shadcn/ui for FoldKit. Components are copy-in source files distributed via a registry and owned by the consuming project after `add`. Behavior and accessibility come from the headless `@foldkit/ui` primitives; foldcn is the styled layer over them. The mapping from shadcn: Radix is to shadcn what `@foldkit/ui` is to foldcn.

## Workflow

- `npx foldcn init` in a FoldKit app writes `components.json`, injects the `@/*` path alias into tsconfig.json and vite.config.ts, and installs the base theme and `cn` utils into the stylesheet and `src/lib/utils.ts`.
- `npx foldcn add button dialog card` copies components (and their registry dependencies) into `src/components/ui/`, installs npm dependencies, and merges any component CSS into the stylesheet.
- Components are yours after copy-in. Edit them freely; re-running `add` skips identical files and refuses to clobber local modifications without `--overwrite`.
- Third-party registries plug in through the `registries` map in components.json (`"@acme": "https://acme.dev/r/{name}.json"`) and are consumed as `foldcn add @acme/thing`.

## Three component kinds, three wiring shapes

1. **Pure markup** (card, badge, alert, separator, table, ...): typed functions over `h.*`. Call them inline in a view: `card({ class: 'w-full' }, [cardHeader({}, [cardTitle({}, ['Title'])])])`. Config is `{ class?, attributes? }` plus component options like `variant`.
2. **Stateless wrappers** (button, input, textarea): same call shape, plus behavior config forwarded to the `@foldkit/ui` render helper: `button({ variant: 'destructive', onClick: ClickedDelete() }, ['Delete'])`. No Model, no update wiring.
3. **Submodel wrappers** (dialog, tabs, popover, ...): namespace-import them (`import * as Dialog from '@/components/ui/dialog'`). They re-export the primitive's Model/Message/OutMessage/init/update untouched and add styled view builders. The consumer wires the standard FoldKit trio:
   - a Model field: `confirmDialog: Dialog.Model` initialized with `Dialog.init({ id: 'confirm-dialog', isAnimated: true })`
   - a wrapper Message: `GotConfirmDialogMessage = m('GotConfirmDialogMessage', { message: Dialog.Message })`
   - update delegation: call `Dialog.update(model.confirmDialog, message)`, store the next model with `evo`, and re-wrap emitted Commands with `Command.mapMessages`
   - render via `h.submodel({ slotId: model.confirmDialog.id, model, view: Dialog.view, viewInputs: Dialog.content(config, toChildren), toParentMessage })`

There are no trigger components. Any element can open a dialog by dispatching a Message whose update branch calls `Dialog.open(model.confirmDialog)`.

## The h.Class contract

FoldKit class handling is last-wins, not merged. Every foldcn component emits exactly one `h.Class`, placed last, built with `cn()`. Consequences:

- Style through the `class` config field only. It merges with the component's base classes via tailwind-merge, so `button({ class: 'h-12' })` overrides the height.
- Never pass `h.Class` inside an `attributes` array; it will be discarded.
- `attributes` is the escape hatch for ids, handlers, and attribute groups published by primitives (for example a dialog's `close` attributes spread onto any button).

## Theming

Tokens are shadcn's exactly: `--background`, `--primary`, `--radius`, chart and sidebar tokens, defined in `:root` and `.dark`, mapped through `@theme inline`. Any shadcn theme generator output (ui.shadcn.com/themes, tweakcn) pastes directly into the stylesheet. Dark mode is the `.dark` class. Animations use FoldKit's transition contract: `data-[closed]:opacity-0` style classes activate only when the Submodel was initialized with `isAnimated: true`.

## Where to look

- The registry source of truth: `apps/www/registry/ui/` in the foldcn repo; each file is the exact artifact consumers receive.
- Component behavior contracts: the `@foldkit/ui` package source (each component documents its ViewConfig or RenderInfo).
- FoldKit conventions: the `foldkit` skill and the vendored foldkit repo.
