import { Router } from 'express';
import env from '../config/env.js';
import supabaseAnon from '../lib/supabaseAnon.js';
import { getOptionalUser } from '../lib/optionalUser.js';
import { sendApiError } from '../lib/publicErrors.js';
import { getSupabaseClientForRequest } from '../lib/supabaseRequest.js';

const router = Router();

const CONTENT_CACHE_TTL_MS = 5000;
const contentCache = new Map(); // key -> { expiresAt, data }
const contentInFlight = new Map(); // key -> Promise<unknown>

const normalizeParam = (value) => String(value || '').trim();

router.get('/:courseId/content', async (req, res, next) => {
  try {
    const courseId = normalizeParam(req.params?.courseId);
    if (!courseId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const optionalUser = await getOptionalUser(req);
    const cacheKey = `${courseId}:${optionalUser?.id ?? 'anon'}`;
    const cached = contentCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) return res.json(cached.data);
      contentCache.delete(cacheKey);
    }

    const inflight = contentInFlight.get(cacheKey);
    if (inflight) return res.json(await inflight);

    const supabase = getSupabaseClientForRequest(req) ?? supabaseAnon;

    const startedAt = Date.now();
    const promise = (async () => {
      const lessonsSelect =
        'id,course_id,module_id,slug,title,lesson_type,lesson_type_ru,sort_order';

      const modulesSelect = 'id,course_id,sort_order,title';

      const { data: lessons, error: lessonsError } = await supabase
        .from('lessons')
        .select(lessonsSelect)
        .eq('course_id', courseId)
        .order('sort_order', { ascending: true });

      if (lessonsError) {
        throw Object.assign(new Error('FAILED_TO_FETCH_LESSONS'), { status: 500, details: lessonsError });
      }

      let modules = [];
      try {
        const modulesResult = await supabase
          .from('course_modules')
          .select(modulesSelect)
          .eq('course_id', courseId)
          .order('sort_order', { ascending: true });
        if (!modulesResult.error) {
          modules = modulesResult.data || [];
        } else {
          // eslint-disable-next-line no-console
          console.warn('[course-content-modules-skip]', { message: modulesResult.error.message });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[course-content-modules-error]', { message: err instanceof Error ? err.message : String(err) });
      }

      const payload = {
        courseId,
        lessons: lessons || [],
        modules,
      };

      const elapsed = Date.now() - startedAt;
      if (elapsed >= env.slowLogMs) {
        // eslint-disable-next-line no-console
        console.warn('[slow-course-content]', { courseId, ms: elapsed });
      }

      return payload;
    })();

    contentInFlight.set(cacheKey, promise);

    try {
      const data = await promise;
      contentCache.set(cacheKey, { expiresAt: Date.now() + CONTENT_CACHE_TTL_MS, data });
      return res.json(data);
    } finally {
      contentInFlight.delete(cacheKey);
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
