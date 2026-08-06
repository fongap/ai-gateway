const tokensRaw = String(process.env.PRIMARY_API_TOKENS || '').trim();
const defaultBaseRaw = String(process.env.PRIMARY_BASE_URL || '').trim();

function fail(message) {
  console.error(`Primary 配置无效：${message}`);
  process.exit(1);
}

function normalizeHttps(raw, label) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error();
    if (url.username || url.password) fail(`${label} 不得包含用户名或密码。`);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    fail(`${label} 必须是完整 HTTPS URL。`);
  }
}

if (!tokensRaw) fail('PRIMARY_API_TOKENS 不能为空。');
if (tokensRaw.includes(';')) fail('不支持分号分隔，请使用逗号或换行。');
const defaultBaseUrl = defaultBaseRaw ? normalizeHttps(defaultBaseRaw, 'PRIMARY_BASE_URL') : '';
const entries = tokensRaw.split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean);
if (entries.length === 0) fail('未找到有效 Token。');

const seen = new Set();
for (let index = 0; index < entries.length; index += 1) {
  const item = entries[index];
  const match = item.match(/^(.*)@(https?:\/\/.+)$/i);
  const token = match ? match[1].trim() : item;
  const rawBaseUrl = match ? match[2] : defaultBaseRaw;
  if (!token) fail(`第 ${index + 1} 个 Token 为空。`);
  if (!rawBaseUrl) fail(`第 ${index + 1} 个 Token 未绑定 HTTPS URL，且 PRIMARY_BASE_URL 为空。`);
  const baseUrl = normalizeHttps(rawBaseUrl, `第 ${index + 1} 个 Token 绑定地址`);
  seen.add(`${token}|${baseUrl}`);
}

console.log(`Primary 配置检查通过：${seen.size} 个去重端点。`);
