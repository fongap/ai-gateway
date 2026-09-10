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
import { buildCalendarHeatmap } from '../src/dashboard/heatmap.ts';

function dateAtIso(iso) {
  // TRUE UTC+8 midnight for the business date `iso` (= 16:00Z on the
  // previous day). Deliberately NOT `${iso}T00:00:00Z`: that instant is
  // 08:00 UTC+8 on the same business day, so boundary tests would pass by
  // coincidence ("the day is still the same") without ever exercising the
  // timezone conversion. Starting from the real UTC+8 midnight makes the
  // builder's day-boundary math part of every assertion below.
  return Date.parse(`${iso}T00:00:00+08:00`);
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

await test('calendar-year: 2026 has EXACTLY 53 columns and 365 in-range days', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  // 2026-01-01 is Thursday (Mon-first dow 3), 2026 is not a leap year:
  // the year spans exactly 53 Monday-first calendar week columns. For a
  // given year the count is deterministic — "53 or 54" is not a contract.
  assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
  const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
  assert.equal(inRange, 365, '365 in-range days (53*7=371 cells, 6 padding)');
});

await test('calendar-year: a leap year starting on Sunday spans EXACTLY 54 columns (2012)', () => {
  // 2012-01-01 is a Sunday (Mon-first dow 6) and 2012 is a leap year, so
  // Dec 31 lands in a week whose Monday is exactly 53 weeks after the
  // first column's Monday: 54 real columns, 366 in-range days.
  const today = dateAtIso('2012-06-15');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2012 });
  assert.equal(heatmap.weeks.length, 54, `got ${heatmap.weeks.length} weeks`);
  const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
  assert.equal(inRange, 366);
});

await test('calendar-year: 2040 is also an EXACT 54-column year (leap + Sunday Jan 1)', () => {
  const today = dateAtIso('2040-06-15');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2040 });
  assert.equal(heatmap.weeks.length, 54, `got ${heatmap.weeks.length} weeks`);
});

await test('calendar-year: non-leap years have EXACTLY 53 columns (2019)', () => {
  // 2019-01-01 is a Tuesday — the non-trivial layout case.
  const today = dateAtIso('2019-06-15');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2019 });
  assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
});

await test('calendar-year: leap year 2028 includes 2028-02-29 and has EXACTLY 53 columns / 366 days', () => {
  const today = dateAtIso('2028-02-29');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2028 });
  assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
  let leap = null;
  for (const week of heatmap.weeks) for (const c of week) {
    if (c.date === '2028-02-29') { leap = c; break; }
  }
  assert.ok(leap, '2028-02-29 cell exists');
  assert.equal(leap.inRange, true, '2028-02-29 is in 2028 range');
  const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
  assert.equal(inRange, 366, 'leap year has 366 in-range days');
});

// === Month-boundary anchoring ==============================================

await test('rolling-52-weeks: 8月31日 (Mon) and 9月1日 (Tue) share the last column; 9月 anchors there', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  const last = heatmap.weeks[51];
  assert.equal(last[0].date, '2026-08-31', 'last column starts Monday 8月31日');
  assert.equal(last[1].date, '2026-09-01', '9月1日 sits in the SAME column');
  const sep = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 8);
  assert.ok(sep, 'September label exists');
  assert.equal(sep.weekIndex, 51, '9月 anchors to weekIndex 51 (the column containing 2026-09-01), NOT to the column whose Monday is in August');
});

await test('calendar-year: month starting on Monday anchors to its own week column (2027-02-01)', () => {
  const today = dateAtIso('2027-02-01');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2027 });
  const feb = heatmap.monthLabels.find((l) => l.month === 1);
  assert.ok(feb, 'February label exists');
  assert.equal(heatmap.weeks[feb.weekIndex][0].date, '2027-02-01',
    '2027-02-01 is a Monday -> the February label column starts on it');
});

await test('calendar-year: month starting on Sunday anchors to the PREVIOUS week column (2026-02-01)', () => {
  const today = dateAtIso('2026-02-01');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  const feb = heatmap.monthLabels.find((l) => l.month === 1);
  assert.ok(feb, 'February label exists');
  const col = heatmap.weeks[feb.weekIndex].map((c) => c.date);
  assert.ok(col.includes('2026-02-01'), 'label column contains 2026-02-01');
  assert.equal(heatmap.weeks[feb.weekIndex][0].date, '2026-01-26',
    '2026-02-01 is a Sunday -> column Monday is 2026-01-26 (label is NOT pushed to the next column)');
});

await test('rolling-52-weeks: labels span the 12月 → 1月 year boundary', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  const dec = heatmap.monthLabels.find((l) => l.year === 2025 && l.month === 11);
  const jan = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 0);
  assert.ok(dec, '2025-12 label exists');
  assert.ok(jan, '2026-01 label exists');
  assert.ok(dec.weekIndex < jan.weekIndex, 'each label anchors at its own month start');
});

// === UTC+8 day-boundary =====================================================

await test('UTC+8 midnight boundary: 15:59:59Z vs 16:00:00Z split the business day', () => {
  // 2026-09-03T15:59:59Z = 2026-09-03 23:59:59 UTC+8; 2026-09-03T16:00:00Z
  // = 2026-09-04 00:00:00 UTC+8. The business date advances by one day,
  // the weekday follows the business date (Thu -> Fri), the month does
  // not shift.
  const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T15:59:59Z') });
  const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T16:00:00Z') });
  assert.equal(before.weeks[51][3].date, '2026-09-03', 'business today is Thursday 2026-09-03 before the boundary');
  assert.equal(before.weeks[51][3].weekdayIndex, 3, 'Thursday is weekday 3 — no weekday offset');
  assert.equal(before.weeks[51][4].isFuture, true, '2026-09-04 is future before the boundary');
  assert.equal(after.weeks[51][4].date, '2026-09-04', 'business today is Friday 2026-09-04 after the boundary');
  assert.equal(after.weeks[51][4].weekdayIndex, 4, 'Friday is weekday 4 — no weekday offset');
  assert.equal(after.weeks[51][4].isFuture, false, '2026-09-04 is today after the boundary');
  assert.equal(after.monthLabels[after.monthLabels.length - 1].month, 8, 'month label does not shift with the boundary');
});

await test('UTC+8 month/week boundary: 2026-08-31T16:00:00Z rolls date AND month with correct weekday math', () => {
  const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-08-31T15:59:59Z') });
  const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-08-31T16:00:00Z') });
  assert.equal(before.weeks[51][0].date, '2026-08-31', 'business today is Monday 8月31日 before the boundary');
  assert.equal(before.weeks[51][0].weekdayIndex, 0);
  assert.equal(after.weeks[51][1].date, '2026-09-01', 'business today is Tuesday 9月1日 after the boundary');
  assert.equal(after.weeks[51][1].weekdayIndex, 1, 'Tuesday is weekday 1 — no weekday offset');
  assert.equal(after.weeks[51][0].date, '2026-08-31', 'both sides share the same current-week Monday');
  const sepBefore = before.monthLabels.find((l) => l.year === 2026 && l.month === 8);
  const sepAfter = after.monthLabels.find((l) => l.year === 2026 && l.month === 8);
  assert.equal(sepBefore.weekIndex, 51, '9月 anchors to the last column before the boundary');
  assert.equal(sepAfter.weekIndex, 51, '9月 anchors to the last column after the boundary');
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
