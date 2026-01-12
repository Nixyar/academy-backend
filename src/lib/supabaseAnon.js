import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { createTimedFetch } from './fetchWithTimeout.js';

const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    fetch: createTimedFetch(env.supabaseTimeoutMs, {
      name: 'supabase-anon',
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    }),
  },
});

export default supabaseAnon;
