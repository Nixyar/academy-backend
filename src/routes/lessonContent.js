import { Router } from 'express';
import supabaseAnon from '../lib/supabaseAnon.js';
import { sendApiError } from '../lib/publicErrors.js';
import { getSupabaseClientForRequest } from '../lib/supabaseRequest.js';

const router = Router();

const TTL_MS = 60 * 1000;
const lessonContentCache = new Map(); // lessonId -> { etag, payload, expiresAt }
const lessonContentInFlight = new Map(); // lessonId -> Promise<{ etag, payload }>

const normalizeParam = (value) => String(value || '').trim();

const getHeaderString = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
};

const replyWithEtag = (req, res, etag, payload) => {
  res.setHeader('ETag', etag);
  const ifNoneMatch = getHeaderString(req.headers['if-none-match']);
  if (ifNoneMatch === etag) {
    return res.status(304).end();
  }
  return res.json(payload);
};

router.get('/:lessonId/content', async (req, res, next) => {
  try {
    const lessonId = normalizeParam(req.params?.lessonId);
    if (!lessonId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const cached = lessonContentCache.get(lessonId);
    if (cached && cached.expiresAt > Date.now()) {
      return replyWithEtag(req, res, cached.etag, cached.payload);
    } else if (cached) {
      lessonContentCache.delete(lessonId);
    }

    const inflight = lessonContentInFlight.get(lessonId);
    if (inflight) {
      const data = await inflight;
      return replyWithEtag(req, res, data.etag, data.payload);
    }

    const promise = (async () => {
      const supabase = getSupabaseClientForRequest(req) ?? supabaseAnon;
      const { data, error } = await supabase
        .from('lesson_content')
        .select('blocks, content_hash')
        .eq('lesson_id', lessonId)
        .single();

      if (error) {
        const status = typeof error.status === 'number' ? error.status : 500;
        if (status === 406 || status === 404) {
          throw Object.assign(new Error('LESSON_NOT_FOUND'), { status: 404 });
        }
        throw Object.assign(new Error('INTERNAL_ERROR'), { status: 500, details: error });
      }

      const contentHash = data?.content_hash ?? '';
      const etag = `"lesson:${lessonId}:${contentHash}"`;
      const payload = {
        blocks: data?.blocks ?? null,
      };

      lessonContentCache.set(lessonId, { etag, payload, expiresAt: Date.now() + TTL_MS });
      return { etag, payload };
    })();

    lessonContentInFlight.set(lessonId, promise);
    try {
      const data = await promise;
      return replyWithEtag(req, res, data.etag, data.payload);
    } finally {
      lessonContentInFlight.delete(lessonId);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && Number(e.status) === 404) {
      return sendApiError(res, 404, 'LESSON_NOT_FOUND');
    }
    if (e && typeof e === 'object' && 'status' in e && Number(e.status) === 500) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }
    return next(e);
  }
});

export default router;
