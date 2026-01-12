import { Router } from 'express';
import crypto from 'crypto';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import env from '../config/env.js';
import { createTbankToken } from '../lib/tbank.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const safeInt = (value) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
};

const getApiUrl = (path) => {
  const base = String(env.tbankApiUrl || '').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};

const isConfigured = () => {
  const apiUrl = String(env.tbankApiUrl || '').trim();
  return Boolean(env.tbankTerminalKey && env.tbankPassword && apiUrl);
};

const readTbankJsonSafe = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const normalizeStatus = (status) => String(status || '').trim().toLowerCase();

const isPaidStatus = (status) => {
  const normalized = normalizeStatus(status);
  return ['paid', 'succeeded', 'success', 'completed', 'captured', 'confirmed'].includes(normalized);
};

const isLikelyPaidTbankStatus = (status) => {
  const normalized = normalizeStatus(status);
  return ['confirmed', 'paid'].includes(normalized);
};

router.post('/tbank/init', requireUser, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      console.warn('[tbank-not-configured]', {
        hasTerminalKey: Boolean(env.tbankTerminalKey),
        hasPassword: Boolean(env.tbankPassword),
        hasApiUrl: Boolean(String(env.tbankApiUrl || '').trim()),
      });
      return sendApiError(res, 503, 'PAYMENTS_NOT_CONFIGURED', {
        details: {
          hasTerminalKey: Boolean(env.tbankTerminalKey),
          hasPassword: Boolean(env.tbankPassword),
          hasApiUrl: Boolean(String(env.tbankApiUrl || '').trim()),
        },
      });
    }

    const courseId = String(req.body?.courseId || '').trim();
    if (!courseId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const { data: course, error: courseError } = await supabaseAdmin
      .from('courses')
      .select('id,title,price,sale_price,currency')
      .eq('id', courseId)
      .maybeSingle();

    if (courseError) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }
    if (!course) return sendApiError(res, 404, 'COURSE_NOT_FOUND');

    const amountRub = safeInt(course.sale_price ?? course.price);
    if (amountRub === null) return sendApiError(res, 400, 'INVALID_REQUEST');
    if (amountRub <= 0) return sendApiError(res, 400, 'INVALID_REQUEST');

    const amountKopeks = amountRub * 100;
    const orderId = crypto.randomUUID();

    const origin = req.headers.origin && typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const fallbackOrigin = Array.isArray(env.webOrigins) ? env.webOrigins[0] : null;
    const webOrigin = origin || fallbackOrigin;
    const successUrl = env.tbankSuccessUrl || (webOrigin ? `${webOrigin}/profile?payment=success&orderId=${encodeURIComponent(orderId)}` : null);
    const failUrl = env.tbankFailUrl || (webOrigin ? `${webOrigin}/profile?payment=fail&orderId=${encodeURIComponent(orderId)}` : null);

    const { user } = req;
    const insertRow = {
      user_id: user.id,
      course_id: courseId,
      status: 'initiated',
      amount_rub: amountRub,
      amount_kopeks: amountKopeks,
      provider: 'tbank',
      order_id: orderId,
    };

    const { data: created, error: insertError } = await supabaseAdmin
      .from('course_purchases')
      .insert(insertRow)
      .select('id,order_id')
      .single();

    if (insertError) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    const initPayload = {
      TerminalKey: env.tbankTerminalKey,
      Amount: amountKopeks,
      OrderId: orderId,
      Description: course.title ? `Покупка курса: ${course.title}` : 'Покупка курса',
      ...(successUrl ? { SuccessURL: successUrl } : {}),
      ...(failUrl ? { FailURL: failUrl } : {}),
      ...(env.tbankNotificationUrl ? { NotificationURL: env.tbankNotificationUrl } : {}),
    };

    const Token = createTbankToken(initPayload, env.tbankPassword);
    const body = { ...initPayload, Token };

    const response = await fetchWithTimeout(getApiUrl('/Init'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, {
      name: 'tbank-init',
      timeoutMs: env.tbankTimeoutMs,
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    });

    const json = await readTbankJsonSafe(response);
    if (!response.ok || !json) {
      await supabaseAdmin.from('course_purchases').update({ status: 'failed' }).eq('id', created.id);
      console.error('[tbank-init-failed]', { status: response.status, statusText: response.statusText, body: json });
      return sendApiError(res, 502, 'PAYMENT_PROVIDER_ERROR');
    }

    const paymentId = json.PaymentId || json.paymentId || null;
    const paymentUrl = json.PaymentURL || json.PaymentUrl || json.paymentUrl || null;
    const success = json.Success === true || json.success === true;

    if (!success || !paymentUrl) {
      await supabaseAdmin
        .from('course_purchases')
        .update({ status: String(json.Status || json.status || 'failed'), payment_id: paymentId })
        .eq('id', created.id);
      console.error('[tbank-init-rejected]', { body: json });
      return sendApiError(res, 502, 'PAYMENT_PROVIDER_ERROR');
    }

    await supabaseAdmin
      .from('course_purchases')
      .update({ status: String(json.Status || json.status || 'created'), payment_id: paymentId })
      .eq('id', created.id);

    return res.json({ paymentUrl, orderId });
  } catch (error) {
    return next(error);
  }
});

router.post('/tbank/notification', async (req, res, next) => {
  try {
    if (!env.tbankTerminalKey || !env.tbankPassword) {
      return sendApiError(res, 503, 'PAYMENTS_NOT_CONFIGURED', {
        details: {
          hasTerminalKey: Boolean(env.tbankTerminalKey),
          hasPassword: Boolean(env.tbankPassword),
        },
      });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const incomingToken = String(payload.Token || payload.token || '');
    const terminalKey = String(payload.TerminalKey || payload.terminalKey || '');
    if (!incomingToken || !terminalKey) return sendApiError(res, 400, 'INVALID_REQUEST');
    if (terminalKey !== env.tbankTerminalKey) return sendApiError(res, 403, 'FORBIDDEN');

    const expected = createTbankToken(payload, env.tbankPassword);
    if (expected.toLowerCase() !== incomingToken.toLowerCase()) {
      return sendApiError(res, 403, 'FORBIDDEN');
    }

    const orderId = String(payload.OrderId || payload.orderId || '').trim();
    const paymentId = String(payload.PaymentId || payload.paymentId || '').trim() || null;
    const status = String(payload.Status || payload.status || '').trim().toLowerCase();

    if (!orderId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const updates = {
      status: status || 'unknown',
      payment_id: paymentId,
      ...(isPaidStatus(status)
        ? { paid_at: new Date().toISOString() }
        : {}),
    };

    await supabaseAdmin.from('course_purchases').update(updates).eq('order_id', orderId);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/tbank/sync', requireUser, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return sendApiError(res, 503, 'PAYMENTS_NOT_CONFIGURED', {
        details: {
          hasTerminalKey: Boolean(env.tbankTerminalKey),
          hasPassword: Boolean(env.tbankPassword),
          hasApiUrl: Boolean(String(env.tbankApiUrl || '').trim()),
        },
      });
    }

    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const { user } = req;
    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from('course_purchases')
      .select('id,order_id,course_id,status,payment_id,paid_at')
      .eq('user_id', user.id)
      .eq('order_id', orderId)
      .maybeSingle();

    if (purchaseError) return sendApiError(res, 500, 'INTERNAL_ERROR');
    if (!purchase) return sendApiError(res, 404, 'PURCHASE_NOT_FOUND');

    if (!purchase.payment_id) {
      return res.json({ status: purchase.status, courseId: purchase.course_id, paidAt: purchase.paid_at });
    }

    const statePayload = {
      TerminalKey: env.tbankTerminalKey,
      PaymentId: purchase.payment_id,
    };
    const Token = createTbankToken(statePayload, env.tbankPassword);

    const response = await fetchWithTimeout(getApiUrl('/GetState'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...statePayload, Token }),
    }, {
      name: 'tbank-get-state',
      timeoutMs: env.tbankTimeoutMs,
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    });

    const json = await readTbankJsonSafe(response);
    if (!response.ok || !json) {
      console.error('[tbank-get-state-failed]', { status: response.status, statusText: response.statusText, body: json });
      return sendApiError(res, 502, 'PAYMENT_PROVIDER_ERROR');
    }

    const tbankStatusRaw = json.Status || json.status || purchase.status || 'unknown';
    const tbankStatus = normalizeStatus(tbankStatusRaw);
    const paidAt =
      isLikelyPaidTbankStatus(tbankStatus) || isPaidStatus(tbankStatus)
        ? (purchase.paid_at || new Date().toISOString())
        : purchase.paid_at;

    await supabaseAdmin
      .from('course_purchases')
      .update({
        status: tbankStatus,
        paid_at: paidAt,
      })
      .eq('id', purchase.id);

    return res.json({ status: tbankStatus, courseId: purchase.course_id, paidAt });
  } catch (error) {
    return next(error);
  }
});

export default router;
