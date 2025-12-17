import dotenv from 'dotenv';

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  dotenv.config();
}

const requiredKeys = [
  'PORT',
  'WEB_ORIGIN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
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

const env = {
  port,
  webOrigin: process.env.WEB_ORIGIN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  cookieSecure,
  nodeEnv: process.env.NODE_ENV,
};

export default env;
