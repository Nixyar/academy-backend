import { Router } from 'express';
import env from '../config/env.js';
import supabaseAnon from '../lib/supabaseAnon.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const CONTENT_CACHE_TTL_MS = 5000;
const contentCache = new Map(); // key -> { expiresAt, data }
const contentInFlight = new Map(); // key -> Promise<unknown>

const isMissingColumnError = (error, columnName) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return (
    message.includes(`column "${columnName}"`) ||
    message.includes(`column '${columnName}'`) ||
    message.includes(`column ${columnName}`)
  );
};

const normalizeParam = (value) => String(value || '').trim();

router.get('/:courseId/content', async (req, res, next) => {
  try {
    const courseId = normalizeParam(req.params?.courseId);
    if (!courseId) return sendApiError(res, 400, 'INVALID_REQUEST');

    const cacheKey = courseId;
    const cached = contentCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) return res.json(cached.data);
      contentCache.delete(cacheKey);
    }

    const inflight = contentInFlight.get(cacheKey);
    if (inflight) return res.json(await inflight);

    const startedAt = Date.now();
    const promise = (async () => {
      const lessonsPrimary =
        'id,course_id,module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode';
      const lessonsNoModule =
        'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode';
      const lessonsFallback =
        'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings';

      const modulesSelect = 'id,course_id,sort_order,title';

      const buildLessonsQuery = (selectFields) => {
        return supabaseAnon
          .from('lessons')
          .select(selectFields)
          .eq('course_id', courseId)
          .order('sort_order', { ascending: true });
      };

      const buildModulesQuery = () => {
        return supabaseAnon
          .from('course_modules')
          .select(modulesSelect)
          .eq('course_id', courseId)
          .order('sort_order', { ascending: true });
      };

      let lessonsResult = await buildLessonsQuery(lessonsPrimary);
      if (lessonsResult.error && isMissingColumnError(lessonsResult.error, 'module_id')) {
        lessonsResult = await buildLessonsQuery(lessonsNoModule);
      }
      if (lessonsResult.error) {
        // eslint-disable-next-line no-console
        console.warn('[course-content-lessons-fallback]', { message: lessonsResult.error.message });
        lessonsResult = await buildLessonsQuery(lessonsFallback);
      }
      if (lessonsResult.error) {
        throw Object.assign(new Error('FAILED_TO_FETCH_LESSONS'), { status: 500, details: lessonsResult.error });
      }

      let modules = [];
      try {
        const modulesResult = await buildModulesQuery();
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
        lessons: lessonsResult.data || [],
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

