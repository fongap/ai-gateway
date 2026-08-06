import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'wrangler.jsonc');
const config = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
delete config.secrets;
const tempPath = path.join(root, `.wrangler-local-${process.pid}-${Date.now()}.jsonc`);
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'wrangler@4.114.0', ...process.argv.slice(2), '--config', tempPath];
try {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempPath, { force: true });
}
