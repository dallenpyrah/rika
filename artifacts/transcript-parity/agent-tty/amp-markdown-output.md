---
title: Markdown rendering reference
threadId: T-019f6c43-c398-71ea-8286-3549846d1f1b
created: 2026-07-16T18:50:08.152Z
agentMode: low
---

# Markdown rendering reference

## User

Reproduce the following Markdown document verbatim as your entire reply. Do not use any tools. Do not add any commentary before or after it.

## Heading level one for the rendering reference

### Heading level two

#### Heading level three

##### Heading level four

###### Heading level five

###### Heading level six

This paragraph is intentionally long so it exercises soft wrapping at both the wide and narrow terminal widths. It mixes **bold text**, *italic text*, and `inline code` so a reviewer can confirm that emphasis runs and inline code spans survive the wrap boundary without breaking the surrounding flow of the sentence.

| Capability | Rika behavior | Amp behavior | Notes about the difference |
| --- | --- | --- | --- |
| Wide table cell wrapping | Renders inside a bounded rounded grid that keeps the border intact | Renders inside its own table frame with column separators | Both must keep every column aligned even when a cell is far longer than its header |
| Terminal background inheritance | Inherits the terminal background instead of painting its own | Inherits the terminal background instead of painting its own | This is the row that proves background parity across the two clients |
| Fenced code block styling | Preserves indentation and monospace alignment for every line | Preserves indentation and monospace alignment for every line | Long lines should be handled the same way by both renderers |

```typescript
export const renderReference = (input: ReferenceInput): Effect.Effect<Rendered, RenderError> =>
  Effect.gen(function* () {
    const width = yield* Terminal.currentWidth
    const wrapped = wrapParagraph(input.paragraph, width)
    const table = layoutTable(input.rows, { border: "rounded", inheritBackground: true })
    return { headings: input.headings, paragraph: wrapped, table }
  })
```

The closing paragraph adds one more long wrapping line so the reviewer can compare the blank-row rhythm between the code block above and this final block of prose in both clients.

## Assistant

## Heading level one for the rendering reference

### Heading level two

#### Heading level three

##### Heading level four

###### Heading level five

###### Heading level six

This paragraph is intentionally long so it exercises soft wrapping at both the wide and narrow terminal widths. It mixes **bold text**, *italic text*, and `inline code` so a reviewer can confirm that emphasis runs and inline code spans survive the wrap boundary without breaking the surrounding flow of the sentence.

| Capability | Rika behavior | Amp behavior | Notes about the difference |
| --- | --- | --- | --- |
| Wide table cell wrapping | Renders inside a bounded rounded grid that keeps the border intact | Renders inside its own table frame with column separators | Both must keep every column aligned even when a cell is far longer than its header |
| Terminal background inheritance | Inherits the terminal background instead of painting its own | Inherits the terminal background instead of painting its own | This is the row that proves background parity across the two clients |
| Fenced code block styling | Preserves indentation and monospace alignment for every line | Preserves indentation and monospace alignment for every line | Long lines should be handled the same way by both renderers |

```typescript
export const renderReference = (input: ReferenceInput): Effect.Effect<Rendered, RenderError> =>
  Effect.gen(function* () {
    const width = yield* Terminal.currentWidth
    const wrapped = wrapParagraph(input.paragraph, width)
    const table = layoutTable(input.rows, { border: "rounded", inheritBackground: true })
    return { headings: input.headings, paragraph: wrapped, table }
  })
```

The closing paragraph adds one more long wrapping line so the reviewer can compare the blank-row rhythm between the code block above and this final block of prose in both clients.
