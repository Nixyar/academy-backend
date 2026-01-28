import dotenv from 'dotenv';

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  dotenv.config();
}

const requiredKeys = [
  'PORT',
  'WEB_ORIGIN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'COOKIE_SECURE',
  'NODE_ENV',
];

const missing = requiredKeys.filter((key) => process.env[key] === undefined);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const port = Number(process.env.PORT);
if (Number.isNaN(port)) {
  throw new Error('PORT must be a number');
}

const cookieSecure = process.env.COOKIE_SECURE === 'true'
  || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');

const webOrigins = process.env.WEB_ORIGIN
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const env = {
  port,
  webOrigins,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
  cookieSecure,
  nodeEnv: process.env.NODE_ENV,
  llmApiUrl: String(process.env.LLM_API_URL || '').trim() || 'https://gateway-vibecoderai.ru/v1/llm/generate',
  llmApiUrlIsDefault: !(String(process.env.LLM_API_URL || '').trim()),
  llmGatewayToken: String(process.env.LLM_GATEWAY_TOKEN || '').trim() || null,
  geminiApiKey: String(process.env.GEMINI_API_KEY || '').trim() || null,
  geminiModel: String(process.env.GEMINI_MODEL || '').trim() || null,
  geminiApiBaseUrl:
    String(process.env.GEMINI_API_BASE_URL || '').trim() || 'https://generativelanguage.googleapis.com/v1beta',
  supabaseTimeoutMs: Number(process.env.SUPABASE_TIMEOUT_MS) || 5000,
  tbankTimeoutMs: Number(process.env.TBANK_TIMEOUT_MS) || 15000,
  tbankReconcileIntervalMs: Number(process.env.TBANK_RECONCILE_INTERVAL_MS) || 120000,
  tbankReconcileLookbackHours: Number(process.env.TBANK_RECONCILE_LOOKBACK_HOURS) || 168,
  tbankReconcileBatchSize: Number(process.env.TBANK_RECONCILE_BATCH_SIZE) || 50,
  llmMaxConcurrency: Number(process.env.LLM_MAX_CONCURRENCY) || 2,
  slowLogMs: Number(process.env.SLOW_LOG_MS) || 1500,
  externalSlowLogMs: Number(process.env.EXTERNAL_SLOW_LOG_MS) || 2000,
  termsVersion: process.env.TERMS_VERSION || 'v1',
  privacyVersion: process.env.PRIVACY_VERSION || 'v1',
  tbankTerminalKey: String(process.env.TBANK_TERMINAL_KEY || '').trim() || null,
  tbankPassword: String(process.env.TBANK_PASSWORD || '').trim() || null,
  tbankApiUrl: String(process.env.TBANK_API_URL || '').trim(),
  tbankSuccessUrl: String(process.env.TBANK_SUCCESS_URL || '').trim() || null,
  tbankFailUrl: String(process.env.TBANK_FAIL_URL || '').trim() || null,
  tbankNotificationUrl: String(process.env.TBANK_NOTIFICATION_URL || '').trim() || null,
  tbankSendReceipt: parseBool(process.env.TBANK_SEND_RECEIPT, false),
  tbankReceiptTaxation: String(process.env.TBANK_RECEIPT_TAXATION || '').trim() || null,
  tbankReceiptTax: String(process.env.TBANK_RECEIPT_TAX || '').trim() || null,
  tbankReceiptPaymentMethod: String(process.env.TBANK_RECEIPT_PAYMENT_METHOD || '').trim() || null,
  tbankReceiptPaymentObject: String(process.env.TBANK_RECEIPT_PAYMENT_OBJECT || '').trim() || null,
  publicApiUrl: String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '') || null,
};

export default env;
