#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Dashboard model visibility contract for the DASHBOARD_MODELS Worker text
// variable. This is presentation-only: it filters the public status rows and
// must not become a model-registry, routing, fallback or observability input.

import assert from 'node:assert/strict';
import {
  filterDashboardModelStatus,
  publicModelStatus,
} from '../src/dashboard/model-status-view.ts';
import { collectVarsFromEnv } from '../scripts/github-deployment-config.mjs';

const entry = (id, status = 'available') => ({
  id,
  status,
  display_order: 100,
  group: id.startsWith('Code-') ? 'code' : 'general',
});

const envelope = {
  observed_at: '2026-09-12T00:00:00.000Z',
  models: [entry('Air'), entry('Max'), entry('Code-Pro'), entry('Code-Ultra')],
};

{
  const out = filterDashboardModelStatus(envelope, undefined);
  assert.deepEqual(out.models.map((m) => m.id), ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
    'unset variable keeps the full public catalog');
}

{
  const out = filterDashboardModelStatus(envelope, '  code-pro, MAX,missing,code-pro, Code-Ultra  ');
  assert.deepEqual(out.models.map((m) => m.id), ['Code-Pro', 'Max', 'Code-Ultra'],
    'matching is case-insensitive, unknown names are ignored, duplicates are removed and configured order wins');
  assert.equal(out.observed_at, envelope.observed_at, 'status observation timestamp is preserved');
}

{
  const out = filterDashboardModelStatus(envelope, 'missing-one,missing-two');
  assert.deepEqual(out.models, [], 'a non-empty allowlist never fabricates unknown model rows');
}

{
  const out = filterDashboardModelStatus(envelope, ' , , ');
  assert.deepEqual(out.models.map((m) => m.id), ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
    'whitespace/empty CSV is treated as unset');
}

{
  const nodes = [{
    id: 'status-filter-node',
    provider: 'mock',
    tier: 'tier-1',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    base_url: 'https://status-filter.example.com/v1',
    credential: 'unused-in-status-test',
    priority: 10,
    models: {
      'Code-Ultra': 'up-ultra',
      'Code-Max': 'up-max',
      'Code-Pro': 'up-pro',
    },
    limits: { concurrency: 1 },
  }];
  const out = publicModelStatus(nodes, { DASHBOARD_MODELS: 'code-pro,Code-Ultra' }, new Set(), 1_700_000_000_000);
  assert.deepEqual(out.models.map((m) => m.id), ['Code-Pro', 'Code-Ultra'],
    'dashboard wrapper applies the text variable after public status is computed');
}

{
  const vars = collectVarsFromEnv({ DASHBOARD_MODELS: 'Code-Ultra,Code-Max,Code-Pro' });
  assert.equal(vars.vars.DASHBOARD_MODELS, 'Code-Ultra,Code-Max,Code-Pro',
    'GitHub deployment bridge admits DASHBOARD_MODELS as a plain Worker text variable');
}

console.log('dashboard model filter tests passed.');
