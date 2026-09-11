// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public-safe model status rendering. The model status section on the public
// dashboard renders the Public Model Catalog — the logical models that
// exist in the Model Registry and have at least one serving node. No node
// ids, providers, tiers, counts or durations ever leave this module, and no
// model name or prefix carries any business meaning.

import { getPublicModelStatus } from '../runtime/model-status.ts';
import { normalizeModelKey } from '../observability/token-usage-store.ts';
import { escapeHtml } from './format.ts';
import type { PublicModelStatusEntry, PublicModelStatusState } from '../runtime/model-status.ts';
import type { RuntimeNode } from '../types/node.ts';

const STATE_LABEL: Record<PublicModelStatusState, string> = {
  available: '服务可用',
  fluctuating: '服务波动',
  no_recent: '无新记录',
  no_record: '暂无记录',
  down: '服务故障',
};
const STATE_STYLE: Record<PublicModelStatusState, string> = {
  available: '',
  fluctuating: ' warn',
  no_recent: ' muted',
  no_record: ' muted',
  down: ' down',
};

const STATE_TOOLTIP: Record<PublicModelStatusState, string> = {
  available: '近 24 小时存在成功服务证据',
  fluctuating: '近期成功过，但当前服务状态存在异常',
  no_recent: '近 24 小时无新成功记录，更早存在成功记录',
  no_record: '当前模型统计保留期内暂无成功记录',
  down: '当前已知服务路径均不可用',
};

export type DashboardModelStatusEnvelope = {
  observed_at: string,
  models: PublicModelStatusEntry[],
};

// Optional dashboard-only allowlist. DASHBOARD_MODELS is a comma-separated
// Worker text variable. It affects only the public model-status rows:
// routing, authorization, /v1/models, fallback and observability are untouched.
// Matching is canonical/case-insensitive, display keeps the official logical
// model id, unknown names are ignored, duplicates are removed, and configured
// order is preserved. Empty/unset keeps the full public catalog.
export function filterDashboardModelStatus(status: DashboardModelStatusEnvelope, raw: unknown): DashboardModelStatusEnvelope {
  const configured = typeof raw === 'string' ? raw.trim() : '';
  if (!configured) return status;

  const byKey = new Map<string, PublicModelStatusEntry>();
  for (const model of status.models || []) {
    const key = normalizeModelKey(model.id);
    if (key && !byKey.has(key)) byKey.set(key, model);
  }

  const seen = new Set<string>();
  const models: PublicModelStatusEntry[] = [];
  for (const token of configured.split(',')) {
    const key = normalizeModelKey(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const model = byKey.get(key);
    if (model) models.push(model);
  }

  return { ...status, models };
}

// PublicModelStatus wrapper used by the dashboard. `historicalEvidence` is the
// 7-day retention-window evidence set used to distinguish 无新记录 from
// 暂无记录; it is optional and defaults to empty (fail-open, never fabricated).
export function publicModelStatus(nodes: ReadonlyArray<RuntimeNode>, env: Record<string, unknown> | null | undefined, evidence: ReadonlySet<string> = new Set(), now: number = Date.now(), historicalEvidence: ReadonlySet<string> = new Set()): DashboardModelStatusEnvelope {
  const status = getPublicModelStatus(nodes, env, evidence, now, historicalEvidence);
  return filterDashboardModelStatus(status, env?.DASHBOARD_MODELS);
}

// Flat list of { id, status } rows from the status envelope.
export function modelStatusRows(status: { models?: PublicModelStatusEntry[] } | null | undefined): PublicModelStatusEntry[] {
  if (!status || !Array.isArray(status.models)) return [];
  return status.models;
}

export type TtftEntry = { available?: boolean, p50?: number | null, p95?: number | null, sampleCount?: number, p50Insufficient?: boolean, p95Insufficient?: boolean };

// Guarantee one TTFT result container per public model, even when the D1
// window has no rows for it: missing keys become { p50Insufficient, p95Insufficient }
// so the dashboard renders '-- / -- samples' instead of dropping the model.
// Lookup key is the canonical statistical model key (trim + lowercase),
// matching how the observability store aggregates model rows.
export function ensureModelTtftContainers(ttft: Map<string, TtftEntry> | null | undefined, models: PublicModelStatusEntry[] | { models?: PublicModelStatusEntry[] } | null | undefined): Map<string, TtftEntry> {
  const map = ttft instanceof Map ? ttft : new Map<string, TtftEntry>();
  const rows: PublicModelStatusEntry[] = Array.isArray(models) ? models : (Array.isArray((models as { models?: PublicModelStatusEntry[] })?.models) ? (models as { models: PublicModelStatusEntry[] }).models : []);
  for (const m of rows) {
    const key = normalizeModelKey(m?.id);
    if (!key || map.has(key)) continue;
    map.set(key, { available: true, p50: null, p95: null, sampleCount: 0, p50Insufficient: true, p95Insufficient: true });
  }
  return map;
}

// Format a bucket upper-bound (ms) as an interval string. Finite values use
// ≤ (upper-bound precision — the real value is at most this); the open-ended
// last bucket (>=10s) uses ≥. Never fabricate a precise sub-bucket value.
function fmtTtftInterval(bucketUpperBoundMs: number): string {
  if (!Number.isFinite(bucketUpperBoundMs)) return '≥10s';
  if (bucketUpperBoundMs < 1000) return `≤${bucketUpperBoundMs}ms`;
  const sec = bucketUpperBoundMs / 1000;
  return `≤${Number.isInteger(sec) ? sec : sec.toFixed(1)}s`;
}

export function fmtModelTtft(modelTtft: TtftEntry | null | undefined): { p50: string, p95: string, samples: number, noSamples: boolean, p50Insufficient: boolean, p95Insufficient: boolean } {
  if (!modelTtft || modelTtft.available === false) {
    return { p50: '--', p95: '--', samples: 0, noSamples: true, p50Insufficient: true, p95Insufficient: true };
  }
  const samples = modelTtft.sampleCount ?? 0;
  const p50Insuff = modelTtft.p50Insufficient === true;
  const p95Insuff = modelTtft.p95Insufficient === true;
  const p50 = (p50Insuff || modelTtft.p50 == null) ? '--' : fmtTtftInterval(modelTtft.p50);
  const p95 = (p95Insuff || modelTtft.p95 == null) ? '--' : fmtTtftInterval(modelTtft.p95);
  return { p50, p95, samples, noSamples: samples === 0, p50Insufficient: p50Insuff, p95Insufficient: p95Insuff };
}

function renderModelRow(m: PublicModelStatusEntry, ttft: Map<string, TtftEntry> | null | undefined): string {
  const state = STATE_LABEL[m.status] || '暂无记录';
  const stateTooltip = STATE_TOOLTIP[m.status] || STATE_TOOLTIP.no_record;
  const style = STATE_STYLE[m.status] ?? ' down';
  const t = fmtModelTtft(ttft?.get?.(normalizeModelKey(m.id)));
  const samplesText = t.noSamples ? '-- samples' : `${t.samples} samples`;
  const p50Title = t.p50Insufficient ? 'P50 样本不足（需 ≥5）' : `P50：近 24 小时成功请求 TTFT 第 50 百分位`;
  const p95Title = t.p95Insufficient ? 'P95 样本不足（需 ≥20）' : `P95：近 24 小时成功请求 TTFT 第 95 百分位`;
  const sampleTitle = t.noSamples ? '暂无 TTFT 样本' : `近 24 小时成功请求的 TTFT 样本`;
  return `<div class="model-row">
    <div class="mr-name" title="${stateTooltip}">${escapeHtml(m.id)}</div>
    <div class="mr-p50-label">P50</div>
    <div class="mr-p50-val" title="${escapeHtml(p50Title)}">${t.p50}</div>
    <div class="mr-p95-label">P95</div>
    <div class="mr-p95-val" title="${escapeHtml(p95Title)}">${t.p95}</div>
    <div class="mr-samples" title="${escapeHtml(sampleTitle)}">${samplesText}</div>
    <div class="mr-dot${style}" title="${escapeHtml(stateTooltip)}" aria-label="${escapeHtml(state)}"></div>
    <div class="mr-status">${state}</div>
  </div>`;
}

function renderModelBlock(models: PublicModelStatusEntry[], ttft: Map<string, TtftEntry> | null | undefined): string {
  if (!models.length) return '';
  const rows = models.map((m) => renderModelRow(m, ttft)).join('');
  return `<div class="status-block">
    <div class="status-grid-inner">${rows}</div>
  </div>`;
}

export function renderModels(status: { models?: PublicModelStatusEntry[] } | null | undefined, ttft: Map<string, TtftEntry> | null | undefined): { html: string } {
  const allModels = modelStatusRows(status);
  const mid = Math.ceil(allModels.length / 2);
  const left = allModels.slice(0, mid);
  const right = allModels.slice(mid);
  const leftHtml = renderModelBlock(left, ttft);
  const rightHtml = renderModelBlock(right, ttft);
  const html = `<div class="status-grid-split">${leftHtml}${rightHtml}</div>`;
  return { html };
}