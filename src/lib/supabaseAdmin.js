import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { createTimedFetch } from './fetchWithTimeout.js';

const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    fetch: createTimedFetch(env.supabaseTimeoutMs, {
      name: 'supabase',
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    }),
  },
});

export default supabaseAdmin;
