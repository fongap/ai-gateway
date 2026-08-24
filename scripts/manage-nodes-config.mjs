#!/usr/bin/env node
// 节点配置 Secret 管理工具（install / reconfigure 共用）。
//
// 子命令：
//   validate --file F
//       校验 JSON 数组节点配置文件。
//   plan (--tier1 F [--tier2 F] [--tier3 F]) [--existing FILE|-] --out OUT
//       生成部署计划：secrets（TIERx_NODES_CONFIG_01.. 分片）与 delete（多余旧分片/旧单变量）。
//       existing 为当前 Worker 的 Secret 名列表（wrangler secret list 输出的 JSON 数组或纯文本每行一个）。
//       计划中的完整 Secret 值只写入 --out 文件，stdout 只输出安全摘要。

import fs from 'node:fs';
import {
  buildShardPlan,
  parseNodesFile,
  MANAGED_SECRET_PATTERN,
} from './nodes-shard.mjs';

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`未知参数：${token}`);
    const key = token.slice(2);
    if (key === 'existing' && argv[i + 1] === '-') {
      args[key] = '-';
      i++;
      continue;
    }
    args[key] = argv[i + 1];
    i++;
  }
  return args;
}

function readExistingNames(source) {
  const raw = source === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(source, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean);
  }
  fail('existing secret list must be a JSON array or one name per line');
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'validate') {
  const args = parseArgs(rest);
  if (!args.file) fail('validate 需要 --file 参数。');
  try {
    const nodes = parseNodesFile(args.file);
    console.log(`${args.file}: OK, ${nodes.length} node(s).`);
  } catch (e) {
    fail(e.message);
  }
} else if (command === 'plan') {
  const args = parseArgs(rest);
  if (!args.out) fail('plan 需要 --out 参数。');
  if (!args.tier1 && !args.tier2 && !args.tier3) fail('plan 至少需要一个 --tierN 文件参数。');
  const tiers = {};
  for (const tierNumber of [1, 2, 3]) {
    const file = args[`tier${tierNumber}`];
    if (!file) continue;
    try {
      tiers[tierNumber] = parseNodesFile(file);
    } catch (e) {
      fail(e.message);
    }
  }
  const existingNames = args.existing ? readExistingNames(args.existing) : null;
  for (const name of existingNames ?? []) {
    if (!MANAGED_SECRET_PATTERN.test(name)) {
      fail(`existing 列表包含非本项目管理的 Secret：${name}`);
    }
  }
  let plan;
  try {
    plan = buildShardPlan(tiers, existingNames);
  } catch (e) {
    fail(e.message);
  }
  if ((tiers[1]?.length ?? 0) === 0) {
    fail('tier-1 节点配置为空：网关至少需要一个 tier-1 节点。');
  }
  fs.writeFileSync(args.out, JSON.stringify(plan, null, 2));
  for (const [tierNumber, summary] of Object.entries(plan.tierSummary)) {
    console.log(`tier-${tierNumber}: ${summary.nodes} node(s) → ${summary.shards} shard(s)`);
  }
  for (const key of plan.plannedKeys) {
    const bytes = Buffer.byteLength(plan.secrets[key], 'utf8');
    console.log(`write ${key} (${bytes} bytes)`);
  }
  for (const key of plan.delete) {
    console.log(`delete ${key}`);
  }
} else {
  fail('用法：manage-nodes-config.mjs <validate|plan> [options]');
}
