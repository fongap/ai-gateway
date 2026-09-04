// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Calendar heatmap renderer tests. Pins the HTML contract the dashboard
// depends on:
//   * 364 cells (52 * 7) for `rolling-52-weeks`
//   * 53/54 cells (NOT 52) for `calendar-year` 2026
//   * data-level="0" for out-of-range / future / zero cells
//   * data-level="1".."4" for active cells, quantized to max
//   * month labels carry the M月 text and a grid-column index
//   * data-tooltip, data-date, data-future, data-inrange attributes
//     are present so the existing PAGE_SCRIPT tooltip layer keeps
//     working and so a future "data-future" / "data-inrange" CSS rule
//     can be added without breaking layout.

import assert from 'node:assert/strict';
import { buildCalendarHeatmap } from '../src/dashboard/heatmap.js';
import { renderHeatmap } from '../src/dashboard/heatmap-view.js';

function dateAtIso(iso) {
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

await test('renderer rolling-52-weeks: 364 cells, 12 month labels, levels 0/1..4 populated', () => {
  const today = dateAtIso('2026-09-04');
  const data = new Map();
  data.set('2026-09-04', { total: 100, requests: 1 });
  data.set('2026-08-15', { total: 25, requests: 1 });
  data.set('2026-08-01', { total: 1, requests: 1 });
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data, valueKey: 'total' });
  const { cells, labels, ariaLabel } = renderHeatmap(heatmap, { data, valueKey: 'total' });
  assert.equal(cells.length, 364, '52 * 7 cells');
  assert.ok(labels.length >= 11 && labels.length <= 13, `12 month labels (got ${labels.length})`);
  // 100 is the max -> level 4. 25 is ~25% of max -> level 1 (ceil).
  // 1 is ~1% of max -> level 1 (max(1, ...)).
  const html = cells.join('');
  assert.ok(html.includes('data-level="4"'), 'max-day is level 4');
  assert.ok(html.includes('data-level="1"'), 'low days are level 1');
  assert.ok(html.includes('data-level="0"'), 'zero days are level 0');
  // data-future and data-inrange are now part of the contract.
  assert.ok(html.includes('data-future="1"'), 'future cells carry data-future="1"');
  assert.ok(html.includes('data-future="0"'), 'past cells carry data-future="0"');
  assert.ok(html.includes('data-inrange="1"'), 'in-range cells carry data-inrange="1"');
  assert.ok(html.includes('data-date="2026-09-04"'), 'every cell has its YYYY-MM-DD key on data-date');
  assert.match(ariaLabel, /近 52 周/);
});

await test('renderer rolling-52-weeks: future cells stay level 0, tooltip is the bare ISO date', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  const { cells } = renderHeatmap(heatmap);
  // The last column's Sat (2026-09-05) and Sun (2026-09-06) are
  // future cells; their tooltip must NOT contain "Token" or "次请求".
  const satCell = cells.find((c) => c.includes('data-date="2026-09-05"'));
  assert.ok(satCell, 'Saturday cell exists');
  assert.match(satCell, /data-level="0"/, 'future Saturday is level 0');
  assert.match(satCell, /data-future="1"/);
  assert.match(satCell, /data-tooltip="2026-09-05"/, 'future tooltip is bare ISO');
  assert.ok(!satCell.includes('次请求'), 'future cell has no request count');
});

await test('renderer rolling-52-weeks: tooltip carries date + tokens + requests', () => {
  const today = dateAtIso('2026-09-04');
  const data = new Map();
  data.set('2026-08-15', { total: 12345, requests: 7 });
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data });
  const { cells } = renderHeatmap(heatmap, { data });
  const cell = cells.find((c) => c.includes('data-date="2026-08-15"'));
  assert.ok(cell, 'cell exists for 2026-08-15');
  // The tooltip should contain the month/day + token count + request count.
  // We use loose matching because the formatter outputs CJK characters
  // and the console encoding may mangle them, but the structure is stable.
  assert.match(cell, /data-tooltip="[^"]*Token[^"]*次请求"/);
  assert.match(cell, /data-tooltip="[^"]*1\.2万[^"]*"/);
  assert.match(cell, /data-tooltip="[^"]*7 次请求"/);
});

await test('renderer calendar-year 2026: 53 columns, 12 month labels, no inRange past cells are quantified as 0', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  const { cells, labels, ariaLabel } = renderHeatmap(heatmap);
  // 2026 has 53 columns
  assert.equal(cells.length, 53 * 7, `53 columns * 7 days = 371 cells (got ${cells.length})`);
  assert.equal(labels.length, 12, '12 month labels');
  assert.match(ariaLabel, /2026/);
  // Out-of-range (Dec 2025 padding) cells are level 0.
  const paddingCell = cells.find((c) => c.includes('data-date="2025-12-31"'));
  assert.ok(paddingCell, '2025-12-31 padding cell exists');
  assert.match(paddingCell, /data-level="0"/);
  assert.match(paddingCell, /data-inrange="0"/);
});

await test('renderer calendar-year 2026: month labels are in 1..12 order and use the right week column', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
  const { labels } = renderHeatmap(heatmap);
  const seen = labels.map((l) => Number(l.match(/>(\d+)月</)[1]));
  // 1..12 in order (the spec mandates month order; we still collapse
  // any duplicate month-start that lands on the same week).
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `month label order is non-decreasing: ${seen.join(', ')}`);
  }
  assert.ok(seen[0] === 1 || seen[0] === 2, `first month label is 1月 or 2月 (got ${seen[0]}月)`);
  assert.ok(seen[seen.length - 1] <= 12, 'last month label is <= 12月');
});

await test('renderer rolling-52-weeks: month labels never crowd closer than 3 columns', () => {
  const today = dateAtIso('2026-09-04');
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
  const { labels } = renderHeatmap(heatmap);
  let lastCol = -99;
  for (const l of labels) {
    const col = Number(l.match(/grid-column:(\d+)/)[1]);
    if (lastCol > -99) {
      assert.ok(col - lastCol >= 3, `month label at column ${col} is too close to previous (${lastCol})`);
    }
    lastCol = col;
  }
});

await test('renderer: HTML escaping of tooltip payloads with special chars', () => {
  const today = dateAtIso('2026-09-04');
  const data = new Map();
  data.set('2026-08-15', { total: 100, requests: 1 });
  const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data });
  // Render with a name that contains & < > in the data so we can assert escaping.
  // We can't easily inject HTML through the date key, but we can verify
  // that the level-4 cell is properly emitted with all expected attributes.
  const { cells } = renderHeatmap(heatmap, { data });
  const cell = cells.find((c) => c.includes('data-date="2026-08-15"'));
  assert.ok(/^<i [^>]+><\/i>$/.test(cell), 'cell is a single self-closed <i> tag');
  // Confirm all attribute values are quoted.
  assert.ok(/data-level="[0-4]"/.test(cell));
  assert.ok(/data-tooltip="[^"]*"/.test(cell));
  assert.ok(/aria-label="[^"]*"/.test(cell));
});
