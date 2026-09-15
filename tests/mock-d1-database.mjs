// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Minimal Cloudflare D1 test database for the token-usage store tests.
// It simulates both durable accounting views that share the production tables:
//   * delivered columns (`requests`, `total_tokens`, TTFT evidence)
//   * physical upstream-attempt columns (`upstream_attempts`, `upstream_total_tokens`)
//
// It is NOT a SQL parser: statements are recognised by table/query shape and
// the same additive/overwrite semantics as the real store are applied. This
// keeps tests focused on store contracts while `failWrites` / `failReads`
// exercise fail-open behaviour.

export function createMockD1({ failWrites = false, failReads = false } = {}) {
  const emptyUsage = () => ({
    input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0,
    requests: 0, reports: 0, missing: 0,
    upstreamInput: 0, upstreamOutput: 0, upstreamCacheCreation: 0, upstreamCacheRead: 0,
    upstreamTotal: 0, upstreamAttempts: 0, upstreamReports: 0, upstreamMissing: 0,
  });
  const emptyModel = () => ({
    ...emptyUsage(),
    successful_ttft_count: 0,
    ttft_b0: 0, ttft_b1: 0, ttft_b2: 0, ttft_b3: 0, ttft_b4: 0, ttft_b5: 0, ttft_b6: 0,
  });

  const rows = new Map();
  const modelRows = new Map();
  const totalsRow = { ...emptyUsage(), updated_at: '' };
  const dailyRows = new Map();
  const weeklyRows = new Map();
  const writes = [];
  const reads = [];

  const MODEL_KEY_SEP = '|';
  const modelKey = (hour, model) => `${hour}${MODEL_KEY_SEP}${model}`;
  const parseModelKey = (key) => {
    const idx = key.indexOf(MODEL_KEY_SEP);
    if (idx < 0) return null;
    return { hour: key.slice(0, idx), model: key.slice(idx + 1) };
  };
  const norm = (m) => String(m || '').trim().toLowerCase();
  const addDelivered = (cur, values) => {
    const [input, output, cacheCreation, cacheRead, total, requests, reports, missing] = values;
    cur.input += input || 0;
    cur.output += output || 0;
    cur.cacheCreation += cacheCreation || 0;
    cur.cacheRead += cacheRead || 0;
    cur.total += total || 0;
    cur.requests += requests || 0;
    cur.reports += reports || 0;
    cur.missing += missing || 0;
  };
  const addUpstream = (cur, values) => {
    const [input, output, cacheCreation, cacheRead, total, attempts, reports, missing] = values;
    cur.upstreamInput += input || 0;
    cur.upstreamOutput += output || 0;
    cur.upstreamCacheCreation += cacheCreation || 0;
    cur.upstreamCacheRead += cacheRead || 0;
    cur.upstreamTotal += total || 0;
    cur.upstreamAttempts += attempts || 0;
    cur.upstreamReports += reports || 0;
    cur.upstreamMissing += missing || 0;
  };
  const toSqlRow = (r) => ({
    input_tokens: r.input,
    output_tokens: r.output,
    cache_creation_input_tokens: r.cacheCreation,
    cache_read_input_tokens: r.cacheRead,
    total_tokens: r.total,
    requests: r.requests,
    usage_reports: r.reports,
    usage_missing: r.missing,
    upstream_input_tokens: r.upstreamInput,
    upstream_output_tokens: r.upstreamOutput,
    upstream_cache_creation_input_tokens: r.upstreamCacheCreation,
    upstream_cache_read_input_tokens: r.upstreamCacheRead,
    upstream_total_tokens: r.upstreamTotal,
    upstream_attempts: r.upstreamAttempts,
    upstream_usage_reports: r.upstreamReports,
    upstream_usage_missing: r.upstreamMissing,
  });

  function prepare(sql) {
    const groupByModelExpr = /GROUP\s+BY\s+LOWER\s*\(\s*TRIM\s*\(\s*model\s*\)\s*\)/i.test(sql)
      || /GROUP\s+BY\s+model/i.test(sql);
    const usesUpstream = /upstream_(?:total_tokens|attempts|usage_reports|usage_missing|input_tokens|output_tokens)/i.test(sql);
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
            if (parsed && parsed.hour < cutoffHour) { modelRows.delete(key); changes++; }
          }
          return { success: true, meta: { changes } };
        }
        if (/DELETE\s+FROM\s+token_usage_hourly/i.test(sql)) {
          const cutoffHour = this._params[0];
          let changes = 0;
          for (const hour of [...rows.keys()]) {
            if (hour < cutoffHour) { rows.delete(hour); changes++; }
          }
          return { success: true, meta: { changes } };
        }
        if (/DELETE\s+FROM\s+token_usage_daily/i.test(sql)) {
          const cutoffDay = this._params[0];
          let changes = 0;
          for (const day of [...dailyRows.keys()]) {
            if (day < cutoffDay) { dailyRows.delete(day); changes++; }
          }
          return { success: true, meta: { changes } };
        }
        if (/DELETE\s+FROM\s+token_usage_weekly/i.test(sql)) {
          const cutoffWeek = this._params[0];
          let changes = 0;
          for (const week of [...weeklyRows.keys()]) {
            if (week < cutoffWeek) { weeklyRows.delete(week); changes++; }
          }
          return { success: true, meta: { changes } };
        }

        if (/INSERT\s+INTO\s+token_usage_totals/i.test(sql)) {
          const deliveredWrite = /scope\s*,\s*input_tokens/i.test(sql);
          if (deliveredWrite) {
            addDelivered(totalsRow, this._params.slice(0, 8));
            totalsRow.updated_at = this._params[8] || '';
            if (this._params.length >= 17) addUpstream(totalsRow, this._params.slice(9, 17));
          } else {
            addUpstream(totalsRow, this._params.slice(0, 8));
            totalsRow.updated_at = this._params[8] || '';
          }
          return { success: true };
        }

        if (/INSERT\s+INTO\s+token_usage_daily/i.test(sql)) {
          const day = this._params[0];
          const row = emptyUsage();
          if (usesUpstream && this._params.length >= 17) {
            addDelivered(row, this._params.slice(1, 9));
            addUpstream(row, this._params.slice(9, 17));
          } else {
            // Legacy aggregation statements used total/request fields only;
            // preserve compatibility for tests that seed old statement shapes.
            const [input, output, total, req, reports, missing] = this._params.slice(1);
            addDelivered(row, [input, output, 0, 0, total, req, reports, missing]);
          }
          dailyRows.set(day, row);
          return { success: true };
        }

        if (/INSERT\s+INTO\s+token_usage_weekly/i.test(sql)) {
          const week = this._params[0];
          const row = emptyUsage();
          if (usesUpstream && this._params.length >= 17) {
            addDelivered(row, this._params.slice(1, 9));
            addUpstream(row, this._params.slice(9, 17));
          } else {
            const [input, output, total, req, reports, missing] = this._params.slice(1);
            addDelivered(row, [input, output, 0, 0, total, req, reports, missing]);
          }
          weeklyRows.set(week, row);
          return { success: true };
        }

        if (/token_usage_model_hourly/i.test(sql)) {
          const [hour, model] = this._params;
          const key = modelKey(hour, model);
          const cur = modelRows.get(key) || emptyModel();
          if (/successful_ttft_count/i.test(sql)) {
            // Stable legacy prefix: hour, model, 8 delivered values, TTFT count
            // + seven buckets. The new eight upstream values are appended.
            addDelivered(cur, this._params.slice(2, 10));
            const [successTtftCount, b0, b1, b2, b3, b4, b5, b6] = this._params.slice(10, 18);
            cur.successful_ttft_count += successTtftCount || 0;
            cur.ttft_b0 += b0 || 0; cur.ttft_b1 += b1 || 0; cur.ttft_b2 += b2 || 0;
            cur.ttft_b3 += b3 || 0; cur.ttft_b4 += b4 || 0; cur.ttft_b5 += b5 || 0; cur.ttft_b6 += b6 || 0;
            if (this._params.length >= 26) addUpstream(cur, this._params.slice(18, 26));
          } else if (usesUpstream) {
            addUpstream(cur, this._params.slice(2, 10));
          } else {
            addDelivered(cur, this._params.slice(2, 10));
          }
          modelRows.set(key, cur);
          return { success: true };
        }

        // token_usage_hourly writes. A success statement carries the legacy
        // delivered prefix plus eight appended upstream values; an undelivered
        // physical attempt carries only the upstream set.
        const [hour] = this._params;
        const cur = rows.get(hour) || emptyUsage();
        if (usesUpstream && this._params.length >= 17) {
          addDelivered(cur, this._params.slice(1, 9));
          addUpstream(cur, this._params.slice(9, 17));
        } else if (usesUpstream) {
          addUpstream(cur, this._params.slice(1, 9));
        } else {
          addDelivered(cur, this._params.slice(1, 9));
        }
        rows.set(hour, cur);
        return { success: true };
      },

      async first() {
        reads.push({ method: 'first', sql, params: this._params });
        if (failReads) throw new Error('mock D1 read failure');

        if (/FROM\s+token_usage_totals/i.test(sql)) {
          if (usesUpstream) {
            return {
              upstream_total_tokens: totalsRow.upstreamTotal,
              upstream_attempts: totalsRow.upstreamAttempts,
              upstream_usage_reports: totalsRow.upstreamReports,
              upstream_usage_missing: totalsRow.upstreamMissing,
              updated_at: totalsRow.updated_at,
            };
          }
          return { ...toSqlRow(totalsRow), updated_at: totalsRow.updated_at };
        }

        if (groupByModelExpr && /usage_reports/i.test(sql) && /usage_missing/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed || parsed.hour < startHour) continue;
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
            .map(([model, r]) => ({ model, ...r }));
          return { results };
        }

        if (/CASE\s+WHEN\s+hour\s*>=/i.test(sql)) {
          const [todayStart, , h24Start, , d7Start] = this._params;
          if (usesUpstream) {
            let today_total = 0, today_attempts = 0, h24_total = 0, h24_attempts = 0, d7_total = 0, d7_attempts = 0;
            for (const [hour, r] of rows) {
              if (hour >= todayStart) { today_total += r.upstreamTotal; today_attempts += r.upstreamAttempts; }
              if (hour >= h24Start) { h24_total += r.upstreamTotal; h24_attempts += r.upstreamAttempts; }
              if (hour >= d7Start) { d7_total += r.upstreamTotal; d7_attempts += r.upstreamAttempts; }
            }
            return { today_total, today_attempts, h24_total, h24_attempts, d7_total, d7_attempts };
          }
          let today_total = 0, today_requests = 0, h24_total = 0, h24_requests = 0, d7_total = 0, d7_requests = 0;
          for (const [hour, r] of rows) {
            if (hour >= todayStart) { today_total += r.total; today_requests += r.requests; }
            if (hour >= h24Start) { h24_total += r.total; h24_requests += r.requests; }
            if (hour >= d7Start) { d7_total += r.total; d7_requests += r.requests; }
          }
          return { today_total, today_requests, h24_total, h24_requests, d7_total, d7_requests };
        }

        if (/SUM\((?:upstream_)?total_tokens\)|SUM\((?:upstream_)?attempts\)|SUM\(requests\)|SUM\((?:upstream_)?usage_reports\)|SUM\((?:upstream_)?usage_missing\)/i.test(sql)
            && !/CASE\s+WHEN/i.test(sql)) {
          if (usesUpstream) {
            let t = 0, a = 0, rp = 0, rm = 0;
            for (const r of rows.values()) { t += r.upstreamTotal; a += r.upstreamAttempts; rp += r.upstreamReports; rm += r.upstreamMissing; }
            return { t, a, rp, rm };
          }
          let t = 0, r = 0, rp = 0, rm = 0;
          for (const v of rows.values()) { t += v.total; r += v.requests; rp += v.reports; rm += v.missing; }
          return { t, r, rp, rm };
        }
        return null;
      },

      async all() {
        reads.push({ method: 'all', sql, params: this._params });
        if (failReads) throw new Error('mock D1 read failure');

        if (groupByModelExpr && /requests\s*>\s*0/i.test(sql)) {
          const startHour = this._params[0];
          const out = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed || parsed.hour < startHour || (r.requests || 0) <= 0) continue;
            out.set(norm(parsed.model), true);
          }
          return { results: [...out.keys()].map((model) => ({ model })) };
        }

        if (groupByModelExpr && /successful_ttft_count/i.test(sql) && /ttft_b0/i.test(sql)) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed || parsed.hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { total_ttft: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
            byModel.set(model, {
              total_ttft: cur.total_ttft + (r.successful_ttft_count || 0),
              b0: cur.b0 + (r.ttft_b0 || 0), b1: cur.b1 + (r.ttft_b1 || 0),
              b2: cur.b2 + (r.ttft_b2 || 0), b3: cur.b3 + (r.ttft_b3 || 0),
              b4: cur.b4 + (r.ttft_b4 || 0), b5: cur.b5 + (r.ttft_b5 || 0), b6: cur.b6 + (r.ttft_b6 || 0),
            });
          }
          return { results: [...byModel.entries()].map(([model, r]) => ({ model, ...r })) };
        }

        if (groupByModelExpr && /usage_reports/i.test(sql) && /usage_missing/i.test(sql) && !usesUpstream) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed || parsed.hour < startHour) continue;
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
            .map(([model, r]) => ({ model, ...r }));
          return { results };
        }

        if (groupByModelExpr) {
          const startHour = this._params[0];
          const byModel = new Map();
          for (const [key, r] of modelRows) {
            const parsed = parseModelKey(key);
            if (!parsed || parsed.hour < startHour) continue;
            const model = norm(parsed.model);
            const cur = byModel.get(model) || { total: 0, requests: 0, attempts: 0 };
            if (usesUpstream) {
              cur.total += r.upstreamTotal || 0;
              cur.attempts += r.upstreamAttempts || 0;
            } else {
              cur.total += r.total || 0;
              cur.requests += r.requests || 0;
            }
            byModel.set(model, cur);
          }
          const results = [...byModel.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([model, r]) => usesUpstream
              ? ({ model, total: r.total, attempts: r.attempts })
              : ({ model, total: r.total, requests: r.requests }));
          return { results };
        }

        if (/FROM\s+token_usage_daily/i.test(sql)) {
          const startDay = this._params[0];
          const results = [];
          for (const [day, r] of dailyRows) {
            if (startDay && day < startDay) continue;
            results.push({ day, ...toSqlRow(r) });
          }
          results.sort((a, b) => (a.day < b.day ? -1 : 1));
          return { results };
        }

        // Raw hourly scan used by hourly->daily materialization.
        if (/FROM\s+token_usage_hourly/i.test(sql) && !/GROUP\s+BY\s+hour/i.test(sql)) {
          return {
            results: [...rows.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([hour, r]) => ({ hour, ...toSqlRow(r) })),
          };
        }

        // Hourly grouped/fallback reads used by daily-series queries.
        const startHour = this._params[0];
        const results = [];
        for (const [hour, r] of rows) {
          if (startHour && hour < startHour) continue;
          if (usesUpstream) {
            results.push({
              hour,
              total: r.upstreamTotal,
              attempts: r.upstreamAttempts,
              reports: r.upstreamReports,
              missing: r.upstreamMissing,
            });
          } else {
            results.push({ hour, total: r.total, requests: r.requests, reports: r.reports, missing: r.missing });
          }
        }
        results.sort((a, b) => (a.hour < b.hour ? -1 : 1));
        return { results };
      },
    };
    return stmt;
  }

  return {
    prepare,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    seedModelRow(hour, model, fields = {}) {
      const hourKey = typeof hour === 'number'
        ? new Date(Math.floor(hour / 3_600_000) * 3_600_000).toISOString()
        : hour;
      modelRows.set(modelKey(hourKey, model), { ...emptyModel(), ...fields });
    },
    _rows: rows,
    _modelRows: modelRows,
    _totalsRow: totalsRow,
    _dailyRows: dailyRows,
    _weeklyRows: weeklyRows,
    _writes: writes,
    _reads: reads,
  };
}
