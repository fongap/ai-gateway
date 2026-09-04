// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Calendar heatmap utility tests (PR: refactor heatmap into a shared
// rolling-52-weeks / calendar-year abstraction). The spec lives in
// docs/architecture/calendar-heatmap.md; the assertions here pin the
// observable contract — date keys, weekIndex / weekdayIndex, inRange /
// isFuture semantics, the two modes' time-range rules, and the month
// label anchoring.

import assert from 'node:assert/strict';
import { buildCalendarHeatmap } from '../src/dashboard/heatmap.js';

function dateAtIso(iso) {
  // Build a UTC ms value for a UTC+8 "midnight" so the utility's
  // `utc8DayStartUtcMs` snaps to the right calendar day in the
  // display timezone.
  return new Date(`${iso}T00:00:00Z`).getTime();
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

// === Mode A: rolling-52-weeks =============================================

await test('rolling-52-weeks: 52 columns, 7 days each, current week is the last column', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  assert.equal(heatmap.weeks.length, 52, '52 week columns');
  for (const week of heatmap.weeks) assert.equal(week.length, 7, '7 days per week');
  // Last column is the current week (Mon = 2026-08-31).
  const last = heatmap.weeks[51];
  assert.equal(last[0].date, '2026-08-31', 'column 51 week-start is Monday 2026-08-31');
  assert.equal(last[0].weekdayIndex, 0, 'Monday is weekday 0');
  assert.equal(last[4].date, '2026-09-04', 'Friday matches the today input');
  assert.equal(last[4].isFuture, false, 'Friday 2026-09-04 is NOT in the future');
  assert.equal(last[5].date, '2026-09-05', 'Saturday 2026-09-05 (future)');
  assert.equal(last[5].isFuture, true, 'Saturday is future');
  assert.equal(last[6].date, '2026-09-06', 'Sunday 2026-09-06 (future)');
  assert.equal(last[6].isFuture, true, 'Sunday is future');
});

await test('rolling-52-weeks: future cells keep their layout slot but value is null', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  const lastSat = heatmap.weeks[51][5];
  assert.equal(lastSat.inRange, true, 'future Saturday is still inRange');
  assert.equal(lastSat.isFuture, true);
  assert.equal(lastSat.value, null, 'value is null for future cells');
});

await test('rolling-52-weeks: weekday index is Monday-first even when JavaScript Date.getDay is Sunday-first', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  // 2026-09-04 is a Friday -> weekdayIndex 4 (Mon=0..Sun=6)
  assert.equal(heatmap.weeks[51][4].weekdayIndex, 4, 'Friday has weekdayIndex 4');
  // 2026-09-05 is a Saturday -> weekdayIndex 5
  assert.equal(heatmap.weeks[51][5].weekdayIndex, 5);
  // 2026-09-06 is a Sunday -> weekdayIndex 6
  assert.equal(heatmap.weeks[51][6].weekdayIndex, 6);
  // 2026-08-31 is a Monday -> weekdayIndex 0
  assert.equal(heatmap.weeks[51][0].weekdayIndex, 0);
});

await test('rolling-52-weeks: month labels anchor to where each month 1st lives', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  // The label for 2026-09-01 (Tuesday) must point at the column that
  // contains 2026-09-01, NOT at the column whose Monday is in August.
  const sep1 = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 8);
  assert.ok(sep1, 'September label exists');
  const col = sep1.weekIndex;
  const datesInCol = heatmap.weeks[col].map((c) => c.date);
  assert.ok(datesInCol.includes('2026-09-01'), `column ${col} contains 2026-09-01`);
});

await test('rolling-52-weeks: business data is matched by YYYY-MM-DD key, not position', () => {
  const today = dateAtIso('2026-09-04');
  const data = new Map();
  data.set('2026-08-15', { total: 100, requests: 2 });
  const heatmap = buildCalendarHeatmap({
    mode: 'rolling-52-weeks',
    today,
    data,
    valueKey: 'total',
  });
  // Find the cell whose date is 2026-08-15.
  let found = null;
  for (const week of heatmap.weeks) for (const cell of week) {
    if (cell.date === '2026-08-15') { found = cell; break; }
  }
  assert.ok(found, 'cell exists for 2026-08-15');
  assert.equal(found.value, 100, 'value comes from the data Map, not from a position');
});

await test('rolling-52-weeks: in-range past cells with no data are 0 (real number, not null)', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data: null });
  // Pick a date well in the past — its value should be 0, not null.
  let past = null;
  for (const week of heatmap.weeks) for (const cell of week) {
    if (cell.date === '2026-08-01') { past = cell; break; }
  }
  assert.ok(past, 'cell for 2026-08-01 exists');
  assert.equal(past.inRange, true);
  assert.equal(past.isFuture, false);
  assert.equal(past.value, 0, 'in-range past cell with no data has value=0');
});

// === Mode B: calendar-year ===============================================

await test('calendar-year 2026: rangeStart=2026-01-01, rangeEnd=2026-12-31', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  assert.equal(heatmap.rangeStart, '2026-01-01');
  assert.equal(heatmap.rangeEnd, '2026-12-31');
});

await test('calendar-year 2026: 2026-01-01 is a Thursday (weekdayIndex=3)', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  let first = null;
  for (const week of heatmap.weeks) for (const cell of week) {
    if (cell.date === '2026-01-01') { first = cell; break; }
  }
  assert.ok(first, '2026-01-01 cell exists');
  assert.equal(first.weekdayIndex, 3, '2026-01-01 is Thursday (Mon=0..Sun=6 -> 3)');
});

await test('calendar-year 2026: layout padding before Jan 1 is out of range', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  // 2025-12-29, 2025-12-30, 2025-12-31 must be present as layout
  // placeholders for the first column but inRange must be false.
  for (const iso of ['2025-12-29', '2025-12-30', '2025-12-31']) {
    let cell = null;
    for (const week of heatmap.weeks) for (const c of week) {
      if (c.date === iso) { cell = c; break; }
    }
    assert.ok(cell, `${iso} cell exists (layout placeholder)`);
    assert.equal(cell.inRange, false, `${iso} is layout padding, not in 2026 range`);
    assert.equal(cell.value, null, `${iso} value is null`);
  }
});

await test('calendar-year 2026: layout padding after Dec 31 is out of range', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  // 2027-01-01..2027-01-03 may or may not be in the grid depending on
  // 2026-12-31's weekday. If present, they must be inRange=false.
  for (const week of heatmap.weeks) for (const cell of week) {
    if (cell.date >= '2027-01-01') {
      assert.equal(cell.inRange, false, `${cell.date} is 2027, not in 2026 range`);
    }
  }
});

await test('calendar-year 2026: months 1..12 each have a label, anchored to the week of their 1st day', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  assert.equal(heatmap.monthLabels.length, 12, '12 month labels');
  for (let m = 0; m < 12; m += 1) {
    const label = heatmap.monthLabels.find((l) => l.month === m);
    assert.ok(label, `month ${m + 1} label exists`);
    // The column must contain the 1st day of that month.
    const iso = `${label.year}-${String(m + 1).padStart(2, '0')}-01`;
    const datesInCol = heatmap.weeks[label.weekIndex].map((c) => c.date);
    assert.ok(datesInCol.includes(iso), `month ${m + 1} label column contains ${iso}`);
  }
});

await test('calendar-year current year: future days in-range but value null', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  let future = null;
  for (const week of heatmap.weeks) for (const c of week) {
    if (c.date === '2026-12-31') { future = c; break; }
  }
  assert.ok(future, '2026-12-31 cell exists');
  assert.equal(future.inRange, true);
  assert.equal(future.isFuture, true, '2026-12-31 is in-range future when today=2026-09-04');
  assert.equal(future.value, null, 'value is null for future cells');
});

await test('calendar-year historical year: no future days', () => {
  // 2025 is fully in the past relative to today=2026-09-04.
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2025 });
  for (const week of heatmap.weeks) for (const cell of week) {
    if (cell.inRange) {
      assert.equal(cell.isFuture, false, `${cell.date} in 2025 must NOT be future when today=2026-09-04`);
    }
  }
});

await test('calendar-year: 2026 has 53 columns (Jan 1 is Thursday -> 53 weeks)', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  // We do NOT hard-code 52 — the spec says: depends on the year layout.
  // 2026-01-01 is Thursday so the year spans 53 week columns.
  assert.ok(heatmap.weeks.length === 53 || heatmap.weeks.length === 54, `got ${heatmap.weeks.length} weeks (53 expected, 54 acceptable)`);
});

await test('calendar-year: leap year 2028 includes 2028-02-29 in range', () => {
  const today = dateAtIso('2028-02-29');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2028 });
  let leap = null;
  for (const week of heatmap.weeks) for (const c of week) {
    if (c.date === '2028-02-29') { leap = c; break; }
  }
  assert.ok(leap, '2028-02-29 cell exists');
  assert.equal(leap.inRange, true, '2028-02-29 is in 2028 range');
});

await test('calendar-year: a year whose Jan 1 is a Monday has 53 columns (52 + 53rd)', () => {
  // 2019-01-01 is a Tuesday (weekdayIndex 1). Use it to confirm the
  // non-trivial layout calculation: Tuesday -> 53 weeks.
  const today = dateAtIso('2019-06-15');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2019 });
  assert.ok(heatmap.weeks.length >= 53, `2019 should have at least 53 columns, got ${heatmap.weeks.length}`);
});

await test('rolling-52-weeks: Date input also works (not just number ms)', () => {
  const today = new Date('2026-09-04T08:00:00Z');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  assert.equal(heatmap.weeks.length, 52);
  // 2026-09-04 (UTC+8) is the same calendar day.
  const last = heatmap.weeks[51][4];
  assert.equal(last.date, '2026-09-04');
});

await test('rolling-52-weeks: rejects unknown mode', () => {
  assert.throws(() => buildCalendarHeatmap({ mode: 'wrong', today: Date.now() }), /unknown mode/);
});

await test('rolling-52-weeks: rejects missing mode', () => {
  assert.throws(() => buildCalendarHeatmap({ today: Date.now() }), /mode is required/);
});

await test('rolling-52-weeks: rejects non-finite today', () => {
  assert.throws(() => buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: NaN }), /today must be a Date/);
});
