import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const passthrough = process.argv.slice(2);
const args = ['--yes', 'wrangler@4.114.0', ...passthrough];
// Operator config (real D1 id, bindings) is gitignored and lives next to the
// public wrangler.jsonc. When it exists and the caller did not pick a config
// explicitly, always deploy/execute against it — a plain-config deploy would
// silently drop the TOKEN_STATS_DB binding the moment someone runs
// `npm run deploy` from a configured checkout (that exact accident took the
// binding down once). Secrets and vars survive via keep-vars; bindings do
// not, so the config must be the operator one.
const operatorConfig = path.join(root, 'wrangler.user.jsonc');
if (fs.existsSync(operatorConfig) && !passthrough.some((a) => a === '-c' || a === '--config')) {
  args.push('-c', 'wrangler.user.jsonc');
}
// Windows + Node >=24 需要 shell 来解析 .cmd；Linux/CI 保持 no-shell。
const result = spawnSync(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
