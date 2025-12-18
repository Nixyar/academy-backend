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

const env = {
  port,
  webOrigins,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
  cookieSecure,
  nodeEnv: process.env.NODE_ENV,
};

export default env;
