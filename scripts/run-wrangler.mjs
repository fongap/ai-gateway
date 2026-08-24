import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'wrangler@4.114.0', ...process.argv.slice(2)];
// Windows + Node >=24 需要 shell 来解析 .cmd；Linux/CI 保持 no-shell。
const result = spawnSync(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
