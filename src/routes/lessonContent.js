import { Router } from 'express';
import supabaseAnon from '../lib/supabaseAnon.js';
import { sendApiError } from '../lib/publicErrors.js';
import { getSupabaseClientForRequest } from '../lib/supabaseRequest.js';

const router = Router();

const lessonContentHashCache = new Map(); // lessonId -> contentHash

const normalizeParam = (value) => String(value || '').trim();

const getHeaderString = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
};

router.get('/:lessonId/content', async (req, res, next) => {
  try {
    const lessonId = normalizeParam(req.params?.lessonId);
    if (!lessonId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const ifNoneMatch = getHeaderString(req.headers['if-none-match']);
    const cachedHash = lessonContentHashCache.get(lessonId);
    if (cachedHash) {
      const cachedEtag = `"lesson:${lessonId}:${cachedHash}"`;
      if (ifNoneMatch === cachedEtag) {
        res.setHeader('ETag', cachedEtag);
        return res.status(304).end();
      }
    }

    const supabase = getSupabaseClientForRequest(req) ?? supabaseAnon;
    const { data, error } = await supabase
      .from('lesson_content')
      .select('blocks, settings, unlock_rule, content_hash')
      .eq('lesson_id', lessonId)
      .single();

    if (error) {
      const status = typeof error.status === 'number' ? error.status : 500;
      if (status === 406 || status === 404) return sendApiError(res, 404, 'LESSON_NOT_FOUND');
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    const contentHash = data?.content_hash ?? '';
    const etag = `"lesson:${lessonId}:${contentHash}"`;
    lessonContentHashCache.set(lessonId, contentHash);

    res.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      return res.status(304).end();
    }

    return res.json({
      blocks: data?.blocks ?? null,
      settings: data?.settings ?? null,
      unlock_rule: data?.unlock_rule ?? null,
    });
  } catch (e) {
    return next(e);
  }
});

export default router;

