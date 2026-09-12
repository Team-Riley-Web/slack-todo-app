# Team Riley Tasks — brand specification

The interface keeps the existing product's cool graphite rail, quiet near-white
workspace, and blue selection colour. This revision (2026-09-12) changes colour
only: layout, spacing, row density and interactions are unchanged.

The gray, blue and lavender the interface already used were directionally right
but too close in value across large surfaces. Each family now has exactly one
job:

- **Gray** separates the canvas, the cards, and the space-group headers.
- **Lavender** identifies table-column scaffolding only.
- **Cobalt** carries both selected navigation and the primary action.
- **Semantic** pill colours communicate time pressure without tinting the rows.

## Core palette

| Role | Hex | OKLch | Usage |
|---|---|---|---|
| Canvas | `#F7F8FC` | `oklch(0.9795 0.0054 274.97)` | Page background |
| Surface | `#FFFFFF` | `oklch(1 0 89.88)` | Cards, inputs, rows |
| Primary text | `#202533` | `oklch(0.2660 0.0273 269.25)` | Headings and task titles |
| Secondary text | `#667085` | `oklch(0.5444 0.0350 265.11)` | Secondary labels, inactive controls |
| Border | `#DDE1EA` | `oklch(0.9093 0.0130 266.69)` | Card, input and row dividers |
| Cobalt | `#4169E1` | `oklch(0.5598 0.1882 266.40)` | Active navigation and New task |
| Rail | `#1C2230` | `oklch(0.2527 0.0281 266.45)` | Sidebar background |
| Rail text | `#C7CDD8` | `oklch(0.8470 0.0166 262.75)` | Inactive sidebar labels |
| Rail muted | `#8992A3` | `oklch(0.6583 0.0274 263.26)` | Counts and group labels |

Two steps exist alongside the core values and are not new colours:

- `#3156CC` — cobalt as TEXT on a light surface (links, the primary button's
  hover). Cobalt itself is 4.85:1 on white, which passes, but falls to 4.25:1
  on the lavender column band; this step clears it everywhere and lets a hover
  darken rather than lighten.
- `#4B5565` — secondary text where it sits on a tinted surface. `#667085` is
  4.32:1 on `#ECEFF4`, under the floor. It is the "No date" pill's own label.
- `#1D4899` — navy, for a task title under the pointer. Cobalt there reads as
  a bright link in a column of near-black titles; this sits at 8.1:1 on the
  hover fill, a small step from the `#202533` around it. It is the selected
  Today pill's own hover.

## Structural surfaces

| Element | Background | Foreground / border |
|---|---|---|
| Space-group header | `#ECEFF4` | `#202533` / `#DDE1EA` |
| Table-column header (Open) | `#EEEFFF` | `#49466A` / `#DADCF5` |
| Table-column header (Waiting) | `#F1E4FF` | `#56436C` / `#E3D2F9` |
| Task-row hover / focus | `#F5F7FF` | Title steps to navy `#1D4899`; other cells unchanged |
| Task row open in the pane | `#E8F0FF` | 3px cobalt inset left edge; quiet cells step to `#4B5565` |
| Card | `#FFFFFF` | `#DDE1EA` |

Task rows carry no permanent tint — no zebra striping. White rows against the
cool-gray canvas separate well enough. The only tones a row takes are transient
and each says something: the pointer (or keyboard focus) is here, and this is
the task the edit pane is showing. Hover is the fainter of the two, so with a
task open you can run the pointer down the list without losing the row you are
editing.

Open and Waiting bands are told apart by hue, not by value: the Waiting band
steps round the wheel to violet (305°) at the lightness and weight of the
lavender (283°) it sits beside. A darker band of the same colour would read as
"more important", and blocked work is a different kind of work, not a louder
one. Their card summaries both take the space-group gray — the band is where
the distinction lives.

## Due-filter pills

| State | Background | Text | Border |
|---|---|---|---|
| Today · rest | `#E8F0FF` | `#2456B8` | `#C8D9FF` |
| This week · rest | `#EAF8F1` | `#147A50` | `#C9EAD9` |
| Overdue · rest | `#FFF0F0` | `#B4232A` | `#F4CACA` |
| No date · rest | `#F3F4F7` | `#4B5565` | `#DDE1EA` |

Selected: the pill's own text colour becomes the solid background and the label
turns white. Hover darkens the background and keeps the foreground exactly
where it was; a pill never fades its own text. Size and radius are unchanged.

Hover fills: `#D9E5FF`, `#DDF2E6`, `#FFE1E1`, `#E9EBF0`. Selected hovers:
`#1D4899`, `#0F6341`, `#941C22`, `#3B4453`.

## Priority

Priority is drawn in the tick circle at the left of a row, not in a column of
its own: a list is scanned left to right, and urgency is the signal worth
catching first.

| Level | Ring | Digit |
|---|---|---|
| P0 | filled `#B4232A` | white `0` |
| P1 | `#B54708` | `#B54708` `1` |
| P2 | `#2456B8` | `#2456B8` `2` |
| P3 | `#4B5565` | `#4B5565` `3` |
| none | `#868FA1` | — |

The colours are the due pills' own inks, so nothing new enters the palette.
P0 is filled rather than ringed because "critical" has to outrank "high" at a
glance. That red appears on `P0` and on an overdue date, and nowhere else.

Under the pointer the digit gives way to the check: the circle is still the
control that completes the task, and what it is about to do outranks what it
is telling you.

## Typography

- Body: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, system-ui, sans-serif
- Mono: `ui-monospace`, `SFMono-Regular`, `SF Mono`, Menlo, monospace

No display face. An earlier revision of this spec listed a serif (Iowan Old
Style, Charter, Georgia); it was applied and rejected on sight. One sans stack
sets everything.

## Rules

- The active sidebar item and the New task button are the same cobalt.
- Canvas, white cards, gray group headers and lavender column headers are
  visibly distinct at a glance.
- Pill states are understandable without colour: the labels stay explicit.
- A task row shows the task title and nothing beneath it.
- Normal text is at least 4.5:1; icons and large text at least 3:1.
- Hover and selected states never make text lighter against a light background.
- No gradients, no extra accent colours.
- Blue is reserved for selection and the single primary action; task status
  uses form and language before extra colour.
- Editing happens in a right-side pane while the list remains visible.
