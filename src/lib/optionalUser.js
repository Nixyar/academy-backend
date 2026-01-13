import { jwtVerify } from 'jose';
import env from '../config/env.js';

const jwtSecret = new TextEncoder().encode(env.supabaseJwtSecret);
const normalizeSupabaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');
const verifyOptions = {
  issuer: `${normalizeSupabaseUrl(env.supabaseUrl)}/auth/v1`,
  audience: 'authenticated',
  algorithms: ['HS256'],
};

export const getOptionalUser = async (req) => {
  const token = req.cookies?.sb_access_token;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwtSecret, verifyOptions);
    return {
      id: payload.sub,
      email: payload.email,
    };
  } catch {
    return null;
  }
};

