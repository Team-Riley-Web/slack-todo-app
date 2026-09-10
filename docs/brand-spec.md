# Team Riley Tasks — brand specification

The interface keeps the existing product's cool graphite rail, quiet near-white workspace, and clear cornflower-blue selection color, then tightens the system around typography and spacing.

## Core tokens

```css
:root {
  --bg: oklch(0.9913 0.0013 286.38);
  --surface: oklch(1 0 89.88);
  --fg: oklch(0.2681 0.016 264.26);
  --muted: oklch(0.551 0.0234 264.36);
  --border: oklch(0.9303 0.0046 258.33);
  --accent: oklch(0.6493 0.1862 266.03);
}
```

## Typography

- Display: `Iowan Old Style`, `Charter`, `Georgia`, serif
- Body: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, system-ui, sans-serif
- Mono: `ui-monospace`, `SFMono-Regular`, `SF Mono`, Menlo, monospace

## Observed visual rules

- A dark graphite navigation rail carries team context, primary views, spaces, and utilities.
- Blue is reserved for selected state and the single primary action; task status uses form and language before extra color.
- Task rows are compact, left-aligned, and separated by hairlines instead of card borders around every item.
- Secondary metadata sits directly below task titles and uses a quieter value than column labels.
- Editing happens in a right-side pane while the list remains visible as context.
