#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Calendar Heatmap Contract — the spec table from the release-hardening
// round, pinned as executable contracts. The two modes' semantics live in
// docs/architecture/calendar-heatmap.md; the builder/renderer suites pin
// behavior in depth, this file pins the CONTRACT so any regression fails
// with the spec clause in the failure message:
//
//   C01  rolling-52-weeks always has exactly 52 columns
//   C02  Monday-first weekday indexing (Mon=0 .. Sun=6)
//   C03  business data key is YYYY-MM-DD, matched by key (never position)
//   C04  future is NOT zero (future -> value null; past no-data -> value 0)
//   C05  month label anchors at the weekIndex containing the month's 1st day
//   C06  right-edge month label is never dropped (9月 at the last column)
//   C07  calendar-year range is Jan 1 .. Dec 31
//   C08  calendar-year column count is dynamic AND exact (53; 54 for a
//        leap year starting on Sunday)
//   C09  calendar-year year-padding is inRange=false / value null
//   C10  current-year future dates are inRange=true / isFuture / null
//   C11  historical years contain no future days
//   C12  leap day exists in range (2028-02-29) with correct day counts
//   C13  UTC+8 midnight boundary (15:59:59Z vs 16:00:00Z) — date advances,
//        weekday and month do not shift
//   C14  renderer and builder share the same week column (data-week /
//        data-weekday / explicit grid placement match the builder grid)
//   C15  `.months` shares the heatmap's week-column tracks via the
//        `--week-count` CSS grid — never flex/space-between

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCalendarHeatmap } from '../src/dashboard/heatmap.js';
import { renderHeatmap } from '../src/dashboard/heatmap-view.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// TRUE UTC+8 midnight (= 16:00Z the previous day) — see
// calendar-heatmap-test.mjs for why `${iso}T00:00:00Z` would be wrong.
const dateAtIso = (iso) => Date.parse(`${iso}T00:00:00+08:00`);

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const flat = (h) => h.weeks.flat();
const findCell = (h, iso) => flat(h).find((c) => c.date === iso) || null;

// ---- C01: rolling-52-weeks always 52 columns ---------------------------------
{
  const todays = ['2026-01-01', '2026-09-04', '2026-12-31', '2025-02-28', '2028-02-29', '2020-02-29'];
  const counts = todays.map((iso) => buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso(iso) }).weeks.length);
  check('C01 rolling-52-weeks is always exactly 52 columns', counts.every((n) => n === 52),
    `todays=${todays.join(',')} counts=${counts.join(',')}`);
}

// ---- C02: Monday-first ---------------------------------------------------------
{
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
  const last = h.weeks[51];
  const okDates = last[0].date === '2026-08-31' && last[6].date === '2026-09-06';
  const okIdx = last.every((c, d) => c.weekdayIndex === d);
  check('C02 Monday-first: column starts Monday (2026-08-31), weekdayIndex 0..6', okDates && okIdx,
    `first=${last[0].date} last=${last[6].date}`);
}

// ---- C03: business key = YYYY-MM-DD --------------------------------------------
{
  const data = new Map([['2026-08-15', { total: 123, requests: 4 }]]);
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04'), data });
  const cell = findCell(h, '2026-08-15');
  const allIso = flat(h).every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && Number.isFinite(Date.parse(`${c.date}T00:00:00Z`)));
  check('C03 business key is YYYY-MM-DD and data is matched by key, not position',
    allIso && cell && cell.value === 123, `cell=${JSON.stringify(cell)}`);
}

// ---- C04: future != zero --------------------------------------------------------
{
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
  const future = findCell(h, '2026-09-05');
  const pastNoData = findCell(h, '2026-08-01');
  check('C04 future -> null; in-range past with no data -> real 0',
    future && future.isFuture && future.value === null
      && pastNoData && !pastNoData.isFuture && pastNoData.value === 0,
    `future=${JSON.stringify(future)} past=${JSON.stringify(pastNoData)}`);
}

// ---- C05: month label = monthStart weekIndex ------------------------------------
{
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
  const sep = h.monthLabels.find((l) => l.year === 2026 && l.month === 8);
  const ok = sep && h.weeks[sep.weekIndex].some((c) => c.date === '2026-09-01');
  check('C05 month label anchors at the weekIndex containing the month 1st day', Boolean(ok),
    `sep=${JSON.stringify(sep)}`);
}

// ---- C06: right-edge month is never dropped --------------------------------------
{
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
  const { labels } = renderHeatmap(h);
  const sep = labels.find((l) => l.includes('>9月<'));
  check('C06 right-edge month label present and bound to the last week column',
    Boolean(sep) && /grid-column:52/.test(sep || ''), `labels=${labels.length}`);
}

// ---- C07 + C08: calendar-year range and exact column counts ----------------------
{
  const h = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2026 });
  const rangeOk = h.rangeStart === '2026-01-01' && h.rangeEnd === '2026-12-31';
  // Non-leap years: exactly 53 columns. Leap years starting on Sunday
  // (2012, 2040): exactly 54. Every other leap year: 53.
  const cases = [[2012, 54], [2015, 53], [2016, 53], [2019, 53], [2026, 53], [2027, 53], [2028, 53], [2040, 54]];
  const counts = cases.map(([y, expected]) => {
    const hy = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso(`${y}-06-15`), year: y });
    return hy.weeks.length === expected;
  });
  check('C07 calendar-year range is Jan 1 .. Dec 31', rangeOk, `range=${h.rangeStart}..${h.rangeEnd}`);
  check('C08 calendar-year column count is dynamic AND exact (53; 54 for leap+Sunday Jan 1)',
    counts.every(Boolean), `cases=${JSON.stringify(cases)}`);
}

// ---- C09 + C10 + C11: padding / current-year future / historical year ------------
{
  const h2026 = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2026 });
  const padStart = [findCell(h2026, '2025-12-29'), findCell(h2026, '2025-12-30'), findCell(h2026, '2025-12-31')];
  const padEnd = flat(h2026).filter((c) => c.date >= '2027-01-01');
  const future = findCell(h2026, '2026-12-31');
  const c09 = padStart.every((c) => c && c.inRange === false && c.value === null)
    && padEnd.every((c) => c.inRange === false && c.value === null);
  const c10 = future && future.inRange === true && future.isFuture === true && future.value === null;
  const h2025 = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2025 });
  const c11 = flat(h2025).filter((c) => c.inRange).every((c) => c.isFuture === false);
  check('C09 year padding (Dec 2025 / Jan 2027) is inRange=false, value=null', c09,
    `padStart=${JSON.stringify(padStart.map((c) => c && [c.date, c.inRange, c.value]))}`);
  check('C10 current-year future dates are inRange=true / isFuture=true / value=null', Boolean(c10),
    `2026-12-31=${JSON.stringify(future)}`);
  check('C11 historical year (2025) contains no future days', c11);
}

// ---- C12: leap day -----------------------------------------------------------------
{
  const h = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2028-02-29'), year: 2028 });
  const leap = findCell(h, '2028-02-29');
  const inRange = flat(h).filter((c) => c.inRange).length;
  check('C12 leap day 2028-02-29 exists in range; 366 in-range days; 53 columns',
    Boolean(leap) && leap.inRange === true && inRange === 366 && h.weeks.length === 53,
    `weeks=${h.weeks.length} inRange=${inRange}`);
}

// ---- C13: UTC+8 midnight boundary ---------------------------------------------------
{
  const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T15:59:59Z') });
  const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T16:00:00Z') });
  const ok = before.weeks[51][3].date === '2026-09-03' && before.weeks[51][3].weekdayIndex === 3
    && after.weeks[51][4].date === '2026-09-04' && after.weeks[51][4].weekdayIndex === 4
    && after.monthLabels[after.monthLabels.length - 1].month === 8;
  check('C13 15:59:59Z vs 16:00:00Z: business date ±1, weekday and month do not shift', ok,
    `before=${before.weeks[51][3].date} after=${after.weeks[51][4].date}`);
}

// ---- C14: renderer and builder share the same week column ----------------------------
{
  const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
  const { cells, labels } = renderHeatmap(h);
  const byDate = new Map(flat(h).map((c) => [c.date, c]));
  let cellsOk = true;
  for (const html of cells) {
    const date = html.match(/data-date="([^"]+)"/)?.[1];
    const week = Number(html.match(/data-week="(\d+)"/)?.[1]);
    const weekday = Number(html.match(/data-weekday="(\d+)"/)?.[1]);
    const col = Number(html.match(/grid-column:(\d+)/)?.[1]);
    const row = Number(html.match(/grid-row:(\d+)/)?.[1]);
    const b = byDate.get(date);
    if (!b || b.weekIndex !== week || b.weekdayIndex !== weekday
      || col !== week + 1 || row !== weekday + 1) { cellsOk = false; break; }
  }
  let labelsOk = true;
  for (const html of labels) {
    const col = Number(html.match(/grid-column:(\d+)/)?.[1]);
    const month = Number(html.match(/>(\d{1,2})月</)?.[1]);
    const label = h.monthLabels.find((l) => l.month === month - 1);
    if (!label || label.weekIndex + 1 !== col) { labelsOk = false; break; }
  }
  check('C14 renderer positions (cells + labels) match the builder week columns exactly',
    cellsOk && labelsOk, `cellsOk=${cellsOk} labelsOk=${labelsOk}`);
}

// ---- C15: months CSS shares the heatmap week tracks -----------------------------------
{
  const css = readFileSync(join(root, 'src/dashboard/theme.js'), 'utf8');
  const monthsRule = css.match(/\.months\{[^}]*\}/)?.[0] || '';
  const heatmapRule = css.match(/\.heatmap\{[^}]*\}/)?.[0] || '';
  const monthsGrid = monthsRule.includes('display:grid')
    && monthsRule.includes('grid-template-columns:repeat(var(--week-count,52),10px)');
  const notFlex = !monthsRule.includes('display:flex') && !monthsRule.includes('space-between');
  const heatmapSameTracks = heatmapRule.includes('grid-template-columns:repeat(var(--week-count,52),10px)');
  const usageView = readFileSync(join(root, 'src/dashboard/usage-view.js'), 'utf8');
  const weekCountWired = /class="heatmap" style="\$\{weekTracks\}"/.test(usageView)
    && /class="months" style="\$\{weekTracks\}"/.test(usageView);
  const titleUpdated = usageView.includes('Token 活动 · 近 52 周');
  check('C15 .months uses the same --week-count CSS grid tracks as .heatmap (no flex/space-between)',
    monthsGrid && notFlex && heatmapSameTracks && weekCountWired && titleUpdated,
    `monthsGrid=${monthsGrid} notFlex=${notFlex} heatmapSameTracks=${heatmapSameTracks} wired=${weekCountWired} title=${titleUpdated}`);
}

if (failures > 0) {
  console.error(`calendar-heatmap-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('calendar-heatmap-contract: all contracts passed');
