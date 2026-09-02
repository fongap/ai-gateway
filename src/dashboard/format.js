// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Pure formatters used across the public dashboard.
//
// These functions have no closure dependency on the dashboard state. They
// only depend on primitive arguments and are safe to import and unit-test
// in isolation.

// Chinese unit formatting for KPI values: 万 (10^4) and 亿 (10^8).
// < 10000: integer; >= 10000: 万 with 1 decimal; >= 100M: 亿 with 2 decimals.
// Never use K/M/B. Exact value available in title attribute.
export function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 10000) return String(Math.trunc(n));
  if (n < 1e8) {
    const v = n / 1e4;
    const s = v >= 100 ? Math.round(v) : (Number.isInteger(v) ? v : v.toFixed(1));
    return `${s}万`;
  }
  const v = n / 1e8;
  const s = v >= 100 ? Math.round(v) : (Number.isInteger(v) ? v : v.toFixed(2));
  return `${s}亿`;
}

export function fmtInt(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format TTFT milliseconds into a human-friendly string. Negative or
// non-finite values render as "--". Sub-second values use ms, second-level
// values use plain s when integer and .1s when fractional.
export function fmtTtft(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (Number.isInteger(sec)) return `${sec}s`;
  return `${sec.toFixed(1)}s`;
}

// Format a UTC+8 ISO date (YYYY-MM-DD) as "6月1日" for tooltip display.
export function fmtTooltipDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

// Minimal HTML attribute escaper used by the public dashboard HTML builders.
// Only handles the characters that can break out of a double-quoted HTML
// attribute — the dashboard never embeds user-controlled HTML, only model
// names and aggregated numbers.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
