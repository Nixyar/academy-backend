import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { createTimedFetch } from '../lib/fetchWithTimeout.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const ACCESS_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'strict', // Изменено с 'lax' для защиты от CSRF
  secure: env.cookieSecure,
  path: '/',
};

const cookieOptions = (maxAge) => ({ ...baseCookieOptions, maxAge });

const supabaseAuth = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    fetch: createTimedFetch(env.supabaseTimeoutMs, {
      name: 'supabase-auth',
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    }),
  },
});

const setAuthCookies = (res, session) => {
  if (!session) {
    return;
  }

  const { access_token: accessToken, refresh_token: refreshToken } = session;

  if (accessToken) {
    res.cookie('sb_access_token', accessToken, cookieOptions(ACCESS_MAX_AGE_MS));
  }

  if (refreshToken) {
    res.cookie('sb_refresh_token', refreshToken, cookieOptions(REFRESH_MAX_AGE_MS));
  }
};

router.post('/session', (req, res) => {
  const { access_token: accessToken, refresh_token: refreshToken } = req.body || {};

  if (!accessToken || !refreshToken) {
    return sendApiError(res, 400, 'INVALID_REQUEST');
  }

  res.cookie('sb_access_token', accessToken, cookieOptions(ACCESS_MAX_AGE_MS));
  res.cookie('sb_refresh_token', refreshToken, cookieOptions(REFRESH_MAX_AGE_MS));

  return res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return sendApiError(res, 400, 'INVALID_REQUEST');
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  if (error || !data?.session || !data?.user) {
    return sendApiError(res, 401, 'UNAUTHORIZED');
  }

  setAuthCookies(res, data.session);

  return res.json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
      name: data.user.user_metadata?.name || data.user.user_metadata?.full_name || null,
    },
  });
});

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return sendApiError(res, 400, 'INVALID_REQUEST');
  }

  // Password validation
  if (password.length < 8) {
    return sendApiError(res, 400, 'PASSWORD_TOO_SHORT', {
      message: 'Пароль должен содержать минимум 8 символов',
    });
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return sendApiError(res, 400, 'PASSWORD_TOO_WEAK', {
      message: 'Пароль должен содержать буквы и цифры',
    });
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
      },
    },
  });

  if (error || !data?.user) {
    return sendApiError(res, 400, 'INVALID_REQUEST');
  }

  const profilePayload = {
    id: data.user.id,
    email: data.user.email,
    name,
  };

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert(profilePayload);

  if (profileError) {
    return sendApiError(res, 500, 'INTERNAL_ERROR');
  }

  if (data.session) {
    setAuthCookies(res, data.session);
  }

  return res.status(201).json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
      name,
    },
  });
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.sb_refresh_token;

  if (!refreshToken) {
    return sendApiError(res, 401, 'UNAUTHORIZED');
  }

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session) {
    return sendApiError(res, 401, 'UNAUTHORIZED');
  }

  const { access_token: accessToken, refresh_token: newRefreshToken } = data.session;

  res.cookie('sb_access_token', accessToken, cookieOptions(ACCESS_MAX_AGE_MS));
  res.cookie('sb_refresh_token', newRefreshToken, cookieOptions(REFRESH_MAX_AGE_MS));

  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('sb_access_token', baseCookieOptions);
  res.clearCookie('sb_refresh_token', baseCookieOptions);
  res.json({ ok: true });
});

export default router;
