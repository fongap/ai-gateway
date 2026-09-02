// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public-safe model status rendering. The model status card on the public
// dashboard collapses runtime availability + cross-isolate D1 evidence into
// a single per-model row with a colored dot. No node ids, providers, tiers,
// counts or durations ever leave this module.

import { getPublicModelStatus } from '../runtime/model-status.js';
import { escapeHtml, fmtTtft } from './format.js';

const STATE_LABEL = { available: '可用', unobserved: '未观测', degraded: '波动', unavailable: '不可用' };
const GENERAL_PREFIX = 'general-';
const CODE_PREFIX = 'code-';

export function publicModelStatus(nodes, env, evidence = new Set(), now = Date.now()) {
  return getPublicModelStatus(nodes, env, evidence, now);
}

export function fmtModelTtft(modelTtft) {
  if (!modelTtft || modelTtft.available === false) return { p50: '--', p95: '--', samples: 0, insufficient: true };
  if (modelTtft.insufficient) return { p50: '--', p95: '--', samples: modelTtft.sampleCount || 0, insufficient: true };
  return {
    p50: modelTtft.p50 != null ? fmtTtft(modelTtft.p50) : '--',
    p95: modelTtft.p95 != null ? fmtTtft(modelTtft.p95) : '--',
    samples: modelTtft.sampleCount || 0,
    insufficient: false,
  };
}

export function renderModelGroup(models, ttft, title) {
  if (!models.length) return '';
  const items = models.map((m) => {
    const label = STATE_LABEL[m.status] || '不可用';
    const t = fmtModelTtft(ttft?.get?.(m.id));
    const sampleTitle = t.insufficient ? 'TTFT 样本不足' : `${t.samples} 个 TTFT 样本`;
    return `<div class="model-item">` +
      `<span class="model-name">${escapeHtml(m.id)}</span>` +
      `<span class="model-status ${m.status}"><i class="dot ${m.status}" aria-hidden="true"></i>${label}</span>` +
      `<span class="model-perf">${t.p50}</span>` +
      `<span class="model-perf">${t.p95}</span>` +
      `<span class="model-samples" title="${escapeHtml(sampleTitle)}">${t.samples}</span>` +
      `<span class="sr-only">状态：${label}，TTFT P50 ${t.p50}，P95 ${t.p95}</span></div>`;
  }).join('');
  return `<div class="models-group">` +
    `<div class="models-group-title">${escapeHtml(title)}</div>` +
    `<div class="models-head"><b>模型</b><span>状态</span><span>P50</span><span>P95</span><span>样本</span></div>` +
    `<div class="models-body">${items}</div></div>`;
}

// Split models into 通用模型 (non-code, non-general-prefix) and 编程模型
// (code- prefix). general-* models are filtered out entirely; the dashboard
// does not show them because they are administrative aliases.
export function renderModels(models, ttft) {
  const general = [];
  const code = [];
  for (const m of models) {
    if (m.id.toLowerCase().startsWith(GENERAL_PREFIX)) continue;
    if (m.id.toLowerCase().startsWith(CODE_PREFIX)) {
      code.push(m);
    } else {
      general.push(m);
    }
  }
  if (!general.length && !code.length) {
    return { html: `<div class="card models-card"><div class="empty">模型映射配置后在此显示。</div></div>` };
  }
  const html = `<div class="card models-card">` +
    renderModelGroup(general, ttft, '通用模型') +
    renderModelGroup(code, ttft, '编程模型') +
    `</div>`;
  return { html };
}
