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

function fmtTtftSeconds(s) {
  if (s === '--' || s == null) return '--s';
  if (typeof s !== 'string') return '--s';
  if (s.endsWith('ms')) {
    const n = Number(s.slice(0, -2));
    if (!Number.isFinite(n)) return '--s';
    return `${(n / 1000).toFixed(2)}s`;
  }
  if (s.endsWith('s')) return s;
  return `${s}s`;
}

export function fmtModelTtft(modelTtft) {
  if (!modelTtft || modelTtft.available === false) return { p50: '--s', p95: '--s', samples: 0, insufficient: true, noSamples: true };
  if (modelTtft.insufficient) return { p50: '--s', p95: '--s', samples: modelTtft.sampleCount || 0, insufficient: true, noSamples: true };
  return {
    p50: fmtTtftSeconds(modelTtft.p50 != null ? fmtTtft(modelTtft.p50) : '--'),
    p95: fmtTtftSeconds(modelTtft.p95 != null ? fmtTtft(modelTtft.p95) : '--'),
    samples: modelTtft.sampleCount || 0,
    insufficient: false,
    noSamples: (modelTtft.sampleCount || 0) === 0,
  };
}

function renderModelRow(m, ttft) {
  const label = STATE_LABEL[m.status] || '不可用';
  const style = STATE_STYLE[m.status] ?? ' down';
  const t = fmtModelTtft(ttft?.get?.(m.id));
  const samplesText = t.noSamples ? '-- samples' : `${t.samples} samples`;
  const sampleTitle = t.insufficient ? 'TTFT 样本不足' : `${t.samples} 个 TTFT 样本`;
  return `<div class="model-row">
    <div class="mr-name">${escapeHtml(m.id)}</div>
    <div class="mr-p50-label">P50</div>
    <div class="mr-p50-val">${t.p50}</div>
    <div class="mr-p95-label">P95</div>
    <div class="mr-p95-val">${t.p95}</div>
    <div class="mr-samples" title="${escapeHtml(sampleTitle)}">${samplesText}</div>
    <div class="mr-dot${style}"></div>
    <div class="mr-status">${label}</div>
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