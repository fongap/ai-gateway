// Stable local wrapper around the pinned Cloudflare Wrangler CLI.
// Single source of truth for: Wrangler version, required KV binding,
// D1 migration-before-deploy, and direct Worker CLI invocation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npxCliCandidates = [
  process.env.npm_execpath
    ? path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js')
    : null,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
].filter(Boolean);
const npxCli = isWindows ? npxCliCandidates.find((candidate) => fs.existsSync(candidate)) : null;
const command = npxCli ? process.execPath : (isWindows ? 'npx.cmd' : 'npx');
const commandPrefix = npxCli ? [npxCli] : [];
const passthrough = process.argv.slice(2);
const wranglerVersion = 'wrangler@4.114.0';
const args = ['--yes', wranglerVersion, ...passthrough];

// Operator config (real D1 id, bindings) is gitignored and lives next to the
// public wrangler.jsonc. When it exists and the caller did not pick a config
// explicitly, always deploy/execute against it — a plain-config deploy would
// silently drop operator bindings. Secrets and vars survive via keep-vars;
// bindings do not, so the config must be the operator one.
const operatorConfig = path.join(root, 'wrangler.user.jsonc');
const explicitConfigIndex = passthrough.findIndex((a) => a === '-c' || a === '--config');
const explicitConfigEquals = passthrough.find((a) => a.startsWith('--config='));
const hasExplicitConfig = explicitConfigIndex >= 0 || Boolean(explicitConfigEquals);
if (fs.existsSync(operatorConfig) && !hasExplicitConfig) {
  args.push('-c', 'wrangler.user.jsonc');
}

function runWrangler(wranglerArgs) {
  // Prefer invoking npx-cli.js through Node on Windows. This avoids shell
  // argument-concatenation ambiguity while retaining a .cmd fallback for
  // unusual Node distributions.
  const result = spawnSync(command, [...commandPrefix, ...wranglerArgs], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows && !npxCli,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function selectedConfigPath() {
  if (explicitConfigIndex >= 0) return passthrough[explicitConfigIndex + 1] || null;
  if (explicitConfigEquals) return explicitConfigEquals.slice('--config='.length) || null;
  if (fs.existsSync(operatorConfig)) return 'wrangler.user.jsonc';
  return 'wrangler.jsonc';
}

// Wrangler D1 migrations use the database name, while `binding` is only the
// Worker runtime binding. Resolve the configured name rather than hardcoding it.
function databaseNameForBinding(configSource, binding) {
  if (!configSource) return null;
  try {
    const config = JSON.parse(configSource);
    const entry = (config?.d1_databases || [])
      .find((d) => d && d.binding === binding && d.database_name);
    return entry?.database_name || null;
  } catch {
    return null;
  }
}

function checkAffinityKvBinding(configSource) {
  if (!configSource) return false;
  try {
    const config = JSON.parse(configSource);
    return config?.kv_namespaces?.some((entry) =>
      entry?.binding === 'TIER1_AFFINITY' && typeof entry.id === 'string' && entry.id.length > 0) || false;
  } catch {
    return false;
  }
}

// `npm run deploy` and installer/reconfigure flows all pass through this
// wrapper. A real local deploy must uphold migration-before-code ordering;
// `deploy --dry-run` remains local and non-mutating.
if (passthrough[0] === 'deploy' && !passthrough.includes('--dry-run')) {
  const configPath = selectedConfigPath();
  const resolvedConfig = configPath && path.resolve(root, configPath);
  const configSource = resolvedConfig && fs.existsSync(resolvedConfig)
    ? fs.readFileSync(resolvedConfig, 'utf8')
    : '';
  if (!checkAffinityKvBinding(configSource)) {
    console.error('Refusing deploy: configure the required TIER1_AFFINITY KV binding in wrangler.user.jsonc.');
    process.exitCode = 1;
    process.exit();
  }
  const dbName = databaseNameForBinding(configSource, 'TOKEN_STATS_DB');
  if (dbName) {
    const migrationArgs = [
      '--yes', wranglerVersion,
      'd1', 'migrations', 'apply', dbName, '--remote',
      '-c', configPath,
    ];
    const migrationStatus = runWrangler(migrationArgs);
    if (migrationStatus !== 0) {
      process.exitCode = migrationStatus;
      process.exit();
    }
  }
}

const resultStatus = runWrangler(args);
process.exitCode = resultStatus;
