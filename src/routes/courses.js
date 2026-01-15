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
      const lessonSelectVariants = [
        // Newest schema (includes module_id and newer optional columns)
        'id,course_id,module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode',
        // Older schemas that may miss unlock_rule/settings_mode
        'id,course_id,module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings,mode',
        'id,course_id,module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings',
        // Minimal while still preserving module linkage when available
        'id,course_id,module_id,slug,title,lesson_type,sort_order,blocks',
      ];

      const lessonSelectVariantsAltModuleId = [
        // Some backends store module linkage as course_module_id instead of module_id
        'id,course_id,course_module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode',
        'id,course_id,course_module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings,mode',
        'id,course_id,course_module_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings',
        'id,course_id,course_module_id,slug,title,lesson_type,sort_order,blocks',
      ];

      const lessonSelectVariantsNoModule = [
        // Back-compat for schemas that do not have module_id at all
        'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode',
        'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings,mode',
        'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings',
        'id,course_id,slug,title,lesson_type,sort_order,blocks',
      ];

      const modulesSelect = 'id,course_id,sort_order,title';

      const buildLessonsQuery = (selectFields) => {
        return supabase
          .from('lessons')
          .select(selectFields)
          .eq('course_id', courseId)
          .order('sort_order', { ascending: true });
      };

      const buildModulesQuery = () => {
        return supabase
          .from('course_modules')
          .select(modulesSelect)
          .eq('course_id', courseId)
          .order('sort_order', { ascending: true });
      };

      const fetchLessonsWithFallbacks = async () => {
        let lastError = null;

        for (const selectFields of lessonSelectVariants) {
          const result = await buildLessonsQuery(selectFields);
          if (!result.error) return result;
          lastError = result.error;
          if (isMissingColumnError(result.error, 'module_id')) break;
          // eslint-disable-next-line no-console
          console.warn('[course-content-lessons-select-failed]', { selectFields, message: result.error.message });
        }

        for (const selectFields of lessonSelectVariantsAltModuleId) {
          const result = await buildLessonsQuery(selectFields);
          if (!result.error) return result;
          lastError = result.error;
          if (isMissingColumnError(result.error, 'course_module_id')) break;
          // eslint-disable-next-line no-console
          console.warn('[course-content-lessons-select-failed-alt-module]', {
            selectFields,
            message: result.error.message,
          });
        }

        for (const selectFields of lessonSelectVariantsNoModule) {
          const result = await buildLessonsQuery(selectFields);
          if (!result.error) return result;
          lastError = result.error;
          // eslint-disable-next-line no-console
          console.warn('[course-content-lessons-select-failed-no-module]', {
            selectFields,
            message: result.error.message,
          });
        }

        throw Object.assign(new Error('FAILED_TO_FETCH_LESSONS'), { status: 500, details: lastError });
      };

      const lessonsResult = await fetchLessonsWithFallbacks();
      const lessons = (lessonsResult.data || []).map((lesson) => {
        if (!lesson || typeof lesson !== 'object') return lesson;
        const moduleId = lesson.module_id ?? lesson.course_module_id ?? null;
        if (moduleId == null) return lesson;
        if (lesson.module_id != null) return lesson;
        return { ...lesson, module_id: moduleId };
      });

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
        lessons,
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
