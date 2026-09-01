// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Report writers for Provider Discovery Catalog diffs + runtime checks.
//
// Output surfaces:
//   - formatChangesMarkdown()    -> human-readable changes.md body
//   - formatActionSummary()      -> short GitHub Action Summary text
//   - formatJsonReport()         -> machine-readable artifact
//
// None of these writers persist secrets; they read only from
// already-normalized input and emit plain strings.

import {
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
} from './catalog-schema.js';

function supportWord(v) {
  if (v === SUPPORT_TRUE) return 'supported';
  if (v === SUPPORT_FALSE) return 'unsupported';
  return 'unknown';
}

function renderSupport(v) {
  return supportWord(v);
}

function renderBaseUrl(v) {
  return v ? v : '(none)';
}

// One-bullet rendering per `changed` item. Stable, deterministic.
function renderChangeBullet(c) {
  const prov = c.provider;
  const proto = c.protocol && c.protocol !== '*' ? ` ${c.protocol}` : '';
  if (c.kind === 'protocol_support_changed') {
    return `- **${prov}**${proto ? ` (${c.protocol})` : ''}: protocol support ${renderSupport(c.before)} → ${renderSupport(c.after)} [${c.severity}]`;
  }
  if (c.kind === 'surface_support_changed') {
    return `- **${prov}** (${c.protocol}, ${c.surface}): surface ${c.before} → ${c.after} [${c.severity}]`;
  }
  if (c.kind === 'base_url_changed') {
    return `- **${prov}** (${c.protocol}): base URL\n    - old: ${renderBaseUrl(c.before)}\n    - new: ${renderBaseUrl(c.after)} [${c.severity}]`;
  }
  return `- **${prov}** ${c.kind} ${JSON.stringify(c)} [${c.severity}]`;
}

export function formatChangesMarkdown({ diff, catalog, warnings, generatedAt }) {
  const lines = [];
  lines.push('# Provider Discovery — Changes');
  lines.push('');
  if (generatedAt) lines.push(`Generated: ${generatedAt}`);
  lines.push('');

  if (!diff || (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0)) {
    lines.push('No catalog changes detected.');
    lines.push('');
  } else {
    if (diff.changed.length > 0) {
      lines.push('## Changed');
      lines.push('');
      // Group bullets by provider for readability, preserving the catalog
      // sort order we already produced upstream.
      let lastProvider = null;
      for (const c of diff.changed) {
        if (c.provider !== lastProvider) {
          if (lastProvider !== null) lines.push('');
          lines.push(`### ${c.provider}`);
          lines.push('');
          lastProvider = c.provider;
        }
        lines.push(renderChangeBullet(c));
      }
      lines.push('');
    }
    if (diff.added.length > 0) {
      lines.push('## Added');
      lines.push('');
      for (const a of diff.added) {
        lines.push(`- **${a.provider}**: provider newly present in the Catalog`);
      }
      lines.push('');
    }
    if (diff.removed.length > 0) {
      lines.push('## Removed');
      lines.push('');
      for (const r of diff.removed) {
        lines.push(`- **${r.provider}**: provider no longer present in the Catalog`);
      }
      lines.push('');
    }
  }

  // Runtime warnings section. Always present so reviewers see either
  // "no warnings" or the warnings list. We do NOT escalate these to
  // "remove this node" or "this node is broken" — the catalog is
  // auxiliary and warnings require human review.
  lines.push('## Runtime consistency');
  lines.push('');
  if (!warnings || warnings.length === 0) {
    lines.push('No runtime consistency warnings.');
    lines.push('');
  } else {
    for (const w of warnings) {
      lines.push(`- **${w.severity}** ${w.kind}: ${w.detail}`);
    }
    lines.push('');
  }

  // Catalog capability snapshot — small, deterministic, sorted.
  lines.push('## Catalog snapshot');
  lines.push('');
  lines.push('| Provider | Protocol | Supported | Surfaces | Evidence | Base URL |');
  lines.push('|---|---|---|---|---|---|');
  const providerNames = Object.keys(catalog?.providers || {}).sort();
  for (const name of providerNames) {
    const p = catalog.providers[name];
    for (const protocol of ['openai', 'anthropic']) {
      const e = p?.[protocol];
      if (!e) continue;
      const supported = renderSupport(e.supported);
      const surfaces = (e.surfaces || []).join(', ') || '—';
      const baseUrl = e.base_url || '—';
      lines.push(`| ${name} | ${protocol} | ${supported} | ${surfaces} | ${e.evidence} | ${baseUrl} |`);
    }
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push('- Surface absence is `unknown`, not `unsupported` (v1.1 §四).');
  lines.push('- Base URL changes are not auto-treated as "old endpoint invalid".');
  lines.push('- Runtime warnings do not modify Runtime Node configuration.');
  lines.push('');
  return lines.join('\n');
}

// Short summary suitable for $GITHUB_STEP_SUMMARY. Numbers only; no
// detail. Detailed differences are in changes.md / artifact JSON.
export function formatActionSummary({ diff, warnings, capability: capabilityAgg, generatedAt }) {
  const lines = [];
  lines.push('# Provider Discovery');
  lines.push('');
  if (generatedAt) lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push(`Providers checked: ${capabilityAgg?.providers_total ?? 0}`);
  lines.push('');
  lines.push('## Protocol support (supported only)');
  lines.push('');
  lines.push(`- OpenAI Chat: ${capabilityAgg?.openai_chat_supported ?? 0}`);
  lines.push(`- OpenAI Responses: ${capabilityAgg?.openai_responses_supported ?? 0}`);
  lines.push(`- Anthropic Messages: ${capabilityAgg?.anthropic_messages_supported ?? 0}`);
  lines.push(`- Anthropic count_tokens: ${capabilityAgg?.anthropic_count_tokens_supported ?? 0}`);
  lines.push('');
  lines.push('## Catalog changes');
  lines.push('');
  lines.push(`- Added providers: ${diff?.added?.length ?? 0}`);
  lines.push(`- Removed providers: ${diff?.removed?.length ?? 0}`);
  let pChanges = 0;
  let sChanges = 0;
  let bChanges = 0;
  for (const c of diff?.changed || []) {
    if (c.kind === 'protocol_support_changed') pChanges += 1;
    else if (c.kind === 'surface_support_changed') sChanges += 1;
    else if (c.kind === 'base_url_changed') bChanges += 1;
  }
  lines.push(`- Protocol changes: ${pChanges}`);
  lines.push(`- Surface changes: ${sChanges}`);
  lines.push(`- Base URL changes: ${bChanges}`);
  lines.push('');
  lines.push('## Runtime consistency');
  lines.push('');
  const sev = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const w of warnings || []) sev[w.severity] = (sev[w.severity] ?? 0) + 1;
  lines.push(`- Runtime configuration warnings: P0=${sev.P0}, P1=${sev.P1}, P2=${sev.P2}, P3=${sev.P3}`);
  if ((sev.P0 || 0) > 0) {
    lines.push('');
    lines.push('> **P0 warnings present** — runtime is using a protocol that the Catalog marks as unsupported. Review changes.md.');
  }
  lines.push('');
  return lines.join('\n');
}

// Machine-readable artifact. Stable key order; safe for diffing across
// runs of the workflow.
export function formatJsonReport({ diff, warnings, catalog, generatedAt }) {
  return JSON.stringify({
    generated_at: generatedAt || null,
    diff,
    warnings,
    catalog,
  }, null, 2);
}