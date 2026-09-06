// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Calendar Heatmap — SSR renderer.
//
// The renderer consumes a `HeatmapResult` from `heatmap.js` and emits
// a static HTML grid. All cells are rendered with `data-tooltip` (the
// client-side `PAGE_SCRIPT` in pages.js attaches the floating tooltip
// element); level 0/1/2/3/4 are CSS-driven via the `data-level` attribute.
//
// Position facts: every cell carries `data-week` / `data-weekday` AND an
// explicit `grid-column` / `grid-row` inline placement, so the rendered
// position is derived from the HeatmapDay itself — never from DOM order
// or `grid-auto-flow`. The month-label row (`.months`) shares the exact
// same week-column tracks (`--week-count` CSS grid), so a label's
// `grid-column` lands precisely above its week column.
//
// Levels are quantized from `value` against the max `value` in the
// rendered range (i.e. `inRange && !isFuture` cells). Future cells and
// out-of-range padding cells stay at level 0 (the visual "empty" ramp
// step) — they MUST NOT be quantized to 0 because they're not "0
// activity" cells, they're "no business data here" cells. The CSS keeps
// the same look for both, but the tooltip and the `data-date` are the
// source of truth.

import { escapeHtml, fmtTokens, fmtInt, fmtTooltipDate } from './format.js';

const MONTH_NAMES_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/**
 * @typedef {{
 *   total: number,
 *   requests: number,
 * }} DailyCellData
 */

/**
 * @param {import('./heatmap.js').HeatmapResult} heatmap
 * @param {{
 *   valueKey?: 'total' | 'requests',
 *   data?: Map<string, DailyCellData> | null,
 *   ariaLabel?: string,
 *   unit?: string,                 // e.g. 'Token' for the tooltip prefix
 *   showMonthLabels?: boolean,
 *   colsCount?: number,            // override column count (used in legacy tests)
 * }} [opts]
 * @returns {{ cells: string[], labels: string[], ariaLabel: string }}
 */
export function renderHeatmap(heatmap, opts = {}) {
  const { valueKey = 'total', data = null, ariaLabel, unit = 'Token', showMonthLabels = true } = opts;
  const valueLabel = unit;
  const weeks = heatmap.weeks;

  // Max value over in-range non-future cells only.
  let max = 0;
  for (const week of weeks) {
    for (const cell of week) {
      if (!cell.inRange || cell.isFuture) continue;
      const v = cell.value ?? 0;
      if (v > max) max = v;
    }
  }

  const cells = [];
  for (const week of weeks) {
    for (const cell of week) {
      const { date: iso, value, inRange, isFuture, weekIndex, weekdayIndex } = cell;
      let level = 0;
      let tip;
      if (!inRange) {
        // Year-padding placeholder. Show the date as a tooltip so
        // a curious operator can still see what day the cell represents.
        tip = iso;
      } else if (isFuture) {
        tip = iso;
      } else {
        const v = value ?? 0;
        // Re-derive the human tooltip here so we don't need to ship the
        // `data` Map through the build pipeline twice. The `requests`
        // field always comes from the same `data` Map.
        const dayEntry = data && data.get(iso);
        const requests = dayEntry ? dayEntry.requests : 0;
        if (v > 0 && max > 0) {
          level = Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
        }
        tip = `${fmtTooltipDate(iso)}\n${fmtTokens(v)} ${valueLabel} · ${fmtInt(requests)} 次请求`;
      }
      cells.push(
        `<i class="cell" data-week="${weekIndex}" data-weekday="${weekdayIndex}" style="grid-column:${weekIndex + 1};grid-row:${weekdayIndex + 1}" data-level="${level}" data-date="${escapeHtml(iso)}" data-future="${isFuture ? '1' : '0'}" data-inrange="${inRange ? '1' : '0'}" tabindex="0" data-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></i>`,
      );
    }
  }

  // Month labels are date semantics, not decoration: every label the
  // builder anchored (via the week column containing the month's 1st day)
  // MUST appear in the output — including 1月 at the left edge and the
  // right-edge month (e.g. 9月 anchored to the last rolling column).
  // Right-edge overflow is a CSS positioning concern (the `.months` grid
  // shares the heatmap's week tracks) and is never solved by dropping
  // labels here.
  const labels = [];
  if (showMonthLabels) {
    let lastCol = -1;
    for (const { month, weekIndex } of heatmap.monthLabels) {
      // Defensive only: two real calendar month starts can never share a
      // week column (they are at least 28 days apart).
      if (weekIndex <= lastCol) continue;
      labels.push(`<span style="grid-column:${weekIndex + 1}">${MONTH_NAMES_CN[month]}</span>`);
      lastCol = weekIndex;
    }
  }

  return {
    cells,
    labels,
    ariaLabel: ariaLabel || defaultAriaLabel(heatmap),
  };
}

/**
 * @param {{ mode: string, rangeStart: string }} heatmap
 */
function defaultAriaLabel(heatmap) {
  if (heatmap.mode === 'rolling-52-weeks') return '近 52 周 Token 活动热力图';
  return `${heatmap.rangeStart.slice(0, 4)} 年 Token 活动热力图`;
}
