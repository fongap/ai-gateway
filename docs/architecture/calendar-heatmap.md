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
  (`isoDayUtc8` in `src/dashboard/heatmap.js`).

- **Month labels**. Each label is anchored to the **week column that
  contains the 1st day of the month**, NOT to the column whose
  Monday is in that month. This keeps "9月" on the right column when
  the month starts mid-week.

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

The renderer (`src/dashboard/heatmap-view.js`) is the single source
of truth for the HTML output. It emits a `<i class="cell" ...>`
tag per day with `data-level`, `data-date`, `data-future`,
`data-inrange`, `data-tooltip`, and `aria-label` attributes that
the dashboard's tooltip layer and future CSS can hook into without
touching the date / weekday logic.

## Tests

- `scripts/calendar-heatmap-test.mjs` — utility contract:
  rolling-52-weeks, calendar-year, month-label anchoring, leap year,
  in-range / out-of-range / future / historical year edges.
- `scripts/calendar-heatmap-view-test.mjs` — HTML output contract:
  cell count, level quantization, future-cell tooltips, attribute
  surface.
- `scripts/token-usage-test.mjs` — legacy 364-cell / 12-month-label
  contract is preserved through `buildHeatmap`'s thin adapter.
