import { Router } from 'express';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import env from '../config/env.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) return String(forwarded[0]).trim();
  return req.ip || req.socket?.remoteAddress || null;
};

router.get('/', requireUser, async (req, res, next) => {
  try {
    const { user } = req;

    const { data: existingProfile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (fetchError) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    if (!existingProfile) {
      const newProfile = {
        id: user.id,
        email: user.email,
        name: user.userMetadata?.full_name || user.userMetadata?.name || null,
        avatar_url: user.userMetadata?.avatar_url || null,
        plan: 'free',
        daily_limit: 15,
        daily_used: 0,
        terms_accepted: false,
        privacy_accepted: false,
      };

      const { data: createdProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert(newProfile)
        .select()
        .single();

      if (insertError) {
        return sendApiError(res, 500, 'INTERNAL_ERROR');
      }

      return res.json(createdProfile);
    }

    return res.json(existingProfile);
  } catch (error) {
    return next(error);
  }
});

router.post('/consent', requireUser, async (req, res, next) => {
  try {
    const { user } = req;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const termsAccepted =
      body.termsAccepted ?? body.terms_accepted ?? body.terms ?? undefined;
    const privacyAccepted =
      body.privacyAccepted ?? body.privacy_accepted ?? body.privacy ?? undefined;

    if (termsAccepted === false || privacyAccepted === false) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }

    const shouldUpdateTerms = termsAccepted === true;
    const shouldUpdatePrivacy = privacyAccepted === true;
    if (!shouldUpdateTerms && !shouldUpdatePrivacy) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }

    const now = new Date().toISOString();
    const consentIp = getClientIp(req);
    const consentUserAgent = req.get('user-agent') || null;

    const updates = {
      ...(shouldUpdateTerms
        ? { terms_accepted: true, terms_accepted_at: now, terms_version: env.termsVersion }
        : {}),
      ...(shouldUpdatePrivacy
        ? { privacy_accepted: true, privacy_accepted_at: now, privacy_version: env.privacyVersion }
        : {}),
      consent_ip: consentIp,
      consent_user_agent: consentUserAgent,
    };

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select('*')
      .maybeSingle();

    if (updateError) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    if (updated) return res.json(updated);

    const newProfile = {
      id: user.id,
      email: user.email,
      name: user.userMetadata?.full_name || user.userMetadata?.name || null,
      avatar_url: user.userMetadata?.avatar_url || null,
      plan: 'free',
      daily_limit: 15,
      daily_used: 0,
      terms_accepted: false,
      privacy_accepted: false,
      ...updates,
    };

    const { data: created, error: insertError } = await supabaseAdmin
      .from('profiles')
      .insert(newProfile)
      .select('*')
      .single();

    if (insertError) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    return res.json(created);
  } catch (error) {
    return next(error);
  }
});

export default router;
