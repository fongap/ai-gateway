// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal Cloudflare D1 mock for the token-stats store tests. It simulates the
// two statements the real store issues:
//   * persistTokenUsage   -> prepare(INSERT ... ON CONFLICT ... ).bind(...).run()
//   * queryTokenSummary   -> prepare(SELECT SUM(...) ... ).bind(...).first()
// It is NOT a SQL parser: it recognises the statements by shape and applies the
// same atomic UPSERT / window aggregation semantics the real D1 performs, so
// the test asserts the STORE's algorithm (not SQL string matching) while still
// verifying correctness. `failWrites` / `failReads` simulate a broken binding
// to prove the fail-open contract.

export function createMockD1({ failWrites = false, failReads = false } = {}) {
  const rows = new Map(); // hour -> { input, output, total, requests, reports, missing }
  const writes = []; // every write's bind params, in order

  function prepare(sql) {
    const stmt = {
      _params: [],
      bind(...params) {
        this._params = params;
        return this;
      },
      async run() {
        writes.push({ sql, params: this._params });
        if (failWrites) throw new Error('mock D1 write failure');
        const [hour, input, output, total, req, reports, missing] = this._params;
        const cur = rows.get(hour)
          || { input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0 };
        rows.set(hour, {
          input: cur.input + (input || 0),
          output: cur.output + (output || 0),
          total: cur.total + (total || 0),
          requests: cur.requests + (req || 0),
          reports: cur.reports + (reports || 0),
          missing: cur.missing + (missing || 0),
        });
        return { success: true };
      },
      async first() {
        if (failReads) throw new Error('mock D1 read failure');
        // queryTokenSummary binds (todayStart, todayStart, h24Start, h24Start,
        // d7Start, d7Start).
        const [todayStart, , h24Start, , d7Start] = this._params;
        let cum_total = 0, cum_requests = 0, cum_reports = 0, cum_missing = 0;
        let today_total = 0, today_requests = 0;
        let h24_total = 0, h24_requests = 0, d7_total = 0, d7_requests = 0;
        for (const [hour, r] of rows) {
          cum_total += r.total;
          cum_requests += r.requests;
          cum_reports += r.reports;
          cum_missing += r.missing;
          if (hour >= todayStart) { today_total += r.total; today_requests += r.requests; }
          if (hour >= h24Start) { h24_total += r.total; h24_requests += r.requests; }
          if (hour >= d7Start) { d7_total += r.total; d7_requests += r.requests; }
        }
        return {
          cum_total, cum_requests, cum_reports, cum_missing,
          today_total, today_requests,
          h24_total, h24_requests, d7_total, d7_requests,
        };
      },
      async all() {
        if (failReads) throw new Error('mock D1 read failure');
        // queryTokenDailySeries: GROUP BY substr(hour,1,10) with hour >= start.
        const start = this._params[0];
        const byDay = new Map();
        for (const [hour, r] of rows) {
          if (hour < start) continue;
          const day = hour.slice(0, 10);
          const cur = byDay.get(day) || { total: 0, requests: 0 };
          byDay.set(day, { total: cur.total + r.total, requests: cur.requests + r.requests });
        }
        const results = [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([day, r]) => ({ day, total: r.total, requests: r.requests }));
        return { results };
      },
    };
    return stmt;
  }

  return { prepare, _rows: rows, _writes: writes };
}
