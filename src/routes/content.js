import { Router } from 'express';
import supabaseAnon from '../lib/supabaseAnon.js';
import env from '../config/env.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const LESSONS_CACHE_TTL_MS = 5000;
const lessonsCache = new Map(); // key -> { expiresAt, data }
const lessonsInFlight = new Map(); // key -> Promise<unknown[]>

const parseEq = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.startsWith('eq.') ? value.slice(3) : value;
};

const normalizeParam = (value) => String(value || '').trim();

router.get('/courses', async (req, res, next) => {
  try {
    const { status, slug, access } = req.query || {};

    let query = supabaseAnon
      .from('courses')
      .select('id,slug,title,description,cover_url,access,status,label,labels,sort_order,price,sale_price,currency')
      .order('sort_order', { ascending: true });

    if (status) {
      query = query.eq('status', parseEq(status));
    }

    if (slug) {
      query = query.eq('slug', parseEq(slug));
    }

    if (access) {
      query = query.eq('access', parseEq(access));
    }

    const { data, error } = await query;

    if (error) {
      return sendApiError(res, 500, 'FAILED_TO_FETCH_COURSES', { details: error });
    }

    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

router.get('/lessons', async (req, res, next) => {
  try {
    const { course_id: courseId, slug, lesson_type: lessonType } = req.query || {};

    // Use selective fields to avoid fetching heavy LLM prompts for the whole list.
    // We include 'blocks' as they are required for rendering the lesson content.
    const selectFields =
      'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode';
    let query = supabaseAnon.from('lessons').select(selectFields).order('sort_order', { ascending: true });

    if (courseId) {
      query = query.eq('course_id', parseEq(courseId));
    }

    if (slug) {
      query = query.eq('slug', parseEq(slug));
    }

    if (lessonType) {
      query = query.eq('lesson_type', parseEq(lessonType));
    }

    const normalizedCourseId = courseId ? normalizeParam(parseEq(courseId)) : '';
    const normalizedSlug = slug ? normalizeParam(parseEq(slug)) : '';
    const normalizedLessonType = lessonType ? normalizeParam(parseEq(lessonType)) : '';
    const cacheKey = `${normalizedCourseId}|${normalizedSlug}|${normalizedLessonType}`;

    const cached = lessonsCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return res.json(cached.data);
      }
      lessonsCache.delete(cacheKey);
    }

    const inflight = lessonsInFlight.get(cacheKey);
    if (inflight) {
      const data = await inflight;
      return res.json(data);
    }

    const startedAt = Date.now();
    const promise = (async () => {
      // supabaseAnon already handles timeouts via fetch decoration
      const { data, error } = await query;
      if (error) {
        throw Object.assign(new Error('FAILED_TO_FETCH_LESSONS'), { status: 500, details: error });
      }
      return data || [];
    })();

    lessonsInFlight.set(cacheKey, promise);

    try {
      const data = await promise;
      lessonsCache.set(cacheKey, { expiresAt: Date.now() + LESSONS_CACHE_TTL_MS, data });

      const elapsed = Date.now() - startedAt;
      if (elapsed >= env.slowLogMs) {
        // eslint-disable-next-line no-console
        console.warn('[slow-lessons]', {
          courseId: normalizedCourseId || null,
          slug: normalizedSlug || null,
          lessonType: normalizedLessonType || null,
          ms: elapsed,
        });
      }

      return res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timeout') || message.includes('aborted');
      const status = typeof (err && typeof err === 'object' && 'status' in err ? err.status : null) === 'number'
        ? err.status
        : (isTimeout ? 504 : 500);

      // eslint-disable-next-line no-console
      console.error('[lessons-error]', { status, error: message });
      return sendApiError(
        res,
        status,
        isTimeout ? 'DATABASE_TIMEOUT' : (message === 'FAILED_TO_FETCH_LESSONS' ? 'FAILED_TO_FETCH_LESSONS' : 'DATABASE_ERROR'),
        { details: err && typeof err === 'object' && 'details' in err ? err.details : undefined },
      );
    } finally {
      lessonsInFlight.delete(cacheKey);
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
