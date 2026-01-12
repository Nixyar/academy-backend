import crypto from 'crypto';

const sha256Hex = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const stableStringify = (value) => {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${pairs.join(',')}}`;
  }

  return JSON.stringify(value);
};

export const createTbankToken = (payload, password) => {
  const entries = Object.entries(payload || {})
    .filter(([key, value]) => key !== 'Token' && value !== undefined && value !== null)
    .map(([key, value]) => [String(key), typeof value === 'object' ? stableStringify(value) : String(value)]);

  entries.push(['Password', String(password || '')]);
  entries.sort(([a], [b]) => a.localeCompare(b));

  const concatenated = entries.map(([, value]) => value).join('');
  return sha256Hex(concatenated);
};
