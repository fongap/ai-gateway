import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/validate-model-mapping.mjs <file>');
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MODEL_MAPPING root must be an object.');
const allowHttp = ['true', '1', 'yes', 'on'].includes(String(process.env.ALLOW_INSECURE_HTTP_UPSTREAM || '').trim().toLowerCase());
const normalizedHosts = new Set();
for (const [host, mapping] of Object.entries(parsed)) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  if (!normalizedHost) throw new Error('MODEL_MAPPING contains an empty host.');
  if (normalizedHosts.has(normalizedHost)) throw new Error(`MODEL_MAPPING contains duplicate host after case normalization: ${host}.`);
  normalizedHosts.add(normalizedHost);
  if (!host || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error(`Host mapping ${host} must be an object.`);
  const normalizedAliases = new Set();
  for (const [alias, value] of Object.entries(mapping)) {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) throw new Error(`Host ${host} contains an empty alias.`);
    if (normalizedAliases.has(normalizedAlias)) throw new Error(`Host ${host} contains duplicate alias after trimming: ${alias}.`);
    normalizedAliases.add(normalizedAlias);
    if (typeof value === 'string') {
      if (!value.trim()) throw new Error(`${host}.${alias} must not be empty.`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${host}.${alias} must be a string or object.`);
    if ('model' in value && (typeof value.model !== 'string' || !value.model.trim())) throw new Error(`${host}.${alias}.model must be a non-empty string.`);
    if ('invoke_url' in value) {
      const url = new URL(value.invoke_url);
      if (url.username || url.password) throw new Error(`${host}.${alias}.invoke_url must not contain credentials.`);
      if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error(`${host}.${alias}.invoke_url must use HTTPS.`);
    }
    if ('capabilities' in value && (!value.capabilities || typeof value.capabilities !== 'object' || Array.isArray(value.capabilities))) throw new Error(`${host}.${alias}.capabilities must be an object.`);
    if ('request_overrides' in value && (!value.request_overrides || typeof value.request_overrides !== 'object' || Array.isArray(value.request_overrides))) throw new Error(`${host}.${alias}.request_overrides must be an object.`);
    const protectedFields = new Set(['model', 'messages', 'stream']);
    if (value.request_overrides && Object.keys(value.request_overrides).some(key => protectedFields.has(key))) throw new Error(`${host}.${alias}.request_overrides must not override model, messages, or stream.`);
    if ('drop_params' in value && (!Array.isArray(value.drop_params) || value.drop_params.some(x => typeof x !== 'string'))) throw new Error(`${host}.${alias}.drop_params must be an array of strings.`);
    if (Array.isArray(value.drop_params) && value.drop_params.some(key => protectedFields.has(key))) throw new Error(`${host}.${alias}.drop_params must not remove model, messages, or stream.`);
  }
}
console.log('MODEL_MAPPING validation passed.');

