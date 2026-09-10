# Calendar Heatmap Abstraction

> The dashboard heatmap is a single, two-mode component. The two
> modes share the same date / weekday / month / data plumbing but
> differ in how the time range is computed. They MUST NOT be mixed.

## The two modes

| Mode | Time range | Columns | Year-padding | Use case |
|---|---|---|---|---|
| `rolling-52-weeks` | current week + previous 51 weeks | exactly **52** | n/a — only future days in the current week | recent activity (default) |
| `calendar-year` | Jan 1 .. Dec 31 of a given year | computed (52 / 53 / 54) | layout placeholders at the start / end of the year | historical annual review |

## What they share

- **`HeatmapDay`** — the per-cell structure. Every cell carries the
  `date` (YYYY-MM-DD, the business key), `value` (the number or
  `null`), `weekIndex`, `weekdayIndex`, and the two flag fields
  `inRange` / `isFuture` that disambiguate "no business data here"
  from "no activity".

- **Monday-first weeks**. Mon = 0, Sun = 6, internal conversion
  `(Date.getDay() + 6) % 7` because `Date.prototype.getDay()` is
  Sun = 0.

- **Display timezone (UTC+8)**. The whole module operates in the
  display timezone; mixing UTC and local math produces off-by-one
  errors in the date / weekday / month positions. There is exactly
  one place that converts from a UTC ms to a YYYY-MM-DD string
  (`isoDayUtc8` in `src/dashboard/heatmap.ts`).

- **Month labels**. Each label is anchored to the **week column that
  contains the 1st day of the month**, NOT to the column whose
  Monday is in that month. This keeps "9月" on the right column when
  the month starts mid-week. Labels are date semantics: the renderer
  NEVER drops a label near the left or right edge (e.g. 9月 anchored
  to the last rolling column) — layout concerns are solved in CSS.

- **Shared week-column layout**. The `.months` row uses the SAME CSS
  grid week tracks as the `.heatmap` grid (`--week-count` variable set
  inline by the consumer; both rules use
  `grid-template-columns:repeat(var(--week-count, 52), 1fr)`). Tracks
  are `1fr` so the heatmap fills the full content width (cells stretch,
  height stays 10px); a label's inline `grid-column` therefore lands
  exactly above its week column. `display:flex` /
  `justify-content:space-between` would silently ignore the anchoring
  and is contract-forbidden.

- **Cells carry their position facts**. Every rendered cell has
  `data-week` / `data-weekday` plus an explicit inline
  `grid-column` / `grid-row` placement derived from the `HeatmapDay`
  itself — layout never depends on DOM order or `grid-auto-flow`, so
  52 / 53 / 54-column grids all use the same renderer. Three visual
  states are distinguished in CSS: real 0-activity days (level-0
  background), future days (`data-future="1"`, empty), and
  out-of-range padding (`data-inrange="0"`, nearly transparent).

- **Data lookup is by date, not position**. The renderer reads the
  `daily` Map by the cell's `date` key. Never use a visual position
  to look up business data.

## What they do NOT share

| Concern | `rolling-52-weeks` | `calendar-year` |
|---|---|---|
| Range start | `currentWeekStart - 51 weeks` | `YYYY-01-01` |
| Range end | `currentWeekStart + 6 days` | `YYYY-12-31` |
| Year-padding cells | n/a | YES (Dec of prev year / Jan of next year) |
| Future-day cells | YES (rest of current week) | YES (rest of current year) |
| `inRange` semantics | `iso >= rangeStartIso` | `iso >= rangeStart && iso <= rangeEnd` |
| `isFuture` semantics | `iso > today` | `iso > today` (only meaningful when inRange) |
| Number of columns | exactly 52 | derived (depends on year layout) |
| Month labels | every month-start in the window | exactly 12 (1..12) |

## Three cell states — never collapse them

The two booleans are independent:

| `inRange` | `isFuture` | Meaning | `value` |
|---|---|---|---|
| `true` | `false` | active day | the business number (or `0`) |
| `true` | `true` | in the range but after today | `null` |
| `false` | (n/a) | layout padding | `null` |

Do NOT render all of these as `value = 0`. Zero is a real number
(no activity on that day). `null` is "we don't have business data
for this day, by design" — and it keeps the cell visually empty
without polluting the max / level calculation.

## API

```ts
buildCalendarHeatmap({
  mode: 'rolling-52-weeks' | 'calendar-year',
  today: number | Date,                  // UTC ms OR a Date instance
  year?: number,                          // required for `calendar-year`
  data?: Map<string, { total: number, requests: number }>,
  valueKey?: 'total' | 'requests',
}): {
  weeks: HeatmapDay[][],                  // [weekIndex][weekdayIndex]
  monthLabels: { year, month, weekIndex }[],
  rangeStart: 'YYYY-MM-DD',
  rangeEnd: 'YYYY-MM-DD',
  mode,
}
```

The renderer (`src/dashboard/heatmap-view.ts`) is the single source
of truth for the HTML output. It emits a `<i class="cell" ...>`
tag per day with `data-week`, `data-weekday`, an explicit inline
`grid-column` / `grid-row` placement, `data-level`, `data-date`,
`data-future`, `data-inrange`, `data-tooltip`, and `aria-label`
attributes that the dashboard's tooltip layer and CSS hook into
without touching the date / weekday logic. Month labels are emitted
as `<span style="grid-column:N">M月</span>` — real grid positions
inside the shared `.months` week tracks.

## Tests

- `scripts/calendar-heatmap-test.mjs` — utility contract:
  rolling-52-weeks, calendar-year (exact column counts incl. 54-column
  years), month-label anchoring, month boundaries, leap year, UTC+8
  day boundary, in-range / out-of-range / future / historical edges.
- `scripts/calendar-heatmap-view-test.mjs` — HTML output contract:
  cell count, level quantization, future-cell tooltips, explicit cell
  placement, right-edge label survival, attribute surface.
- `scripts/calendar-heatmap-contract-test.mjs` — C01–C15 spec table
  (52 columns, Monday-first, YYYY-MM-DD keys, future ≠ zero,
  monthStart anchoring, no edge drops, exact calendar-year counts,
  padding/future/historical semantics, UTC+8 boundary,
  renderer/builder same column, shared `--week-count` CSS grid).
- `scripts/token-usage-test.mjs` — legacy 364-cell / 12-month-label
  contract is preserved through `buildHeatmap`'s thin adapter.
