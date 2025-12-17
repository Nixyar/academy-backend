import { createClient } from '@supabase/supabase-js';
import env from '../config/env.js';

const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export default supabaseAnon;
