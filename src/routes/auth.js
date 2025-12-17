import { Router } from 'express';
import env from '../config/env.js';

const router = Router();

const ACCESS_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.cookieSecure,
  path: '/',
};

const cookieOptions = (maxAge) => ({ ...baseCookieOptions, maxAge });

router.post('/session', (req, res) => {
  const { access_token: accessToken, refresh_token: refreshToken } = req.body || {};

  if (!accessToken || !refreshToken) {
    return res.status(400).json({ error: 'access_token and refresh_token are required' });
  }

  res.cookie('sb_access_token', accessToken, cookieOptions(ACCESS_MAX_AGE_MS));
  res.cookie('sb_refresh_token', refreshToken, cookieOptions(REFRESH_MAX_AGE_MS));

  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('sb_access_token', baseCookieOptions);
  res.clearCookie('sb_refresh_token', baseCookieOptions);
  res.json({ ok: true });
});

export default router;
