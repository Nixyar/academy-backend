import crypto from 'crypto';

const sha256Hex = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const asciiKeySort = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

const toTokenStringValue = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));

/**
 * Token generation for TBank (Tinkoff Acquiring) requests.
 *
 * Different docs/SDKs use slightly different canonicalization rules.
 * We support multiple modes and can fallback when the provider responds with ErrorCode=204 (invalid token).
 */
export const createTbankToken = (payload, password, mode = 'password_key') => {
  const clean = Object.fromEntries(
    Object.entries(payload || {}).filter(([key, value]) => key !== 'Token' && value !== undefined && value !== null),
  );

  const secret = String(password || '');

  if (mode === 'append_password') {
    const entries = Object.entries(clean).map(([key, value]) => [String(key), toTokenStringValue(value)]);
    entries.sort(([a], [b]) => asciiKeySort(a, b));
    return sha256Hex(entries.map(([, v]) => v).join('') + secret);
  }

  if (mode === 'key_value') {
    const withPassword = { ...clean, Password: secret };
    const keys = Object.keys(withPassword).sort(asciiKeySort);
    const concatenated = keys.map((key) => `${key}${toTokenStringValue(withPassword[key])}`).join('');
    return sha256Hex(concatenated);
  }

  // mode === 'password_key' (default): add Password as a field and concat values sorted by key.
  const withPassword = { ...clean, Password: secret };
  const keys = Object.keys(withPassword).sort(asciiKeySort);
  const concatenated = keys.map((key) => toTokenStringValue(withPassword[key])).join('');
  return sha256Hex(concatenated);
};

export const createTbankTokenExcluding = (payload, password, { excludeKeys = [], mode = 'password_key' } = {}) => {
  const excluded = new Set(excludeKeys.map((key) => String(key)));
  const filtered = Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !excluded.has(String(key))),
  );
  return createTbankToken(filtered, password, mode);
};
