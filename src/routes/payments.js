import { Router } from 'express';
import crypto from 'crypto';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import env from '../config/env.js';
import { createTbankTokenExcluding, verifyTbankToken } from '../lib/tbank.js';
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

const isAllowedRedirectUrl = (url) => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    return Array.isArray(env.webOrigins) && env.webOrigins.some((allowed) => allowed === origin);
  } catch {
    return false;
  }
};

const withQuery = (url, params) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params || {})) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
};

const getPublicBaseUrl = (req) => {
  const proto =
    (req.get('x-forwarded-proto') || '').split(',')[0].trim()
    || req.protocol
    || 'https';
  const host =
    (req.get('x-forwarded-host') || '').split(',')[0].trim()
    || req.get('host')
    || '';
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return null;
  return `${proto}://${host}`;
};

const readTbankJsonSafe = async (response) => {
  try {
    const text = await response.text();
    if (!text) return { json: null, text: '' };

    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    try {
      return { json: JSON.parse(text), text: truncated };
    } catch {
      return { json: null, text: truncated };
    }
  } catch {
    return { json: null, text: '' };
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

const isInvalidTokenResponse = (json) => {
  if (!json || typeof json !== 'object') return false;
  const errorCode = String(json.ErrorCode || json.errorCode || '').trim();
  const details = String(json.Details || json.details || '').toLowerCase();
  return errorCode === '204' && details.includes('токен');
};

const isMissingRelationError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return /relation .* does not exist/i.test(message);
};

const normalizeSupabaseErrorMessage = (error) => {
  if (!error || typeof error !== 'object') return '';
  if ('message' in error) return String(error.message || '');
  return '';
};

const isOnConflictConstraintError = (error) => {
  const message = normalizeSupabaseErrorMessage(error).toLowerCase();
  // Postgres: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
  // Supabase often forwards this as plain message.
  return message.includes('on conflict') && message.includes('constraint');
};

const grantUserCourse = async ({ userId, courseId, purchaseId, status }) => {
  const grantedAt = new Date().toISOString();
  try {
    const { error } = await supabaseAdmin
      .from('user_courses')
      .upsert(
        {
          user_id: userId,
          course_id: courseId,
          purchase_id: purchaseId,
          status: status || 'active',
          granted_at: grantedAt,
        },
        { onConflict: 'user_id,course_id' },
      );

    if (!error) return true;
    if (isMissingRelationError(error)) return false;

    // Fallback if the table doesn't have a unique constraint for (user_id, course_id).
    if (isOnConflictConstraintError(error)) {
      const { data: existing, error: selectError } = await supabaseAdmin
        .from('user_courses')
        .select('id')
        .eq('user_id', userId)
        .eq('course_id', courseId)
        .maybeSingle();

      if (selectError && !isMissingRelationError(selectError)) {
        console.error('[user-courses-select-failed]', { message: selectError.message });
        return false;
      }

      if (existing?.id) {
        const { error: updateError } = await supabaseAdmin
          .from('user_courses')
          .update({
            purchase_id: purchaseId,
            status: status || 'active',
            granted_at: grantedAt,
          })
          .eq('id', existing.id);

        if (updateError) {
          console.error('[user-courses-update-failed]', { message: updateError.message });
          return false;
        }
        return true;
      }

      const { error: insertError } = await supabaseAdmin
        .from('user_courses')
        .insert({
          user_id: userId,
          course_id: courseId,
          purchase_id: purchaseId,
          status: status || 'active',
          granted_at: grantedAt,
        });

      if (insertError) {
        console.error('[user-courses-insert-failed]', { message: insertError.message });
        return false;
      }
      return true;
    }

    console.error('[user-courses-upsert-failed]', { message: normalizeSupabaseErrorMessage(error) });
    return false;
  } catch (err) {
    console.error('[user-courses-upsert-crash]', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
};

const buildReceipt = ({ userEmail, courseTitle, amountKopeks }) => {
  if (!env.tbankSendReceipt) return null;

  const email = String(userEmail || '').trim();
  if (!email) {
    throw Object.assign(new Error('RECEIPT_EMAIL_REQUIRED'), { status: 400 });
  }

  const taxation = String(env.tbankReceiptTaxation || '').trim();
  const tax = String(env.tbankReceiptTax || '').trim();
  const paymentMethod = String(env.tbankReceiptPaymentMethod || '').trim() || 'full_payment';
  const paymentObject = String(env.tbankReceiptPaymentObject || '').trim() || 'service';

  if (!taxation || !tax) {
    // Receipt was requested but not configured.
    throw Object.assign(new Error('RECEIPT_NOT_CONFIGURED'), { status: 503 });
  }

  const item = {
    Name: String(courseTitle || 'Покупка курса').trim() || 'Покупка курса',
    Price: amountKopeks,
    Quantity: 1,
    Amount: amountKopeks,
    Tax: tax,
    PaymentMethod: paymentMethod,
    PaymentObject: paymentObject,
  };

  return {
    Email: email,
    Taxation: taxation,
    Items: [item],
  };
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
    const defaultSuccessUrl = webOrigin ? `${webOrigin}/profile` : null;
    const defaultFailUrl = webOrigin ? `${webOrigin}/profile` : null;

    // Important: user needs to return to our app with orderId so we can call `/tbank/sync`
    // and update `course_purchases` + grant `user_courses`.
    const configuredSuccessUrl = isAllowedRedirectUrl(env.tbankSuccessUrl) ? env.tbankSuccessUrl : null;
    const configuredFailUrl = isAllowedRedirectUrl(env.tbankFailUrl) ? env.tbankFailUrl : null;

    const successUrlBase = configuredSuccessUrl || defaultSuccessUrl;
    const failUrlBase = configuredFailUrl || defaultFailUrl;

    const successUrl = successUrlBase
      ? withQuery(successUrlBase, { payment: 'success', orderId })
      : null;
    const failUrl = failUrlBase
      ? withQuery(failUrlBase, { payment: 'fail', orderId })
      : null;
    const publicBaseUrl = getPublicBaseUrl(req);
    const notificationUrl = env.tbankNotificationUrl
      || (env.publicApiUrl ? `${env.publicApiUrl}/api/payments/tbank/notification` : null)
      || (publicBaseUrl ? `${publicBaseUrl}/api/payments/tbank/notification` : null);

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
      ...(notificationUrl ? { NotificationURL: notificationUrl } : {}),
    };

    let receipt = null;
    try {
      receipt = buildReceipt({ userEmail: user.email, courseTitle: course.title, amountKopeks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'RECEIPT_NOT_CONFIGURED') {
        console.warn('[tbank-receipt-not-configured]', {
          hasTaxation: Boolean(env.tbankReceiptTaxation),
          hasTax: Boolean(env.tbankReceiptTax),
        });
        return sendApiError(res, 503, 'PAYMENTS_NOT_CONFIGURED');
      }
      if (message === 'RECEIPT_EMAIL_REQUIRED') {
        return sendApiError(res, 400, 'INVALID_REQUEST');
      }
      throw err;
    }

    if (receipt) {
      initPayload.Receipt = receipt;
    }

    console.info('[tbank-init]', {
      orderId,
      amountKopeks,
      hasReceipt: Boolean(receipt),
      receiptMeta: receipt
        ? {
          taxation: receipt.Taxation,
          tax: receipt.Items?.[0]?.Tax,
          paymentMethod: receipt.Items?.[0]?.PaymentMethod,
          paymentObject: receipt.Items?.[0]?.PaymentObject,
        }
        : null,
    });

    const callInit = async (payload, tokenMode, { excludeReceiptFromToken = false } = {}) => {
      const Token = excludeReceiptFromToken
        ? createTbankTokenExcluding(payload, env.tbankPassword, { excludeKeys: ['Receipt'], mode: tokenMode })
        : createTbankTokenExcluding(payload, env.tbankPassword, { mode: tokenMode });
      const body = { ...payload, Token };
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
      const parsed = await readTbankJsonSafe(response);
      return { response, ...parsed, tokenMode, excludeReceiptFromToken };
    };

    const tokenModes = ['password_key', 'append_password', 'key_value'];
    const tokenVariants = receipt
      ? [
        { mode: tokenModes[0], excludeReceiptFromToken: true }, // most likely for DEMO receipts
        { mode: tokenModes[0], excludeReceiptFromToken: false },
        ...tokenModes.slice(1).flatMap((mode) => ([
          { mode, excludeReceiptFromToken: true },
          { mode, excludeReceiptFromToken: false },
        ])),
      ]
      : tokenModes.map((mode) => ({ mode, excludeReceiptFromToken: false }));

    let initAttempt = await callInit(initPayload, tokenVariants[0].mode, { excludeReceiptFromToken: tokenVariants[0].excludeReceiptFromToken });
    if (!initAttempt.response.ok || !initAttempt.json) {
      await supabaseAdmin.from('course_purchases').update({ status: 'failed' }).eq('id', created.id);
      console.error('[tbank-init-failed]', {
        status: initAttempt.response.status,
        statusText: initAttempt.response.statusText,
        body: initAttempt.json,
        bodyText: initAttempt.text || null,
        tokenMode: initAttempt.tokenMode,
        excludeReceiptFromToken: initAttempt.excludeReceiptFromToken,
      });
      return sendApiError(res, 502, 'PAYMENT_PROVIDER_ERROR');
    }

    // If provider complains about token, try alternative canonicalization modes.
    if (isInvalidTokenResponse(initAttempt.json)) {
      for (const variant of tokenVariants.slice(1)) {
        console.warn('[tbank-init-invalid-token-mode-retry]', {
          orderId,
          mode: variant.mode,
          excludeReceiptFromToken: variant.excludeReceiptFromToken,
        });
        initAttempt = await callInit(initPayload, variant.mode, { excludeReceiptFromToken: variant.excludeReceiptFromToken });
        if (!initAttempt.response.ok || !initAttempt.json) continue;
        if (!isInvalidTokenResponse(initAttempt.json)) break;
      }
    }

    if (receipt && isInvalidTokenResponse(initAttempt.json)) {
      console.error('[tbank-init-invalid-token]', { orderId, hasReceipt: true });
      return sendApiError(res, 502, 'PAYMENT_PROVIDER_ERROR');
    }

    const json = initAttempt.json;

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

    if (!verifyTbankToken(payload, env.tbankPassword, incomingToken)) {
      return sendApiError(res, 403, 'FORBIDDEN');
    }

    const orderId = String(payload.OrderId || payload.orderId || '').trim();
    const paymentId = String(payload.PaymentId || payload.paymentId || '').trim() || null;
    const status = String(payload.Status || payload.status || '').trim().toLowerCase();

    if (!orderId) return sendApiError(res, 400, 'INVALID_REQUEST');
    console.info('[tbank-notification]', { orderId, paymentId, status });

    const updates = {
      status: status || 'unknown',
      payment_id: paymentId,
      ...(isPaidStatus(status)
        ? { paid_at: new Date().toISOString() }
        : {}),
    };

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('course_purchases')
      .update(updates)
      .eq('order_id', orderId)
      .select('id,user_id,course_id,status,paid_at')
      .maybeSingle();

    if (updateError) {
      console.error('[tbank-notification-update-failed]', { message: updateError.message });
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    if (updated && (Boolean(updated.paid_at) || isPaidStatus(updated.status))) {
      await grantUserCourse({
        userId: updated.user_id,
        courseId: updated.course_id,
        purchaseId: updated.id,
        status: 'active',
      });
    }

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
    const tokenModes = ['password_key', 'append_password', 'key_value'];
    let json = null;
    let responseText = null;
    let okResponse = null;

    for (const mode of tokenModes) {
      const Token = createTbankTokenExcluding(statePayload, env.tbankPassword, { mode });
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

      const parsed = await readTbankJsonSafe(response);
      json = parsed.json;
      responseText = parsed.text;
      okResponse = response;
      if (response.ok && json && !isInvalidTokenResponse(json)) {
        break;
      }
    }

    if (!okResponse || !okResponse.ok || !json) {
      console.error('[tbank-get-state-failed]', {
        status: okResponse ? okResponse.status : null,
        statusText: okResponse ? okResponse.statusText : null,
        body: json,
        bodyText: responseText || null,
      });
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

    if (paidAt || isPaidStatus(tbankStatus)) {
      await grantUserCourse({
        userId: user.id,
        courseId: purchase.course_id,
        purchaseId: purchase.id,
        status: 'active',
      });
    }

    return res.json({ status: tbankStatus, courseId: purchase.course_id, paidAt });
  } catch (error) {
    return next(error);
  }
});

export default router;
