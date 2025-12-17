import { createRemoteJWKSet, jwtVerify } from 'jose';
import env from '../config/env.js';

const jwks = createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));
const verifyOptions = {
  issuer: `${env.supabaseUrl}/auth/v1`,
  audience: 'authenticated',
};

export default async function requireUser(req, res, next) {
  const token = req.cookies?.sb_access_token;

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    req.user = {
      id: payload.sub,
      email: payload.email,
      userMetadata: payload.user_metadata || payload.app_metadata?.user_metadata || {},
    };
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
