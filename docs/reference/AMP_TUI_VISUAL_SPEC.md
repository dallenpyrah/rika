# Amp-Informed TUI Visual Acceptance Spec

## Purpose and evidence

This document turns visual references into character-cell acceptance criteria for Rika. It is a review oracle, not permission to copy Amp branding or strings. Rika's product baseline remains Rika v1 as required by `docs/spec/11-tui.md`.

Evidence used, in descending order of authority:

1. **Directly observed Amp:** the user-provided Amp screenshot and the local Amp captures under `rika-old/.claude/worktrees/rika-fixes/docs/parity/screenshots/amp/`. The inspected stable captures were `startup-empty-24-06.png` and `command-palette-open-41-04.png`.
2. **Directly observed current Rika:** the 80×24 and 50×10 character frames and deterministic cell-raster captures in `packages/tui/test/fixtures/visual/`, plus `metadata.json` and `packages/tui/src/theme.ts`.
3. **Inferred from old Rika:** the paired Amp/Rika parity captures and archived source under `/Users/dallen.pyrah/projects/rika-old`. An item labelled **[v1 inference]** is a design intent inferred from that archive, not an observed Amp requirement.

Host window chrome, font rasterization, terminal theme, and the apparent exact RGB values in PNGs are not normative. Cell positions, text, semantic color roles, and state contrast are normative. Coordinates below are zero-based `(column, row)`, measured in terminal cells.

## Shared geometry and color contract

- **[Observed: Amp and current Rika]** The terminal background is inherited. There is no application-wide filled panel.
- **[Observed: current Rika]** At 80×24, the transcript occupies rows 0–18 and the composer occupies rows 19–23. The composer is exactly 5 rows high and begins at column 0.
- **[Observed: current Rika]** Normal transcript content starts at column 0. A block title and its detail are separated by no blank row; detail starts two cells farther right. Adjacent blocks have one blank row.
- **[Observed: Amp]** Borders and primary prose use a light neutral; secondary instructions, paths, metadata, and inactive controls use a visibly dimmer neutral. Accent is reserved for identity, state, selection, and semantic content.
- **[Observed: current Rika]** Semantic RGB values are: text `#c9d1d9`, muted `#7d8590`, surface `#121212`, teal `#2dd4bf`, green `#98c379`, red `#e06c75`, amber `#d2a25c`, blue `#58a6ff`, purple `#ae77ff`; mode accents are low/amber, medium/blue, high/green, ultra/purple. Exact RGB comparison is valid only in the deterministic renderer.
- Every foreground/background pair must remain distinguishable in a monochrome character frame by glyph, label, or border; color alone may not encode status.
- No visible string may end beyond column `width - 1`, overwrite a border, or leave a half-rendered wide glyph. Trailing spaces are ignored for text review but not for cell-raster review.

## Acceptance criteria

### Startup

- **[Observed: Amp]** Empty startup has a large dotted mark paired with a welcome label, then two shortcut hints: command palette and shortcuts.
- **[Observed: current Rika]** At 80×24, the animated mark/help group fits rows 3–18, `Welcome to Rika` appears on row 8, and hints appear on rows 11 and 12. It is centered in the space above the composer, not the whole terminal.
- **[Observed: current Rika]** Empty startup contains no persistent header, sidebar, `Threads`, transcript rail, or “Local durable coding agent” copy. The composer remains anchored at row 19 through every animation phase.
- Animation may change mark cells and their colors only. Its non-space bounds may not move by more than 1 cell between phases; welcome copy, hints, and composer must not move.
- **[v1 inference]** Preserve the dot-field silhouette and mode-tinted identity rather than reproducing Amp's letterform or `Welcome to Amp` string.

### Command palette

- **[Observed: Amp]** The palette is a bordered overlay titled `Command Palette`, with a one-cell inset, contiguous result rows, a query line beginning `>`, aligned category/command/shortcut columns, and a full-row selected state with contrasting foreground.
- **[Observed: current Rika]** Opening the palette does not move the composer. At 80×24 its content starts at row 4 and is limited to 10 rows. Query and title share the first line in the current fixture; results begin two rows below it. The selected item begins with `›`, non-selected items with a space.
- Palette width must be `min(available width, 84)` cells, centered horizontally when narrower than the terminal. It must leave at least one cell between content and every border.
- Result labels must start in one shared column. Shortcut text, when present, must be right-aligned one cell inside the border. Selection must remain identifiable by `›` even when background colors are unavailable.
- Filtering must not resize the overlay. Empty results retain the title/query and show an explicit empty state rather than stale rows.

### Composer

- **[Observed: Amp and current Rika]** The composer is bottom-anchored, full-width, five rows high, with rounded single-line corners `╭╮╰╯`, three editable interior rows, and cutouts in the right border for state/mode and Workspace.
- At width `W >= 51`, top border is row `H - 5`, bottom border is row `H - 1`, input starts at `(1, H - 4)`, mode/state ends one cell before the top-right corner, and Workspace ends one cell before the bottom-right corner.
- Empty input has no placeholder competing with the cursor. Multiline input wraps inside columns `1..W-2` and never displaces the five-row box; overflow scrolls within it.
- **[Observed: current Rika]** Idle state shows mode (`high` in fixtures); active execution shows `working`. Workspace is muted and uses `/workspace` in fixtures. Labels must be clipped from the left with an ellipsis before they collide; preserve at least 8 editable cells.
- Border and label colors follow mode while working remains semantically distinct. Focus, mode, and working state must remain legible without color.

### Transcript text and Markdown

- **[Observed: Amp]** Transcript prose is flat against the inherited background; it is not wrapped in chat bubbles.
- Assistant prose starts at column 0 and wraps at `W` without inserting a speaker label. User prompts use a stable leading rail/glyph and one following space. Wrapped user lines align with the first prompt character, not the rail.
- Markdown headings use weight/color rather than additional boxes; heading markers are not shown. Paragraphs have one blank row between them. Unordered lists use one glyph plus one space and hanging indentation; nested levels add two cells. Ordered-list continuation aligns after the number and period.
- Inline code is a distinct neutral style without changing cell count. Fenced code has one blank-row boundary from prose, preserves source indentation, and horizontally clips or wraps consistently; it must never overwrite the composer.
- Block quotes use a one-cell rail and one-cell gap. Tables are accepted only if every border and cell fits; below the minimum table width they degrade to readable rows rather than horizontal corruption.
- **[v1 inference]** Syntax color is useful hierarchy, not decoration: plain text remains readable when all syntax colors collapse to foreground.

### File paths

- **[Observed: Amp and current Rika]** Paths are secondary text and appear beneath tool titles, in diff titles, or in the composer's bottom-right cutout; they are not standalone bright headings.
- A detail path begins two cells after its card title's leading glyph. Workspace paths are one line. When too long, preserve the basename and nearest parent using left ellipsis (`…/parent/file.ts`). Never split a path across rows unless it appears in prose.
- Git branch text, when available, follows one space after the Workspace path and is clipped before the path basename. **[Observed: Amp]** The inspected composer displayed a Workspace path followed by `(main)`.

### Diffs

- **[Observed: current Rika]** A diff block title is `Δ {path}` at column 0. Changed lines immediately follow: deletion begins `-`, addition begins `+`, with no extra card border or blank row.
- Deletions use red and additions green; unchanged/context lines use primary or muted neutral. Color is supplemental because the first-cell marker is mandatory.
- Every visible source line reserves column 0 for its marker. Source begins at column 1. Long lines clip with `…` in the last cell; they do not wrap and visually detach from their marker.
- Multi-hunk diffs show a muted hunk header and one blank row between files, not between lines. Empty, binary, and truncated diffs must state that condition explicitly.

### Tool calls and expandable cards

- **[Observed: current Rika]** A tool call is flat: `◆ {tool}` at column 0 and detail on the next row at column 2. `Read` with `src/main.ts` is the canonical fixture.
- Running, succeeded, denied, and failed states must have distinct glyph or suffix in addition to color. A collapsed card is at least one title row; an expanded card places detail/output beneath it with two-cell indentation.
- Expand/collapse may add or remove rows below the title but may not move the title horizontally. The title indicates affordance with a chevron or explicit collapsed label. Focus is visible independently from execution status.
- Output is bounded to the transcript width and configured row limit. Truncation ends with a dedicated muted line reporting omitted content; it must not masquerade as tool output.

### Reasoning

- **[Observed: current Rika]** Collapsed reasoning is exactly `◇ Reasoning (collapsed)` on one row. Expanded reasoning is `◇ Reasoning`, followed immediately by content indented two cells.
- Reasoning is muted relative to assistant answers. Streaming may update expanded content without changing the title row or composer position. Collapse must remove all reasoning body cells on the next frame.
- Reasoning content follows transcript wrapping rules and cannot be the sole carrier of an error or required user action.

### Errors

- Errors use a red semantic accent plus a non-color marker and a concise title. Detail begins on the next row at column 2. Stack traces and provider payloads are collapsed by default.
- Recoverable errors include an explicit retry/next-action line; terminal errors identify the failed Turn. A one-line error may not be represented only by a red tint.
- Error blocks must not replace or obscure the composer, palette dismissal control, or pending permission choice.

### Permissions

- **[Observed: current Rika]** Permission title is `? {operation} [pending]` at column 0; target/detail is directly below at column 2.
- Pending permissions expose `Allow once`, `Always`, and `Deny` in a stable order. Exactly one choice has a cursor glyph or inverse selection. Keyboard hints may be appended but cannot replace labels.
- Resolution changes `[pending]` to an explicit approved/always/denied status and removes active choice styling. Denial uses red; approval uses green; status text remains mandatory.
- Long targets follow file-path clipping. Permission controls stay above the composer and must be reachable at 50×10.

### Narrow layouts

- **[Observed: current Rika]** The narrow oracle is 50×10. The composer occupies rows 5–9, still exactly five rows. The mode cutout is on row 5. Workspace is omitted because it cannot fit without collision. Input remains visible at `(1,6)`.
- At 50 columns, startup art may crop or simplify, but may not overlap the composer, welcome copy, or controls. Overlays become full-width and may replace decorative startup content.
- At widths below 50, retain in priority order: composer border/input, pending permission/error action, newest transcript text, status/mode, then decorative art and Workspace. No two labels may share cells.
- Transcript wrapping is recomputed on resize. Resize must not duplicate content, alter source text, or leave cells from the wider frame.

## Screenshot and PTY review protocol

1. Define a semantic scenario from fixed input/event data before capturing: empty startup, palette query/selection, multiline composer, prose/Markdown, long path, multi-hunk diff, running and expanded tool, collapsed/expanded reasoning, error, each permission result, and 50×10 narrow state.
2. Capture from a clean packaged process through a real PTY at fixed sizes: 80×24 and 50×10, plus one wide size such as 120×32. Record OS, terminal, font, cell dimensions, color profile, Rika revision, Bun, and OpenTUI versions. Disable terminal transparency and unrelated prompts; do not normalize away application escape sequences.
3. Capture the PTY character grid and an independent terminal screenshot from the same run. Wait for a declared semantic state or stable event cursor, never an arbitrary sleep. For animation, capture a full cycle and check the movement bound.
4. Review the character grid first against this document's coordinates, glyphs, wrapping, clipping, and collision rules. Review the screenshot second for semantic color roles, contrast, hierarchy, and border continuity. Font antialiasing is not a product failure.
5. Compare Amp only to the archived/user-provided evidence named above and old Rika only to its archived captures. Never use a screenshot generated by the revision under review as its own oracle. Current `packages/tui/test/fixtures/visual` files are regression evidence, not proof that their design is correct.
6. A baseline update requires: the pre-change external/reference image, the candidate PTY grid and screenshot, a written cell-level delta, the criterion authorizing each delta, and reviewer approval. Generate approved fixtures only after that review; do not run an update command and then inspect the files it produced as the sole approval step.
7. Pass requires zero unexplained character-cell differences for deterministic scenarios, no clipping/collision failures at any size, and human approval of color-role differences. Pixel-perfect comparison is permitted only for deterministic cell rasters; host screenshots use annotated visual review.

## Known evidence limits

- The available Amp captures directly establish startup, palette, composer, broad palette roles, and flat terminal composition. They do not directly establish every Markdown, diff, tool, error, reasoning, or permission detail above.
- Criteria in those areas are therefore based on directly observed current Rika fixtures and are labelled as such; old-Rika-derived intent is explicitly marked **[v1 inference]**.
- PNG sampling cannot establish authoritative RGB values because terminal theme, color management, and capture encoding intervene. Rika theme constants are authoritative only for deterministic Rika rendering.
