import { Router } from 'express';
import supabaseAnon from '../lib/supabaseAnon.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import env from '../config/env.js';
import { sendApiError } from '../lib/publicErrors.js';
import { getOptionalUser } from '../lib/optionalUser.js';

const router = Router();

const LESSONS_CACHE_TTL_MS = 5000;
const lessonsCache = new Map(); // key -> { expiresAt, data }
const lessonsInFlight = new Map(); // key -> Promise<unknown[]>

const COURSES_CACHE_TTL_MS = 5000;
const coursesCache = new Map();
const coursesInFlight = new Map(); // key -> Promise<unknown[]>

const parseEq = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.startsWith('eq.') ? value.slice(3) : value;
};

const normalizeParam = (value) => String(value || '').trim();

const isPermissionError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42501' || /permission denied|not authorized|JWT/i.test(message);
};

const isTimeoutError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return /aborted|timeout/i.test(message);
};

router.get('/courses', async (req, res, next) => {
  try {
    const { status, slug, access } = req.query || {};

    const selectFields =
      'id,slug,title,description,cover_url,access,status,labels,sort_order,price,sale_price,currency,llm_limit';

    const normalizedStatus = status ? normalizeParam(parseEq(status)) : '';
    const normalizedSlug = slug ? normalizeParam(parseEq(slug)) : '';
    const normalizedAccess = access ? normalizeParam(parseEq(access)) : '';
    const optionalUser = await getOptionalUser(req);
    const userKey = optionalUser?.id ? `u:${optionalUser.id}` : 'anon';
    const cacheKey = `${userKey}|${normalizedStatus}|${normalizedSlug}|${normalizedAccess}`;

    const cached = coursesCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return res.json(cached.data);
      }
      coursesCache.delete(cacheKey);
    }

    const inflight = coursesInFlight.get(cacheKey);
    if (inflight) {
      const data = await inflight;
      return res.json(data);
    }

    const buildQuery = () => {
      let query = supabaseAnon.from('courses').select(selectFields).order('sort_order', { ascending: true });

      if (status) {
        query = query.eq('status', parseEq(status));
      }

      if (slug) {
        query = query.eq('slug', parseEq(slug));
      }

      if (access) {
        query = query.eq('access', parseEq(access));
      }

      return query;
    };

    const startedAt = Date.now();
    const promise = (async () => {
      const result = await buildQuery();
      if (result.error) {
        const statusCode = isPermissionError(result.error) ? 403 : (isTimeoutError(result.error) ? 504 : 500);
        const code = isPermissionError(result.error)
          ? 'FORBIDDEN'
          : (isTimeoutError(result.error) ? 'DATABASE_TIMEOUT' : 'FAILED_TO_FETCH_COURSES');
        throw Object.assign(new Error(code), { status: statusCode, details: result.error });
      }

      const courses = result.data || [];

      if (!optionalUser?.id) return courses;

      // Personalize pricing: if course is purchased/granted for this user, return price=0
      // and mark it so frontend can open the course without extra calls.
      let purchasedIds = new Set();
      try {
        const { data: userCourses, error: userCoursesError } = await supabaseAdmin
          .from('user_courses')
          .select('course_id,status,granted_at')
          .eq('user_id', optionalUser.id);

        if (!userCoursesError && Array.isArray(userCourses)) {
          purchasedIds = new Set(
            userCourses
              .filter((row) => Boolean(row?.granted_at) || ['active', 'granted', 'paid', 'confirmed'].includes(String(row?.status || '').toLowerCase()))
              .map((row) => row.course_id)
              .filter(Boolean),
          );
        }
      } catch (e) {
        // ignore personalization failures; return public list
        return courses;
      }

      if (purchasedIds.size === 0) return courses;

      return courses.map((course) => {
        if (!course?.id || !purchasedIds.has(course.id)) return course;
        return {
          ...course,
          is_purchased: true,
          price: 0,
          sale_price: 0,
        };
      });
    })();

    coursesInFlight.set(cacheKey, promise);

    try {
      const data = await promise;
      coursesCache.set(cacheKey, { expiresAt: Date.now() + COURSES_CACHE_TTL_MS, data });

      const elapsed = Date.now() - startedAt;
      if (elapsed >= env.slowLogMs) {
        // eslint-disable-next-line no-console
        console.warn('[slow-courses]', {
          status: normalizedStatus || null,
          slug: normalizedSlug || null,
          access: normalizedAccess || null,
          ms: elapsed,
        });
      }

      return res.json(data);
    } catch (err) {
      const code = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'FAILED_TO_FETCH_COURSES';
      const statusCode = err && typeof err === 'object' && 'status' in err ? Number(err.status) : 500;
      // eslint-disable-next-line no-console
      console.error('[courses-error]', { status: statusCode, error: code });
      return sendApiError(
        res,
        Number.isFinite(statusCode) ? statusCode : 500,
        code === 'FORBIDDEN' || code === 'DATABASE_TIMEOUT' || code === 'FAILED_TO_FETCH_COURSES'
          ? code
          : 'FAILED_TO_FETCH_COURSES',
        { details: err && typeof err === 'object' && 'details' in err ? err.details : undefined },
      );
    } finally {
      coursesInFlight.delete(cacheKey);
    }
  } catch (error) {
    return next(error);
  }
});

router.get('/lessons', async (req, res, next) => {
  try {
    const { course_id: courseId, slug, lesson_type: lessonType } = req.query || {};

    // Lessons list is meta-only; content is served by `GET /api/lessons/:lessonId/content`.
    const selectFields =
      'id,course_id,module_id,slug,title,lesson_type,lesson_type_ru,sort_order';

    const buildQuery = () => {
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

      return query;
    };

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
      const result = await buildQuery();
      if (result.error) {
        throw Object.assign(new Error('FAILED_TO_FETCH_LESSONS'), { status: 500, details: result.error });
      }

      return result.data || [];
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
