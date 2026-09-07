// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public Model Status — a read-only, cross-isolate aggregate that answers:
//
//   "Does this logical model have credible evidence of serving recently?"
//
// It is intentionally NOT the same as Runtime Availability
// (src/runtime/availability.ts). Runtime Availability describes THIS isolate's
// scheduling state (Tier 1 passive TTFT, Tier 2/3 circuit + cooldown) and is
// the correct signal for P2C / cooldown / hedge / failover. Public Model
// Status describes the user-facing service state across isolates, restarts
// and PoPs, because a fresh isolate has no Tier 1 samples even though the
// model is clearly serving fine on other isolates.
//
// Direction (one-way, never reversed):
//
//   Runtime / Observability
//          ↓
//   Public Model Status
//          ↓
//   Dashboard HTML
//
// Public Model Status NEVER feeds back into the scheduler, reliability layer,
// transport, request handler, protocol fallback, hedge or failover. It is a
// pure read-only projection.
//
// Five states (kept stable for the UI):
//   available     近 24 小时存在成功服务证据,且当前无全部候选故障事实
//   fluctuating   当前存在明确异常,但近 24 小时仍有成功服务证据
//   no_recent     近 24 小时无新成功记录,但近 7d 保留窗口内存在成功记录
//   no_record     模型已配置公开,但统计保留窗口内没有任何成功记录
//   down          当前已有明确 Runtime 故障事实(全部 serving candidate
//                 unavailable 且近 24 小时无成功证据)
//
// Recent-success evidence source: the existing D1 per-model hourly aggregate
// (token_usage_model_hourly). A row with requests > 0 in the recent window
// means the model successfully completed at least one real request in that
// hour. We do NOT introduce a new persistence table, a new health database, or
// a second statistics system. See queryRecentModelEvidence() in
// token-usage-store/queries.ts.
//
// Public-safety: this module NEVER reads credentials, node ids, providers or
// tiers into its outputs. The return value is a list of { id, status } only.

import { loadModelRegistry, servesModel, collectKnownModels } from '../config/registry.ts';
import { getRuntimeAvailability } from './availability.ts';
import { normalizeModelKey } from '../observability/token-usage-store.ts';
import type { RegistryEntry } from '../config/registry.ts';
import type { RuntimeNode } from '../types/node.ts';

// Recent-evidence window. The D1 per-model table stores UTC hourly buckets
// with a 7-day retention (cleanupModelStats prunes older rows). A 24-hour
// window is:
//   * long enough to survive isolate cold-starts and short PoP rotations
//     (a fresh isolate rendering the dashboard still sees yesterday's
//     successful traffic and reports `available`, which is the bug fix);
//   * short enough that a model that has been broken for a full day no
//     longer shows `available` solely from stale evidence;
//   * aligned with the existing hourly bucket granularity, so the query is
//     a single GROUP BY over a small number of rows.
//
// Single source of truth for the Recent Evidence window lives next to the
// query that parameterizes it (token-usage-store/queries.ts); re-exported
// here because Model Status semantics own the public surface.
export {
  MODEL_STATUS_RECENT_WINDOW_MS,
  MODEL_STATUS_HISTORICAL_WINDOW_MS,
} from '../observability/token-usage-store.ts';

export type PublicModelStatusState = 'available' | 'fluctuating' | 'no_recent' | 'no_record' | 'down';

export type PublicModelStatusEntry = {
  id: string,
  status: PublicModelStatusState,
  display_order: number,
  group: string,
};

// Pure function: compute the public five-state status for every logical
// model known to the gateway.
//
// Source of model names: node mappings are the PRIMARY source — the operator
// declares models where they actually live (in TIER1/TIER2/TIER3_NODES_CONFIG_*).
// MODELS_CONFIG is an OPTIONAL metadata layer that may downgrade a model to
// `visibility: 'internal'` to hide it from the public catalog; it NEVER
// narrows or widens the visible model set on its own. This keeps the operator
// from having to enumerate every free model in a separate config file.
//
// Inputs:
//   nodes             : Runtime Node[] (from loadGatewayConfig(env).nodes)
//   env               : The Worker env (used to read MODELS_CONFIG via
//                       loadModelRegistry for visibility filtering only).
//   evidence          : Set<string> of canonical statistical model keys (trim +
//                       lowercase) with recent (24h) success. An empty set is the
//                       fail-open shape — never null. Non-canonical entries are
//                       normalized once on entry.
//   historicalEvidence: Set<string> of canonical model keys with success within
//                       the historical retention window (7d). Used only to
//                       distinguish 无新记录 (history exists, recent does not)
//                       from 暂无记录 (no history at all). Empty set is valid
//                       and honest.
//   now               : Optional clock for deterministic tests.
//
// Output:
//   { observed_at: <ISO string>, models: [ { id, status }, ... ] }
//
// The list is sorted by logical model id for stable rendering. No node ids,
// providers, tiers, counts or durations leave this function.

function deriveGroup(name: string): string {
  if (name.startsWith('Code-')) return 'code';
  if (name === 'Omni') return 'omni';
  if (name === 'OCR') return 'ocr';
  return 'general';
}

const MODEL_NAME_PRIORITY: Record<string, number> = {
  air: 10, pro: 20, max: 30, ultra: 40,
};
const GROUP_PRIORITY: Record<string, number> = { general: 0, code: 1, omni: 2, ocr: 3 };
function modelNamePriority(name: string): number {
  const lower = name.toLowerCase().replace(/^code-/, '');
  return MODEL_NAME_PRIORITY[lower] ?? 90;
}

export function getPublicModelStatus(nodes: ReadonlyArray<RuntimeNode>, env: Record<string, unknown> | null | undefined, evidence: ReadonlySet<string> = new Set(), now: number = Date.now(), historicalEvidence: ReadonlySet<string> = new Set()): { observed_at: string, models: PublicModelStatusEntry[] } {
  const names = new Set<string>();
  for (const node of nodes || []) {
    for (const key of Object.keys(node.models || {})) names.add(key);
  }
  let visibility: Record<string, string> = {};
  let uiVisible: Record<string, boolean> = {};
  let registry: Record<string, RegistryEntry> = {};
  if (env) {
    try {
      registry = loadModelRegistry(env);
      for (const [name, entry] of Object.entries(registry)) {
        visibility[name] = entry.visibility || 'public';
        uiVisible[name] = entry.ui_visible !== false;
      }
    } catch { /* registry not loadable: everything is public + ui visible */ }
  }
  // Canonicalize evidence ONCE on entry: D1 statistics keys are
  // trim + lowercase, while the public model ids below keep their official
  // logical casing (Code-Max). Matching is always canonical-statistical-key
  // vs canonical-statistical-key.
  const canonicalEvidence = new Set<string>();
  for (const key of evidence instanceof Set ? evidence : new Set()) {
    const canonical = normalizeModelKey(key);
    if (canonical) canonicalEvidence.add(canonical);
  }
  const canonicalHistorical = new Set<string>();
  for (const key of historicalEvidence instanceof Set ? historicalEvidence : new Set()) {
    const canonical = normalizeModelKey(key);
    if (canonical) canonicalHistorical.add(canonical);
  }
  // The Known Model Catalog bounds wildcard nodes so a wildcard node only
  // serves models that actually exist in the gateway. The public name set
  // stays node-mapped (an operator declares models where they live); the
  // catalog is the same single source used by authorization.
  const knownModels = collectKnownModels(nodes, env ?? undefined);
  const models: PublicModelStatusEntry[] = [];
  for (const name of [...names]) {
    if (visibility[name] === 'internal') continue;
    if (uiVisible[name] === false) continue;
    const serving = (nodes || []).filter((n) => servesModel(n, name, knownModels));
    const status = modelStatus(name, serving, canonicalEvidence, canonicalHistorical, now);
    const entry: RegistryEntry | undefined = registry[name];
    models.push({
      id: name,
      status,
      display_order: entry?.display_order !== undefined ? entry?.display_order : 100,
      group: entry?.group !== undefined ? entry?.group : deriveGroup(name),
    });
  }
  models.sort((a, b) => {
    const ga = GROUP_PRIORITY[a.group] ?? 9;
    const gb = GROUP_PRIORITY[b.group] ?? 9;
    if (ga !== gb) return ga - gb;
    const diff = a.display_order - b.display_order;
    if (diff !== 0) return diff;
    const pa = modelNamePriority(a.id);
    const pb = modelNamePriority(b.id);
    return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
  });
  return { observed_at: new Date(now).toISOString(), models };
}

// Compute the public five-state status for one logical model.
//
// Priority (fixed, never reordered):
//   1. No serving candidate at all            -> down (服务故障)
//   2. Any candidate runtime-available now    -> available (服务可用)
//   3. ALL candidates runtime-down + 24h hit  -> fluctuating (服务波动)
//   4. ALL candidates runtime-down, no 24h hit -> down (服务故障)
//   5. Some unobserved + 24h hit              -> available (服务可用)
//   6. No available, not all-down, 7d hit     -> no_recent (无新记录)
//   7. No available, not all-down, no 7d hit  -> no_record (暂无记录)
function modelStatus(name: string, serving: RuntimeNode[], recentEvidence: ReadonlySet<string>, historicalEvidence: ReadonlySet<string>, now: number): PublicModelStatusState {
  if (!serving.length) return 'down';

  const states = serving.map((n) => getRuntimeAvailability(n, name, now));
  // Statistics key (trim + lowercase), never the raw official ID: a model
  // named Code-Max must match its `code-max` D1 evidence row.
  const key = normalizeModelKey(name);
  const hasRecent = recentEvidence.has(key);
  const hasHistory = historicalEvidence.has(key);

  // At least one candidate is currently available AND eligible.
  const anyAvailable = states.some((s) => s === 'available');
  // Every serving candidate is currently runtime-unavailable (circuit open,
  // cooldown, disabled, hard-RPM exhausted).
  const allDown = states.every((s) => s === 'unavailable');
  // At least one candidate is configured-but-unobserved by THIS isolate
  // (Tier 1 with no TTFT sample, or half-open).
  const anyUnobserved = states.some((s) => s === 'unobserved');

  // 1. Already handled above (no serving candidates).
  // 2. A working path exists right now in this isolate.
  if (anyAvailable) return 'available';
  // 3. Every candidate is explicitly down right now, but cross-isolate
  //    evidence says the model served in the last 24h. Transient outage.
  if (allDown) return hasRecent ? 'fluctuating' : 'down';
  // 5. Some candidate is unobserved (fresh isolate, no TTFT sample) rather
  //    than confirmed-down, and 24h evidence says the model works elsewhere.
  if (anyUnobserved && hasRecent) return 'available';
  // 6. No candidate is currently available and there is no confirmed all-down
  //    (so we cannot claim down), but no 24h evidence. If 7d history exists
  //    this is merely stale — not broken.
  if (hasHistory) return 'no_recent';
  // 7. No evidence anywhere we can honestly read. Configured, not yet
  //    observed, not yet served: the honest answer is no_record.
  return 'no_record';
}
