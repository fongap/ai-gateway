// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal Cloudflare D1 test database for the token-usage store tests.
// It simulates the statements the real store issues:
//   * persistTokenUsage (global)    -> token_usage_hourly UPSERT
//   * persistTokenUsage (per-model) -> token_usage_model_hourly UPSERT
//   * persistTokenUsage (totals)    -> token_usage_totals UPSERT
//   * queryTokenSummary             -> SELECT from totals + hourly windows
//   * queryTokenDailySeries         -> SELECT from daily (with hourly fallback)
//   * queryTokenModelUsage          -> token_usage_model_hourly GROUP BY LOWER(TRIM(model))
//   * aggregateHourlyToDaily        -> SELECT hourly, INSERT daily (overwrite)
//   * aggregateDailyToWeekly        -> SELECT daily, INSERT weekly (overwrite)
//   * cleanupUsageRetention         -> DELETE from hourly/daily/weekly
// It is NOT a SQL parser: it recognises statements by shape (which table
// is touched) and applies the same atomic UPSERT / window aggregation
// semantics the real D1 performs, so the test asserts the STORE's algorithm
// (not SQL string matching) while still verifying correctness. `failWrites`
// / `failReads` simulate a broken binding to prove the fail-open contract.

export function createMockD1({ failWrites = false, failReads = false } = {}) {
  const rows = new Map(); // hour -> { input, output, total, requests, reports, missing }
  const modelRows = new Map(); // `${hour}|${model}` -> { ... }
  const totalsRow = { input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0, updated_at: '' };
  const dailyRows = new Map(); // day (YYYY-MM-DD) -> { input, output, total, requests, reports, missing }
  const weeklyRows = new Map(); // week_start (YYYY-MM-DD) -> { input, output, total, requests, reports, missing }
  const writes = []; // every write's bind params, in order
  const reads = []; // every first()/all() read, for cache/coalescing assertions

  const MODEL_KEY_SEP = '|';
  const modelKey = (hour, model) => `${hour}${MODEL_KEY_SEP}${model}`;
  const parseModelKey = (key) => {
    const idx = key.indexOf(MODEL_KEY_SEP);
    if (idx < 0) return null;
    return { hour: key.slice(0, idx), model: key.slice(idx + 1) };
  };
  const norm = (m) => String(m || '').trim().toLowerCase();

  function prepare(sql) {
    // Simulate the canonical grouping the real D1 performs for
    // `GROUP BY LOWER(TRIM(model))` (and, for legacy statements,
    // plain `GROUP BY model`): rows merge by the trimmed lowercase
    // model key and the `model` column comes back canonical.
    const groupByModelExpr = /GROUP\s+BY\s+LOWER\s*\(\s*TRIM\s*\(\s*model\s*\)\s*\)/i.test(sql)
      || /GROUP\s+BY\s+model/i.test(sql);
    const stmt = {
      _params: [],
      bind(...params) {
        this._params = params;
        return this;
      },
      async run() {
        writes.push({ sql, params: this._params });
        if (failWrites) throw new Error('mock D1 write failure');

        // DELETE FROM token_usage_model_hourly (legacy cleanupModelStats)
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

        // DELETE FROM token_usage_hourly (hourly cleanup)
        if (/DELETE\s+FROM\s+token_usage_hourly/i.test(sql)) {
          const cutoffHour = this._params[0];
          let changes = 0;
          for (const hour of [...rows.keys()]) {
            if (hour < cutoffHour) {
              rows.delete(hour);
              changes++;
            }
          }
          return { success: true, meta: { changes } };
        }

        // DELETE FROM token_usage_daily
        if (/DELETE\s+FROM\s+token_usage_daily/i.test(sql)) {
          const cutoffDay = this._params[0];
          let changes = 0;
          for (const day of [...dailyRows.keys()]) {
            if (day < cutoffDay) {
              dailyRows.delete(day);
              changes++;
            }
          }
          return { success: true, meta: { changes } };
        }

        // DELETE FROM token_usage_weekly
        if (/DELETE\s+FROM\s+token_usage_weekly/i.test(sql)) {
          const cutoffWeek = this._params[0];
          let changes = 0;
          for (const week of [...weeklyRows.keys()]) {
            if (week < cutoffWeek) {
              weeklyRows.delete(week);
              changes++;
            }
          }
          return { success: true, meta: { changes } };
        }

        // INSERT INTO token_usage_totals (totals upsert)
        if (/INSERT\s+INTO\s+token_usage_totals/i.test(sql)) {
          // SQL: VALUES ('global', ?, ?, ?, ?, ?, ?, ?) -- 7 params after 'global'
          const [input, output, total, req, reports, missing, updated_at] = this._params;
          totalsRow.input += input || 0;
          totalsRow.output += output || 0;
          totalsRow.total += total || 0;
          totalsRow.requests += req || 0;
          totalsRow.reports += reports || 0;
          totalsRow.missing += missing || 0;
          totalsRow.updated_at = updated_at || '';
          return { success: true };
        }

        // INSERT INTO token_usage_daily (daily upsert - overwrite)
        if (/INSERT\s+INTO\s+token_usage_daily/i.test(sql)) {
          const [day, input, output, total, req, reports, missing] = this._params;
          dailyRows.set(day, {
            input: input || 0,
            output: output || 0,
            total: total || 0,
            requests: req || 0,
            reports: reports || 0,
            missing: missing || 0,
          });
          return { success: true };
        }

        // INSERT INTO token_usage_weekly (weekly upsert - overwrite)
        if (/INSERT\s+INTO\s+token_usage_weekly/i.test(sql)) {
          const [week_start, input, output, total, req, reports, missing] = this._params;
          weeklyRows.set(week_start, {
            input: input || 0,
            output: output || 0,
            total: total || 0,
            requests: req || 0,
            reports: reports || 0,
            missing: missing || 0,
          });
          return { success: true };
        }

        // INSERT INTO token_usage_model_hourly
        if (/token_usage_model_hourly/i.test(sql)) {
          const [hour, model, input, output, total, req, reports, missing,
            successTtftCount, b0, b1, b2, b3, b4, b5, b6] = this._params;
          const key = modelKey(hour, model);
          const cur = modelRows.get(key)
            || { input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0,
                 successful_ttft_count: 0, ttft_b0: 0, ttft_b1: 0, ttft_b2: 0,
                 ttft_b3: 0, ttft_b4: 0, ttft_b5: 0, ttft_b6: 0 };
          modelRows.set(key, {
            input: cur.input + (input || 0),
            output: cur.output + (output || 0),
            total: cur.total + (total || 0),
            requests: cur.requests + (req || 0),
            reports: cur.reports + (reports || 0),
            missing: cur.missing + (missing || 0),
            successful_ttft_count: cur.successful_ttft_count + (successTtftCount || 0),
            ttft_b0: cur.ttft_b0 + (b0 || 0),
            ttft_b1: cur.ttft_b1 + (b1 || 0),
            ttft_b2: cur.ttft_b2 + (b2 || 0),
            ttft_b3: cur.ttft_b3 + (b3 || 0),
            ttft_b4: cur.ttft_b4 + (b4 || 0),
            ttft_b5: cur.ttft_b5 + (b5 || 0),
            ttft_b6: cur.ttft_b6 + (b6 || 0),
          });
          return { success: true };
        }

        // Default: global hourly UPSERT
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
        reads.push({ method: 'first', sql, params: this._params });
        if (failReads) throw new Error('mock D1 read failure');

        // SELECT from token_usage_totals (queryTokenSummary cumulative)
        if (/FROM\s+token_usage_totals/i.test(sql)) {
          // Return with column names matching the SQL SELECT
          return {
            input_tokens: totalsRow.input,
            output_tokens: totalsRow.output,
            total_tokens: totalsRow.total,
            requests: totalsRow.requests,
            usage_reports: totalsRow.reports,
            usage_missing: totalsRow.missing,
            updated_at: totalsRow.updated_at,
          };
        }

        // queryModelUsageCoverage: SELECT model, SUM(requests), SUM(usage_reports), SUM(usage_missing)
        // GROUP BY LOWER(TRIM(model)) WHERE hour >= ?
        if (groupByModelExpr && /usage_reports/i.test(sql) && /usage_missing/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            if (parsed.hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { requests: 0, reports: 0, missing: 0 };
            byModel.set(model, {
              requests: cur.requests + (r.requests || 0),
              reports: cur.reports + (r.reports || 0),
              missing: cur.missing + (r.missing || 0),
            });
          }
          const results = [...byModel.entries()]
            .sort((a, b) => b[1].requests - a[1].requests)
            .map(([model, r]) => ({ model, requests: r.requests, reports: r.reports, missing: r.missing }));
          return { results };
        }

        // queryTokenSummary windows from hourly (today/h24/d7)
        // Recognize by the CASE WHEN hour >= pattern.
        if (/CASE\s+WHEN\s+hour\s*>=/i.test(sql)) {
          const [todayStart, , h24Start, , d7Start] = this._params;
          let today_total = 0, today_requests = 0;
          let h24_total = 0, h24_requests = 0, d7_total = 0, d7_requests = 0;
          for (const [hour, r] of rows) {
            if (hour >= todayStart) { today_total += r.total; today_requests += r.requests; }
            if (hour >= h24Start) { h24_total += r.total; h24_requests += r.requests; }
            if (hour >= d7Start) { d7_total += r.total; d7_requests += r.requests; }
          }
          return {
            today_total, today_requests,
            h24_total, h24_requests, d7_total, d7_requests,
          };
        }

        // Fallback cumulative scan (for rolling-deploy safety)
        if (/SUM\(total_tokens\)|SUM\(requests\)|SUM\(usage_reports\)|SUM\(usage_missing\)/i.test(sql) &&
            !/CASE\s+WHEN/i.test(sql)) {
          let t = 0, r = 0, rp = 0, rm = 0;
          for (const [, v] of rows) {
            t += v.total; r += v.requests; rp += v.reports; rm += v.missing;
          }
          return { t, r, rp, rm };
        }

        return null;
      },
      async all() {
        reads.push({ method: 'all', sql, params: this._params });
        if (failReads) throw new Error('mock D1 read failure');

        // queryRecentModelEvidence: SELECT model FROM ... WHERE hour >= ? AND requests > 0 GROUP BY LOWER(TRIM(model))
        if (groupByModelExpr && /requests\s*>\s*0/i.test(sql)) {
          const startHour = this._params[0];
          const out = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            const { hour } = parsed;
            if (hour < startHour) continue;
            if ((r.requests || 0) <= 0) continue;
            out.set(norm(parsed.model), true);
          }
          return { results: [...out.keys()].map((model) => ({ model })) };
        }

        // queryAllModelsTtftPercentiles: SELECT model, SUM(successful_ttft_count), SUM(ttft_b0..b6)
        // GROUP BY LOWER(TRIM(model)) WHERE hour >= ?
        if (groupByModelExpr && /successful_ttft_count/i.test(sql) && /ttft_b0/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            if (parsed.hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { total_ttft: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
            byModel.set(model, {
              total_ttft: cur.total_ttft + (r.successful_ttft_count || 0),
              b0: cur.b0 + (r.ttft_b0 || 0),
              b1: cur.b1 + (r.ttft_b1 || 0),
              b2: cur.b2 + (r.ttft_b2 || 0),
              b3: cur.b3 + (r.ttft_b3 || 0),
              b4: cur.b4 + (r.ttft_b4 || 0),
              b5: cur.b5 + (r.ttft_b5 || 0),
              b6: cur.b6 + (r.ttft_b6 || 0),
            });
          }
          return { results: [...byModel.entries()].map(([model, r]) => ({ model, ...r })) };
        }

        // queryModelUsageCoverage (all): SELECT model, SUM(requests), SUM(usage_reports), SUM(usage_missing)
        // GROUP BY LOWER(TRIM(model)) WHERE hour >= ?
        if (groupByModelExpr && /usage_reports/i.test(sql) && /usage_missing/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            if (parsed.hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { requests: 0, reports: 0, missing: 0 };
            byModel.set(model, {
              requests: cur.requests + (r.requests || 0),
              reports: cur.reports + (r.reports || 0),
              missing: cur.missing + (r.missing || 0),
            });
          }
          const results = [...byModel.entries()]
            .sort((a, b) => b[1].requests - a[1].requests)
            .map(([model, r]) => ({ model, requests: r.requests, reports: r.reports, missing: r.missing }));
          return { results };
        }

        // queryTokenModelUsage: SELECT model, SUM(...) GROUP BY LOWER(TRIM(model)) WHERE hour >= start.
        if (groupByModelExpr) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed) continue;
            const { hour } = parsed;
            if (hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { total: 0, requests: 0 };
            byModel.set(model, { total: cur.total + r.total, requests: cur.requests + r.requests });
          }
          const results = [...byModel.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([model, r]) => ({ model, total: r.total, requests: r.requests }));
          return { results };
        }

        // queryTokenDailySeries: SELECT day, ... FROM token_usage_daily WHERE day >= ?
        if (/FROM\s+token_usage_daily/i.test(sql)) {
          const startDay = this._params[0];
          const results = [];
          for (const [day, r] of dailyRows) {
            if (day < startDay) continue;
            results.push({
              day,
              input_tokens: r.input,
              output_tokens: r.output,
              total_tokens: r.total,
              requests: r.requests,
              usage_reports: r.reports,
              usage_missing: r.missing,
            });
          }
          results.sort((a, b) => (a.day < b.day ? -1 : 1));
          return { results };
        }

        // SELECT hourly for daily series fallback / today overlay
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

  return {
    prepare,
    // Construct a raw per-model row directly in the simulated table,
    // bypassing persistTokenUsage() — the writer canonicalizes its model
    // key, so tests that need HISTORICAL case variants (Code-Max /
    // CODE-MAX / padded strings) must seed rows at this level. The hour
    // key is normalized exactly like the writer's normalizeHour() so
    // window comparisons behave like real rows.
    seedModelRow(hour, model, fields = {}) {
      const hourKey = typeof hour === 'number'
        ? new Date(Math.floor(hour / 3_600_000) * 3_600_000).toISOString()
        : hour;
      modelRows.set(modelKey(hourKey, model), {
        input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0,
        successful_ttft_count: 0, ttft_b0: 0, ttft_b1: 0, ttft_b2: 0,
        ttft_b3: 0, ttft_b4: 0, ttft_b5: 0, ttft_b6: 0,
        ...fields,
      });
    },
    _rows: rows, _modelRows: modelRows, _totalsRow: totalsRow, _dailyRows: dailyRows, _weeklyRows: weeklyRows, _writes: writes, _reads: reads,
  };
}