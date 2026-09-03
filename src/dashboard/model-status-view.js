// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public-safe model status rendering. The model status section on the public
// dashboard renders the current Public Model Catalog — the logical models that
// exist in the Model Registry and have at least one serving node. Rows are
// shown in deterministic Logical Model ID order (dictionary sort). No node ids,
// providers, tiers, counts or durations ever leave this module, and no model
// name or prefix carries any business meaning.

import { getPublicModelStatus } from '../runtime/model-status.js';
import { escapeHtml, fmtTtft } from './format.js';

const STATE_LABEL = { available: '可用', unobserved: '未观测', degraded: '波动', unavailable: '不可用' };
const STATE_STYLE = { available: '', unobserved: ' warn', degraded: ' warn', unavailable: ' down' };

export function publicModelStatus(nodes, env, evidence = new Set(), now = Date.now()) {
  return getPublicModelStatus(nodes, env, evidence, now);
}

// Flat list of { id, status } rows from the status envelope, sorted by id.
export function modelStatusRows(status) {
  if (!status || !Array.isArray(status.models)) return [];
  return status.models;
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

function renderModelRow(m, ttft) {
  const label = STATE_LABEL[m.status] || '不可用';
  const style = STATE_STYLE[m.status] ?? ' down';
  const t = fmtModelTtft(ttft?.get?.(m.id));
  const sampleTitle = t.insufficient ? 'TTFT 样本不足' : `${t.samples} 个 TTFT 样本`;
  return `<div class="model-row">
    <div>
      <div class="model-name">${escapeHtml(m.id)}</div>
      <div class="model-meta">
        <span>P50 <b>${t.p50}</b></span>
        <span>P95 <b>${t.p95}</b></span>
        <span title="${escapeHtml(sampleTitle)}">${t.samples} samples</span>
      </div>
    </div>
    <div class="model-status${style}">${label}</div>
  </div>`;
}

function splitModelsByGroup() { return {}; }

function renderModelBlock(models, ttft, title) {
  if (!models.length) return '';
  const rows = models.map((m) => renderModelRow(m, ttft)).join('');
  return `<div class="status-block">
    <div class="status-grid-inner">${rows}</div>
  </div>`;
}

export function renderModels(status, ttft) {
  const allModels = modelStatusRows(status);
  const mid = Math.ceil(allModels.length / 2);
  const left = allModels.slice(0, mid);
  const right = allModels.slice(mid);
  const leftHtml = renderModelBlock(left, ttft);
  const rightHtml = renderModelBlock(right, ttft);
  const html = `<div class="status-grid-split">${leftHtml}${rightHtml}</div>`;
  return { html };
}