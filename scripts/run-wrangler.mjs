import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'wrangler@4.114.0', ...process.argv.slice(2)];
const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
