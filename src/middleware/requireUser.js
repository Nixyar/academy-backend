import { jwtVerify } from 'jose';
import env from '../config/env.js';
import { sendApiError } from '../lib/publicErrors.js';

const jwtSecret = new TextEncoder().encode(env.supabaseJwtSecret);
const normalizeSupabaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');
const verifyOptions = {
  issuer: `${normalizeSupabaseUrl(env.supabaseUrl)}/auth/v1`,
  audience: 'authenticated',
  algorithms: ['HS256'],
};

export default async function requireUser(req, res, next) {
  const token = req.cookies?.sb_access_token;

  if (!token) {
    return sendApiError(res, 401, 'UNAUTHORIZED');
  }

  try {
    const { payload } = await jwtVerify(token, jwtSecret, verifyOptions);
    req.user = {
      id: payload.sub,
      email: payload.email,
      userMetadata: payload.user_metadata || payload.app_metadata?.user_metadata || {},
    };
    return next();
  } catch (error) {
    return sendApiError(res, 401, 'UNAUTHORIZED');
  }
}
