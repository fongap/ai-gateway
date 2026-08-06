const token = String(process.env.FALLBACK_API_TOKEN || '').trim();
const baseRaw = String(process.env.FALLBACK_BASE_URL || '').trim();
const primaryModel = String(process.env.FALLBACK_PRIMARY_MODEL || '').trim();
const secondaryModel = String(process.env.FALLBACK_SECONDARY_MODEL || 'off').trim();

function fail(message) {
  console.error(`Fallback 配置无效：${message}`);
  process.exit(1);
}

if (!token) fail('FALLBACK_API_TOKEN 不能为空。');
if (!primaryModel) fail('FALLBACK_PRIMARY_MODEL 不能为空。');
if (!baseRaw) fail('FALLBACK_BASE_URL 不能为空。');
try {
  const url = new URL(baseRaw);
  if (url.protocol !== 'https:' || !url.hostname) throw new Error();
  if (url.username || url.password) fail('FALLBACK_BASE_URL 不得包含用户名或密码。');
} catch {
  fail('FALLBACK_BASE_URL 必须是完整 HTTPS URL。');
}
if (secondaryModel.toLowerCase() !== 'off' && !secondaryModel) {
  fail('FALLBACK_SECONDARY_MODEL 必须是模型名或 off。');
}
console.log('Fallback 配置检查通过。');
