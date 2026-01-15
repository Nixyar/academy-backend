import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';
import { createTimedFetch } from './fetchWithTimeout.js';
import supabaseAnon from './supabaseAnon.js';

export const getSupabaseClientForRequest = (req) => {
  const accessToken = req?.cookies?.sb_access_token;
  if (!accessToken) return supabaseAnon;

  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      fetch: createTimedFetch(env.supabaseTimeoutMs, {
        name: 'supabase-auth',
        slowMs: env.externalSlowLogMs,
        logger: (event, data) => console.warn(`[${event}]`, data),
      }),
    },
  });
};

