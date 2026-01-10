import crypto from 'crypto';

const sha256Hex = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export const createTbankToken = (payload, password) => {
  const entries = Object.entries(payload || {})
    .filter(([key, value]) => key !== 'Token' && value !== undefined && value !== null)
    .map(([key, value]) => [String(key), typeof value === 'object' ? JSON.stringify(value) : String(value)]);

  entries.push(['Password', String(password || '')]);
  entries.sort(([a], [b]) => a.localeCompare(b));

  const concatenated = entries.map(([, value]) => value).join('');
  return sha256Hex(concatenated);
};

