// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal Cloudflare D1 test database for the token-usage store tests. It simulates the
// statements the real store issues:
//   * persistTokenUsage (global)    -> prepare(INSERT INTO token_usage_hourly ...).run()
//   * persistTokenUsage (per-model) -> prepare(INSERT INTO token_usage_model_hourly ...).run()
//   * queryTokenSummary             -> prepare(SELECT SUM(...) ... ).bind(...).first()
//   * queryTokenDailySeries         -> prepare(SELECT hour, SUM(...) GROUP BY hour).all()
//   * queryTokenModelUsage          -> prepare(SELECT model, SUM(...) GROUP BY model).all()
// It is NOT a SQL parser: it recognises the statements by shape (which table
// is touched) and applies the same atomic UPSERT / window aggregation
// semantics the real D1 performs, so the test asserts the STORE's algorithm
// (not SQL string matching) while still verifying correctness. `failWrites`
// / `failReads` simulate a broken binding to prove the fail-open contract.

export function createMockD1({ failWrites = false, failReads = false } = {}) {
  const rows = new Map(); // hour -> { input, output, total, requests, reports, missing }
  const modelRows = new Map(); // `${hour}|${model}` -> { ... }
  const writes = []; // every write's bind params, in order
  const reads = []; // every first()/all() read, for cache/coalescing assertions

  // Text-safe separator (not NUL) for composite hour|model keys. The hour
  // format is YYYY-MM-DDTHH:00:00Z and model names are simple strings, so
  // a pipe character never appears in either and is safe for git diff.
  const MODEL_KEY_SEP = '|';
  const modelKey = (hour, model) => `${hour}${MODEL_KEY_SEP}${model}`;
  const parseModelKey = (key) => {
    const idx = key.indexOf(MODEL_KEY_SEP);
    if (idx < 0) return null;
    return { hour: key.slice(0, idx), model: key.slice(idx + 1) };
  };

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
        if (/DELETE\s+FROM\s+token_usage_model_hourly/i.test(sql)) {
          const cutoffHour = this._params[0];
          let changes = 0;
          for (const key of [...modelRows.keys()]) {
            const parsed = parseModelKey(key);
            if (parsed && parsed.hour < cutoffHour) {
              modelRows.delete(key);
              changes++;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (/token_usage_model_hourly/i.test(sql)) {
          const [hour, model, input, output, total, req, reports, missing] = this._params;
          const key = modelKey(hour, model);
          const cur = modelRows.get(key)
            || { input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0 };
          modelRows.set(key, {
            input: cur.input + (input || 0),
            output: cur.output + (output || 0),
            total: cur.total + (total || 0),
            requests: cur.requests + (req || 0),
            reports: cur.reports + (reports || 0),
            missing: cur.missing + (missing || 0),
          });
        } else {
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
        }
        return { success: true };
      },
      async first() {
        reads.push({ method: 'first', sql, params: this._params });
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
        reads.push({ method: 'all', sql, params: this._params });
        if (failReads) throw new Error('mock D1 read failure');
        // queryRecentModelEvidence: SELECT model FROM ... WHERE hour >= ? AND
        // requests > 0 GROUP BY model. The `requests > 0` predicate is what
        // makes this the "recent-success evidence" signal. The mock applies
        // the same filter so the dashboard's model-status path gets the
        // right Set of model names.
        if (/GROUP BY model/i.test(sql) && /requests\s*>\s*0/i.test(sql)) {
          const startHour = this._params[0];
          const out = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            const { hour, model } = parsed;
            if (hour < startHour) continue;
            if ((r.requests || 0) <= 0) continue;
            out.set(model, true);
          }
          return { results: [...out.keys()].map((model) => ({ model })) };
        }
        // queryTokenModelUsage: SELECT model, SUM(...) GROUP BY model WHERE hour >= start.
        if (/GROUP BY model/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            const { hour, model } = parsed;
            if (hour < startHour) continue;
            const cur = byModel.get(model) || { total: 0, requests: 0 };
            byModel.set(model, { total: cur.total + r.total, requests: cur.requests + r.requests });
          }
          const results = [...byModel.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([model, r]) => ({ model, total: r.total, requests: r.requests }));
          return { results };
        }
        // queryTokenDailySeries: SELECT hour, SUM(...) GROUP BY hour WHERE hour >= start.
        const startHour = this._params[0];
        const byHour = new Map();
        for (const [hour, r] of rows) {
          if (hour < startHour) continue;
          const cur = byHour.get(hour) || { total: 0, requests: 0 };
          byHour.set(hour, { total: cur.total + r.total, requests: cur.requests + r.requests });
        }
        const results = [...byHour.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([hour, r]) => ({ hour, total: r.total, requests: r.requests }));
        return { results };
      },
    };
    return stmt;
  }

  return { prepare, _rows: rows, _modelRows: modelRows, _writes: writes, _reads: reads };
}
