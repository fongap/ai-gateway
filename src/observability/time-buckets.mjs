// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unified UTC bucket helpers for hour / day / week boundaries.
//
// ALL time-series storage in this project MUST bucket through one of these
// helpers so every module agrees on the same key format and boundaries:
//
//   getUtcHourBucket()  -> "2026-08-28T08:00:00Z"
//   getUtcDayBucket()   -> "2026-08-28"
//   getUtcWeekBucket()  -> "2026-W35"
//
// Buckets are aligned in UTC. UTC+8 is a DISPLAY-ONLY concern; dashboard
// natural-day conversion happens at the query boundary, never in storage keys.

const DAY_MS = 86_400_000;

/** Return the UTC hour bucket key "YYYY-MM-DDTHH:00:00Z". */
export function getUtcHourBucket(date = Date.now()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:00:00Z`;
}

/** Return the UTC calendar day key "YYYY-MM-DD" (UTC, not UTC+8). */
export function getUtcDayBucket(date = Date.now()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Return the UTC week bucket key "YYYY-Www" per ISO-8601 (week starts Monday).
 * `week_start` style: we always use the Monday-of-week date for retention
 * cutoffs via getUtcWeekStartUtcMs(). The key format avoids week % 52, slot
 * reuse, and year collision (ISO week 53 is represented correctly as e.g.
 * 2026-W53 — a distinct key from 2027-W01).
 */
export function getUtcWeekBucket(date = Date.now()) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - day));
  const weekYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(weekYear, 0, 1));
  const diffDays = Math.round((thursday - jan1) / DAY_MS);
  const week = Math.floor((diffDays + 1 - jan1.getUTCDay() + 7) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Return the UTC millisecond timestamp of the Monday 00:00:00Z that contains
 * `date`. This is the single definition of a week boundary used by the weekly
 * rollup and weekly retention cutoff.
 */
export function getUtcWeekStartUtcMs(date = Date.now()) {
  const t = typeof date === 'number' ? date : date.getTime();
  const d = new Date(t);
  const dow = (new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getUTCDay() + 6) % 7;
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return dayMs - dow * DAY_MS;
}