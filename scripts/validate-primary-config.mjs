const tokensRaw = String(process.env.PRIMARY_API_TOKENS || '').trim();
const defaultBaseRaw = String(process.env.PRIMARY_BASE_URL || '').trim();

function fail(message) {
  console.error(`Primary 配置无效：${message}`);
  process.exit(1);
}

function requireHttps(raw, label) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error();
  } catch {
    fail(`${label} 必须是完整 HTTPS URL。`);
  }
}

if (!tokensRaw) fail('PRIMARY_API_TOKENS 不能为空。');
if (defaultBaseRaw) requireHttps(defaultBaseRaw, 'PRIMARY_BASE_URL');

const entries = tokensRaw.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
if (entries.length === 0) fail('未找到有效 Token。');

for (let index = 0; index < entries.length; index += 1) {
  const item = entries[index];
  const atIndex = item.indexOf('@');
  const suffix = atIndex >= 0 ? item.slice(atIndex + 1) : '';
  const hasBoundUrl = /^https?:\/\//i.test(suffix);
  const token = hasBoundUrl ? item.slice(0, atIndex).trim() : item;
  if (!token) fail(`第 ${index + 1} 个 Token 为空。`);
  if (hasBoundUrl) requireHttps(suffix, `第 ${index + 1} 个 Token 绑定地址`);
  else if (!defaultBaseRaw) fail(`第 ${index + 1} 个 Token 未绑定 HTTPS URL，且 PRIMARY_BASE_URL 为空。`);
}

console.log(`Primary 配置检查通过：${entries.length} 个端点。`);
