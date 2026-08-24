#!/usr/bin/env node
// Node configuration planner CLI shared by install / reconfigure.
//
//   validate --tier1 FILE [--tier2 FILE] [--tier3 FILE] [--secrets FILE]
//       Validate node config files and (optionally) cross-check credentials.
//   plan --tier1 FILE [--tier2 FILE] [--tier3 FILE] --secrets FILE --out PLAN
//        [--existing-vars FILE|-] [--existing-secrets FILE|-]
//       Generate the deployment plan:
//         { vars, secrets, deleteVars, deleteSecrets, tierSummary }
//       Full values are written to --out only; stdout prints a safe summary.
import fs from 'node:fs';
import {
  parseJsonFile, buildPlan,
  MANAGED_VAR_PATTERN, MANAGED_SECRET_PATTERN,
} from './nodes-shard.mjs';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`unknown argument: ${token}`);
    const key = token.slice(2);
    if (['existing-vars', 'existing-secrets'].includes(key) && argv[i + 1] === '-') {
      args[key] = '-';
      i++;
      continue;
    }
    args[key] = argv[i + 1];
    i++;
  }
  return args;
}

function readNameList(source, pattern, label) {
  let names;
  if (source === '-') {
    names = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  } else {
    const raw = fs.readFileSync(source, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not a JSON array');
      names = parsed.map((item) => (typeof item === 'string' ? item : item?.name));
    } catch {
      names = raw.split(/\r?\n/);
    }
  }
  return names.map((n) => String(n || '').trim()).filter(Boolean);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'validate') {
  const args = parseArgs(rest);
  const tiers = {};
  for (const n of [1, 2, 3]) {
    if (!args[`tier${n}`]) continue;
    tiers[n] = parseJsonFile(args[`tier${n}`]);
  }
  const secretsMap = args.secrets ? parseJsonFile(args.secrets) : null;
  try {
    const plan = buildPlan({ tiers, secretsMap });
    const totalNodes = Object.values(plan.tierSummary).reduce((s, t) => s + t.nodes, 0);
    console.log(`OK: ${totalNodes} node(s), all credentials matched.`);
  } catch (e) {
    fail(e.message);
  }
} else if (command === 'plan') {
  const args = parseArgs(rest);
  if (!args.tier1) fail('plan requires --tier1');
  if (!args.secrets) fail('plan requires --secrets');
  if (!args.out) fail('plan requires --out');
  const tiers = {};
  for (const n of [1, 2, 3]) {
    if (!args[`tier${n}`]) continue;
    tiers[n] = parseJsonFile(args[`tier${n}`]);
  }
  const secretsMap = parseJsonFile(args.secrets);
  const existingVarNames = args['existing-vars'] ? readNameList(args['existing-vars'], MANAGED_VAR_PATTERN, 'vars') : [];
  const existingSecretNames = args['existing-secrets'] ? readNameList(args['existing-secrets'], MANAGED_SECRET_PATTERN, 'secrets') : [];
  let plan;
  try {
    plan = buildPlan({ tiers, secretsMap, existingVarNames, existingSecretNames });
  } catch (e) {
    fail(e.message);
  }
  fs.writeFileSync(args.out, JSON.stringify(plan, null, 2));
  for (const [tierNumber, summary] of Object.entries(plan.tierSummary)) {
    console.log(`tier-${tierNumber}: ${summary.nodes} node(s) -> ${summary.shards} shard(s)`);
  }
  const secretCount = Object.keys(secretsMap).length;
  console.log(`secrets: ${secretCount} credential(s) -> ${Object.keys(plan.secrets).length} shard(s)`);
  for (const key of plan.plannedVars) console.log(`var     ${key} (${Buffer.byteLength(plan.vars[key], 'utf8')} bytes)`);
  for (const key of plan.plannedSecrets) console.log(`secret  ${key}`);
  for (const key of plan.deleteVars) console.log(`delete var ${key}`);
  for (const key of plan.deleteSecrets) console.log(`delete secret ${key}`);
} else {
  fail('usage: manage-nodes-config.mjs <validate|plan> [options]');
}
