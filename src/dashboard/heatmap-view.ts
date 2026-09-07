// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Calendar Heatmap — SSR renderer.
//
// The renderer consumes a `HeatmapResult` from `heatmap.ts` and emits
// a static HTML grid. All cells are rendered with `data-tooltip` (the
// client-side `PAGE_SCRIPT` in pages.ts attaches the floating tooltip
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

import { escapeHtml, fmtTokens, fmtInt, fmtTooltipDate } from './format.ts';
import type { HeatmapResult } from './heatmap.ts';

const MONTH_NAMES_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export type DailyCellData = { total: number, requests: number, reports: number, missing: number };

export function renderHeatmap(
  heatmap: HeatmapResult,
  opts: {
    valueKey?: 'total' | 'requests',
    data?: Map<string, DailyCellData> | null,
    ariaLabel?: string,
    unit?: string,
    showMonthLabels?: boolean,
    colsCount?: number,
    coverage?: number | null,
  } = {},
): { cells: string[], labels: string[], ariaLabel: string } {
  const { data = null, ariaLabel, unit = 'Token', showMonthLabels = true, coverage = null } = opts;
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

  const cells: string[] = [];
  for (const week of weeks) {
    for (const cell of week) {
      const { date: iso, value, inRange, isFuture, weekIndex, weekdayIndex } = cell;
      let level = 0;
      let tip: string;
      if (!inRange) {
        tip = iso;
      } else if (isFuture) {
        tip = iso;
      } else {
        const v = value ?? 0;
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

  const labels: string[] = [];
  if (showMonthLabels) {
    let lastCol = -1;
    for (const { month, weekIndex } of heatmap.monthLabels) {
      if (weekIndex <= lastCol) continue;
      labels.push(`<span style="grid-column:${weekIndex + 1}">${MONTH_NAMES_CN[month]}</span>`);
      lastCol = weekIndex;
    }
  }

  return {
    cells,
    labels,
    ariaLabel: ariaLabel || defaultAriaLabel(heatmap, coverage),
  };
}

function defaultAriaLabel(heatmap: { mode: string, rangeStart: string }, coverage?: number | null): string {
  if (heatmap.mode === 'rolling-52-weeks') {
    const base = '近 52 周 Token 活动热力图';
    if (coverage !== null && coverage !== undefined) {
      const pct = Math.round(coverage * 1000) / 10;
      return `${base} · 统计 ${pct}%`;
    }
    return base;
  }
  return `${heatmap.rangeStart.slice(0, 4)} 年 Token 活动热力图`;
}
