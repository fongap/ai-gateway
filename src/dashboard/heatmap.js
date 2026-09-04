// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Calendar Heatmap — date-only grid builder.
//
// Two modes share the same date / weekday / month / data plumbing but
// differ in how the time range is computed. They MUST NOT be mixed
// ("today - 1 year" is NOT "rolling 52 weeks" and is NOT "calendar year").
//
//   rolling-52-weeks  — exactly 52 columns ending at the current week.
//                       The first column is `currentWeekStart - 51 weeks`,
//                       so the grid always has 52 full calendar weeks.
//                       Future days in the current week are kept (visual
//                       layout) but marked `isFuture: true` with `value: null`.
//
//   calendar-year     — every day of a given natural year (Jan 1 .. Dec 31).
//                       The week columns are derived from the actual layout
//                       (53 or 54 columns possible). Year-padding days at
//                       the start and end of the year are kept as layout
//                       placeholders but marked `inRange: false`.
//
// Convention:
//   * Weeks are Monday-first (Mon=0 .. Sun=6). Internal weekday index
//     is `(getDay() + 6) % 7` because `Date.prototype.getDay()` is
//     Sun=0 .. Sat=6.
//   * Dates are date-only ("YYYY-MM-DD") and matched against the
//     business data key. Never use a visual position to look up data.
//   * The whole module operates in the display timezone (UTC+8).
//     `today` is a UTC+8 day boundary (midnight Beijing); the date
//     strings are computed in that same timezone. Mixing UTC / local
//     math produces date / weekday / month off-by-one errors.

/**
 * @typedef {'rolling-52-weeks' | 'calendar-year'} HeatmapMode
 */

/**
 * One cell in the heatmap grid. Position is `(weekIndex, weekdayIndex)`;
 * `date` is the YYYY-MM-DD business key. `value` is the business number
 * for that day, or `null` when not applicable. The two flag fields
 * disambiguate the cell meaning — never collapse them into a single
 * "is zero" / "is future" / "is out of range" boolean.
 *
 * @typedef {{
 *   date: string,         // 'YYYY-MM-DD'
 *   value: number | null, // business value (e.g. total tokens), null for future / out-of-range
 *   weekIndex: number,    // 0..(columns-1)
 *   weekdayIndex: number, // 0=Mon..6=Sun
 *   inRange: boolean,     // belongs to the mode's date range
 *   isFuture: boolean,    // inside the range but after `today`
 * }} HeatmapDay
 */

/**
 * @typedef {{
 *   year: number,
 *   month: number,        // 0=Jan..11=Dec
 *   weekIndex: number,    // the column the month's 1st day lives in
 * }} MonthLabel
 */

/**
 * @typedef {{
 *   weeks: HeatmapDay[][],
 *   monthLabels: MonthLabel[],
 *   rangeStart: string,   // 'YYYY-MM-DD'
 *   rangeEnd: string,     // 'YYYY-MM-DD'
 *   mode: HeatmapMode,
 * }} HeatmapResult
 */

const DAY_MS = 86_400_000;

/**
 * UTC+8 day-boundary (Beijing midnight) UTC ms for a given UTC timestamp.
 * Mirrors `utc8DayStartUtcMs` in token-usage-store keys.js — duplicated
 * here to keep this module dependency-free.
 *
 * @param {number} nowMs
 * @returns {number}
 */
function utc8DayStartUtcMs(nowMs) {
  const MS_8H = 8 * 60 * 60 * 1000;
  return Math.floor((nowMs + MS_8H) / DAY_MS) * DAY_MS - MS_8H;
}

/**
 * YYYY-MM-DD string for a UTC+8 day boundary.
 *
 * @param {number} dayStartUtc8
 * @returns {string}
 */
function isoDayUtc8(dayStartUtc8) {
  return new Date(dayStartUtc8 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Mon=0..Sun=6 weekday index for a YYYY-MM-DD string interpreted in
 * UTC+8. Uses the UTC components of the date, which is the same
 * calendar day for any time in 00:00–23:59 UTC+8.
 *
 * @param {string} iso
 * @returns {number}
 */
function weekdayIndexOf(iso) {
  return (new Date(iso).getUTCDay() + 6) % 7;
}

/**
 * Build the empty grid (one column per week, 7 days each) for a mode.
 * The grid covers the full natural week columns required by the mode
 * so layout placeholders for `inRange: false` cells are present too.
 *
 * @param {HeatmapMode} mode
 * @param {string} todayIso
 * @param {number | null} [year]
 * @returns {{ weeks: HeatmapDay[][], rangeStart: string, rangeEnd: string }}
 */
function buildEmptyGrid(mode, todayIso, year) {
  if (mode === 'rolling-52-weeks') {
    const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
    const dow = (new Date(todayIso).getUTCDay() + 6) % 7;
    const currentWeekStart = todayMs - dow * DAY_MS;
    const firstWeekStart = currentWeekStart - 51 * 7 * DAY_MS;
    const rangeStartIso = isoUtc(firstWeekStart);
    const weeks = [];
    for (let w = 0; w < 52; w += 1) {
      const week = [];
      const weekStartMs = firstWeekStart + w * 7 * DAY_MS;
      for (let d = 0; d < 7; d += 1) {
        const dayMs = weekStartMs + d * DAY_MS;
        const iso = new Date(dayMs).toISOString().slice(0, 10);
        // rolling-52-weeks range: every day in the 52-column window is
        // inRange; future days keep their layout slot but carry
        // isFuture=true with value=null (per spec section II.2).
        const future = iso > todayIso;
        week.push({
          date: iso,
          value: null,
          weekIndex: w,
          weekdayIndex: d,
          inRange: iso >= rangeStartIso,
          isFuture: future,
        });
      }
      weeks.push(week);
    }
    return { weeks, rangeStart: isoUtc(firstWeekStart), rangeEnd: isoUtc(currentWeekStart + 6 * DAY_MS) };
  }

  if (mode === 'calendar-year') {
    const y = Number.isInteger(year) ? year : new Date(`${todayIso}T00:00:00Z`).getUTCFullYear();
    const rangeStart = `${y}-01-01`;
    const rangeEnd = `${y}-12-31`;
    const startDow = weekdayIndexOf(rangeStart);
    // Walk back to the Monday of the week containing Jan 1.
    const startMs = new Date(`${rangeStart}T00:00:00Z`).getTime() - startDow * DAY_MS;
    const endDow = weekdayIndexOf(rangeEnd);
    // Walk forward to the Sunday of the week containing Dec 31.
    const endMs = new Date(`${rangeEnd}T00:00:00Z`).getTime() + (6 - endDow) * DAY_MS;
    const weeks = [];
    let w = 0;
    for (let dayMs = startMs; dayMs <= endMs; dayMs += DAY_MS * 7) {
      const week = [];
      for (let d = 0; d < 7; d += 1) {
        const cellMs = dayMs + d * DAY_MS;
        const iso = new Date(cellMs).toISOString().slice(0, 10);
        const inRange = iso >= rangeStart && iso <= rangeEnd;
        const future = inRange && iso > todayIso;
        week.push({
          date: iso,
          value: null,
          weekIndex: w,
          weekdayIndex: d,
          inRange,
          isFuture: future,
        });
      }
      weeks.push(week);
      w += 1;
    }
    return { weeks, rangeStart, rangeEnd };
  }

  throw new Error(`buildCalendarHeatmap: unknown mode "${mode}"`);
}

/**
 * @param {number} dayMs
 * @returns {string}
 */
function isoUtc(dayMs) {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/**
 * Build a calendar heatmap grid.
 *
 * @param {{
 *   mode: HeatmapMode,
 *   today: number | Date,            // UTC ms OR a Date instance (test-friendly)
 *   year?: number,                   // required for `calendar-year` mode
 *   weekStartsOn?: 'monday',         // reserved for future `sunday`-first support
 *   data?: Map<string, { total: number, requests: number }> | null,
 *   valueKey?: 'total' | 'requests', // which field drives the cell value
 * }} opts
 * @returns {HeatmapResult}
 */
export function buildCalendarHeatmap(opts) {
  const { mode, year, data = null, valueKey = 'total' } = opts || {};
  if (!mode) throw new Error('buildCalendarHeatmap: mode is required');
  const todayMs = opts.today instanceof Date ? opts.today.getTime() : Number(opts.today);
  if (!Number.isFinite(todayMs)) throw new Error('buildCalendarHeatmap: today must be a Date or a UTC ms number');
  const todayStartUtc8 = utc8DayStartUtcMs(todayMs);
  const todayIso = isoDayUtc8(todayStartUtc8);

  const grid = buildEmptyGrid(mode, todayIso, year);
  const weeks = grid.weeks;

  // Apply business values to in-range, non-future cells. Future cells
  // and out-of-range placeholders stay `value: null` — the spec is
  // explicit: 0 is a real number, future is null, out-of-range is null.
  for (const week of weeks) {
    for (const cell of week) {
      if (!cell.inRange || cell.isFuture) continue;
      const v = data && data.get(cell.date);
      cell.value = v && Number.isFinite(v[valueKey]) ? v[valueKey] : 0;
    }
  }

  // Month labels: anchor each month to the week column where its 1st day
  // lives. The "rolling" mode gets month starts for the actual range so
  // a "9月 → 10月 → ... → 8月 → 9月" headline is still possible.
  const monthLabels = computeMonthLabels(weeks, mode, year, todayIso);

  return {
    weeks,
    monthLabels,
    rangeStart: grid.rangeStart,
    rangeEnd: grid.rangeEnd,
    mode,
  };
}

/**
 * Compute month labels for the heatmap. Each month is anchored to the
 * week column that contains its 1st day. For `rolling-52-weeks` the
 * year is implicit; we just emit every month-start that appears in the
 * grid range. For `calendar-year` we emit all 12 month-starts (1..12)
 * even when they happen to be padding days — the year-view is
 * expected to show "1月 → 12月" without gaps.
 *
 * @param {HeatmapDay[][]} weeks
 * @param {HeatmapMode} mode
 * @param {number | undefined} year
 * @param {string} todayIso
 * @returns {MonthLabel[]}
 */
function computeMonthLabels(weeks, mode, year, todayIso) {
  const labels = [];
  if (mode === 'calendar-year') {
    const y = year ?? Number(todayIso.slice(0, 4));
    for (let m = 0; m < 12; m += 1) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const wIdx = weekIndexOf(weeks, iso);
      if (wIdx === -1) continue;
      labels.push({ year: y, month: m, weekIndex: wIdx });
    }
    return labels;
  }

  // rolling-52-weeks: walk the grid's date range and emit every month-start.
  if (!weeks.length) return labels;
  const firstIso = weeks[0][0].date;
  const lastIso = weeks[weeks.length - 1][6].date;
  // First month-start: the 1st of firstIso's month.
  let cursor = `${firstIso.slice(0, 7)}-01`;
  while (cursor <= lastIso) {
    const wIdx = weekIndexOf(weeks, cursor);
    if (wIdx !== -1) {
      const y = Number(cursor.slice(0, 4));
      const m = Number(cursor.slice(5, 7)) - 1;
      // De-dupe: skip when we already have a label for the same (y, m) in the same week.
      if (!labels.some((l) => l.year === y && l.month === m && l.weekIndex === wIdx)) {
        labels.push({ year: y, month: m, weekIndex: wIdx });
      }
    }
    // Advance one calendar month.
    const next = nextMonthIso(cursor);
    cursor = next;
  }
  return labels;
}

/**
 * @param {HeatmapDay[][]} weeks
 * @param {string} iso
 * @returns {number}
 */
function weekIndexOf(weeks, iso) {
  for (let w = 0; w < weeks.length; w += 1) {
    for (let d = 0; d < 7; d += 1) {
      if (weeks[w][d].date === iso) return w;
    }
  }
  return -1;
}

/**
 * YYYY-MM-01 for the month after the given YYYY-MM-01.
 * @param {string} ym1  YYYY-MM-01
 * @returns {string}
 */
function nextMonthIso(ym1) {
  const y = Number(ym1.slice(0, 4));
  const m = Number(ym1.slice(5, 7));
  if (m === 12) return `${y + 1}-01-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
