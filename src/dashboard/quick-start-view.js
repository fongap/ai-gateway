// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// 快速开始 section — tabbed OpenAI / Anthropic code snippets.
// Extracted from pages.js for the v5 Compact Quiet Technical Interface.

import { escapeHtml } from './format.js';

function snippetPane({ id, active, code }) {
  return `<div class="pane${active ? ' active' : ''}" id="pane-${id}" role="tabpanel" ` +
    `aria-labelledby="tab-${id}"${active ? '' : ' hidden'}>
    <div class="code-card">
      <div id="code-${id}">${code.split('\n').map((line) => {
        const eq = line.indexOf('=');
        if (eq < 0) return `<div class="code-line">${escapeHtml(line)}</div>`;
        const key = escapeHtml(line.slice(0, eq));
        const val = escapeHtml(line.slice(eq + 1));
        return `<div class="code-line"><span class="code-key">${key}</span>=<span class="code-value">${val}</span></div>`;
      }).join('')}</div>
      <button class="copy" type="button" data-copy="#code-${id}" aria-label="复制" aria-live="polite">复制</button>
    </div>
  </div>`;
}

export function quickStartSection(apiBase) {
  const origin = new URL(apiBase).origin;
  const openai = `OPENAI_BASE_URL=${apiBase}\nOPENAI_API_KEY=$GATEWAY_ACCESS_KEY`;
  const anthropic = `ANTHROPIC_BASE_URL=${origin}\nANTHROPIC_AUTH_TOKEN=$GATEWAY_ACCESS_KEY`;
  const tabs = [
    { id: 'openai', label: 'OpenAI 协议' },
    { id: 'anthropic', label: 'Anthropic 协议' },
  ].map((t, i) => `<button class="tab${i === 0 ? ' active' : ''}" id="tab-${t.id}" ` +
    `type="button" role="tab" aria-controls="pane-${t.id}" aria-selected="${i === 0}" ` +
    `tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('');
  const panes = [
    snippetPane({ id: 'openai', active: true, code: openai }),
    snippetPane({ id: 'anthropic', active: false, code: anthropic }),
  ].join('\n');
  return `<section id="quickstart">
  <div class="wrap">
    <div class="section-head"><span class="section-title">快速开始</span></div>
    <div class="tabs" role="tablist">${tabs}</div>
    ${panes}
    <noscript><style>.pane{display:block}.code-card{padding:25px 27px}</style></noscript>
  </div>
</section>`;
}
