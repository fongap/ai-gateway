// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public-safe model status rendering.  The model status section on the public
// dashboard shows a fixed set of 8 logical models in a stable order.  General-
// prefix models display without the prefix (general-air → air).  No node ids,
// providers, tiers, counts or durations ever leave this module.

import { getPublicModelStatus } from '../runtime/model-status.js';
import { escapeHtml, fmtTtft } from './format.js';

const STATE_LABEL = { available: '可用', unobserved: '未观测', degraded: '波动', unavailable: '不可用' };
const STATE_STYLE = { available: '', unobserved: ' warn', degraded: ' warn', unavailable: ' down' };
const GENERAL_PREFIX = 'general-';
const CODE_PREFIX = 'code-';

// Fixed 8-model order — these positions are stable UI, never sorted dynamically.
const GENERAL_MODEL_ORDER = ['general-air', 'general-pro', 'general-max', 'general-ultra'];
const CODE_MODEL_ORDER = ['code-air', 'code-pro', 'code-max', 'code-ultra'];

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

// Strip the general- prefix for display: general-air → air
function displayName(id) {
  if (id.toLowerCase().startsWith(GENERAL_PREFIX)) return id.slice(GENERAL_PREFIX.length);
  return id;
}

function renderModelRow(m, ttft) {
  const label = STATE_LABEL[m.status] || '不可用';
  const style = STATE_STYLE[m.status] || ' down';
  const t = fmtModelTtft(ttft?.get?.(m.id));
  const sampleTitle = t.insufficient ? 'TTFT 样本不足' : `${t.samples} 个 TTFT 样本`;
  return `<div class="model-row">
    <div>
      <div class="model-name">${escapeHtml(displayName(m.id))}</div>
      <div class="model-meta">
        <span>P50 <b>${t.p50}</b></span>
        <span>P95 <b>${t.p95}</b></span>
        <span title="${escapeHtml(sampleTitle)}">${t.samples} samples</span>
      </div>
    </div>
    <div class="model-status${style}">${label}</div>
  </div>`;
}

function renderFixedGroup(order, statusMap, ttft, title) {
  const rows = order.map((id) => {
    const m = statusMap.get(id) || { id, status: 'unavailable' };
    return renderModelRow(m, ttft);
  }).join('');
  return `<div class="status-block">
    <div class="status-group-title">${escapeHtml(title)}</div>
    ${rows}
  </div>`;
}

export function renderModels(models, ttft) {
  // Build a lookup map from the live status data.
  // Register both raw id and general-prefixed form so the fixed display grid
  // (which uses general-air etc.) can find status for bare registry ids like 'air'.
  const statusMap = new Map();
  for (const m of models) {
    statusMap.set(m.id, m);
    if (!m.id.startsWith('general-') && !m.id.startsWith('code-')) {
      statusMap.set(GENERAL_PREFIX + m.id, m);
    }
  }

  const generalHtml = renderFixedGroup(GENERAL_MODEL_ORDER, statusMap, ttft, '通用模型');
  const codeHtml = renderFixedGroup(CODE_MODEL_ORDER, statusMap, ttft, '编程模型');

  const html = `<div class="status-grid">${generalHtml}${codeHtml}</div>`;
  return { html };
}
