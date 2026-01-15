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
const coursesCache = new Map(); // key -> { expiresAt, data }
const coursesInFlight = new Map(); // key -> Promise<unknown[]>

const parseEq = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.startsWith('eq.') ? value.slice(3) : value;
};

const normalizeParam = (value) => String(value || '').trim();

const isMissingColumnError = (error, columnName) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const normalizedColumn = String(columnName || '').trim();
  if (!normalizedColumn) return false;
  const escapedColumn = normalizedColumn.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&');
  const hasQualifiedColumn = new RegExp(`\\b\\w+\\.${escapedColumn}\\b`, 'i').test(message);
  const hasRawColumn = new RegExp(`\\b${escapedColumn}\\b`, 'i').test(message);
  const mentionsColumn =
    message.includes(`column "${columnName}"`) ||
    message.includes(`column '${columnName}'`) ||
    message.includes(`column ${columnName}`) ||
    hasQualifiedColumn ||
    hasRawColumn;
  return (
    mentionsColumn && /does not exist|schema cache|could not find|not found/i.test(message)
  );
};

const isPermissionError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42501' || /permission denied|not authorized|JWT/i.test(message);
};

const isTimeoutError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return /aborted|timeout/i.test(message);
};

const isTransientSupabaseError = (error) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : null;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

  if (status && [500, 502, 503, 504].includes(status)) return true;
  if (/schema cache|connection|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message)) return true;
  if (/PGRST/i.test(code)) return true;
  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

router.get('/courses', async (req, res, next) => {
  try {
    const { status, slug, access } = req.query || {};

    const primarySelect =
      'id,slug,title,description,cover_url,access,status,label,labels,sort_order,price,sale_price,currency';
    const noLabelsSelect =
      'id,slug,title,description,cover_url,access,status,label,sort_order,price,sale_price,currency';
    const noLabelSelect =
      'id,slug,title,description,cover_url,access,status,labels,sort_order,price,sale_price,currency';
    const fallbackSelect =
      'id,slug,title,description,cover_url,access,status,sort_order,price,sale_price,currency';
    const minimalSelect =
      'id,slug,title,description,cover_url,access,status,price';

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

    const buildQuery = (selectFields, opts = {}) => {
      let query = supabaseAnon
        .from('courses')
        .select(selectFields)
        .order(opts.orderBy || 'sort_order', { ascending: true });

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
    const meta = { stage: 'primary', enriched: false, enrichError: null };
    const promise = (async () => {
      // 1) Try full select ordered by sort_order
      let result = await buildQuery(primarySelect);
      if (result.error && isTransientSupabaseError(result.error)) {
        await sleep(150);
        result = await buildQuery(primarySelect);
      }

      // If sort_order doesn't exist, retry with stable order (title)
      if (result.error && isMissingColumnError(result.error, 'sort_order')) {
        meta.stage = 'order-fallback';
        // eslint-disable-next-line no-console
        console.warn('[courses-order-fallback]', { message: result.error.message });
        result = await buildQuery(primarySelect, { orderBy: 'title' });
      }
      if (result.error && isTransientSupabaseError(result.error)) {
        await sleep(150);
        result = await buildQuery(primarySelect, { orderBy: 'title' });
      }

      // Back-compat: if legacy `label` column doesn't exist, drop it first
      if (result.error && isMissingColumnError(result.error, 'label')) {
        meta.stage = 'drop-label';
        // eslint-disable-next-line no-console
        console.warn('[courses-select-fallback]', { stage: 'drop-label', message: result.error.message });
        result = await buildQuery(noLabelSelect);
        if (result.error && isTransientSupabaseError(result.error)) {
          await sleep(150);
          result = await buildQuery(noLabelSelect);
        }

        if (result.error && isMissingColumnError(result.error, 'sort_order')) {
          meta.stage = 'drop-label-order-fallback';
          // eslint-disable-next-line no-console
          console.warn('[courses-order-fallback]', { stage: 'drop-label', message: result.error.message });
          result = await buildQuery(noLabelSelect, { orderBy: 'title' });
          if (result.error && isTransientSupabaseError(result.error)) {
            await sleep(150);
            result = await buildQuery(noLabelSelect, { orderBy: 'title' });
          }
        }
      }

      // Back-compat: if `labels` column doesn't exist, keep `label`.
      if (result.error && isMissingColumnError(result.error, 'labels')) {
        meta.stage = 'drop-labels';
        // eslint-disable-next-line no-console
        console.warn('[courses-select-fallback]', { stage: 'drop-labels', message: result.error.message });
        result = await buildQuery(noLabelsSelect);
        if (result.error && isTransientSupabaseError(result.error)) {
          await sleep(150);
          result = await buildQuery(noLabelsSelect);
        }

        if (result.error && isMissingColumnError(result.error, 'sort_order')) {
          meta.stage = 'drop-labels-order-fallback';
          // eslint-disable-next-line no-console
          console.warn('[courses-order-fallback]', { stage: 'drop-labels', message: result.error.message });
          result = await buildQuery(noLabelsSelect, { orderBy: 'title' });
          if (result.error && isTransientSupabaseError(result.error)) {
            await sleep(150);
            result = await buildQuery(noLabelsSelect, { orderBy: 'title' });
          }
        }
      }

      // If optional columns still don't exist, retry with smaller selects.
      if (result.error) {
        meta.stage = 'fallback';
        // eslint-disable-next-line no-console
        console.warn('[courses-select-fallback]', { stage: 'fallback', message: result.error.message });
        result = await buildQuery(fallbackSelect);
      }
      if (result.error && isTransientSupabaseError(result.error)) {
        await sleep(150);
        result = await buildQuery(fallbackSelect);
      }

      if (result.error && isMissingColumnError(result.error, 'sort_order')) {
        meta.stage = 'fallback-order-fallback';
        // eslint-disable-next-line no-console
        console.warn('[courses-order-fallback]', { stage: 'fallback', message: result.error.message });
        result = await buildQuery(fallbackSelect, { orderBy: 'title' });
      }
      if (result.error && isTransientSupabaseError(result.error)) {
        await sleep(150);
        result = await buildQuery(fallbackSelect, { orderBy: 'title' });
      }

      if (result.error) {
        meta.stage = 'minimal';
        // eslint-disable-next-line no-console
        console.warn('[courses-select-fallback-min]', { message: result.error.message });
        result = await buildQuery(minimalSelect, { orderBy: 'title' });
      }
      if (result.error && isTransientSupabaseError(result.error)) {
        await sleep(150);
        result = await buildQuery(minimalSelect, { orderBy: 'title' });
      }

      if (result.error) {
        const statusCode = isPermissionError(result.error) ? 403 : (isTimeoutError(result.error) ? 504 : 500);
        const code = isPermissionError(result.error)
          ? 'FORBIDDEN'
          : (isTimeoutError(result.error) ? 'DATABASE_TIMEOUT' : 'FAILED_TO_FETCH_COURSES');
        throw Object.assign(new Error(code), { status: statusCode, details: result.error });
      }

      const courses = result.data || [];

      // If we ended up on a fallback select that didn't include labels, best-effort enrich them.
      // This avoids cases where optional columns (currency/sale_price/etc) exist inconsistently across deployments
      // and we had to use a reduced select.
      if (Array.isArray(courses) && courses.length > 0) {
        const someMissingLabels = courses.some(
          (course) =>
            course &&
            typeof course === 'object' &&
            (!('labels' in course) || !('label' in course)),
        );
        if (someMissingLabels) {
          const ids = courses.map((course) => course?.id).filter(Boolean);
          if (ids.length > 0) {
            const fetchLabels = async (selectFields) => {
              // Use service role for enrichment to avoid column-level/RLS surprises on anon.
              return supabaseAdmin.from('courses').select(selectFields).in('id', ids);
            };

            let labelsResult = await fetchLabels('id,labels,label');
            if (labelsResult.error && isMissingColumnError(labelsResult.error, 'label')) {
              labelsResult = await fetchLabels('id,labels');
            }
            if (labelsResult.error && isMissingColumnError(labelsResult.error, 'labels')) {
              labelsResult = await fetchLabels('id,label');
            }

            if (!labelsResult.error && Array.isArray(labelsResult.data)) {
              const labelById = new Map(labelsResult.data.map((row) => [row?.id, row]));
              for (const course of courses) {
                const extra = course?.id ? labelById.get(course.id) : null;
                if (!extra) continue;
                if (!('labels' in course) && 'labels' in extra) course.labels = extra.labels;
                if (!('label' in course) && 'label' in extra) course.label = extra.label;
              }
              meta.enriched = true;
              // eslint-disable-next-line no-console
              console.warn('[courses-labels-enriched]', { count: ids.length });
            } else if (labelsResult.error) {
              meta.enrichError = labelsResult.error.message;
              // eslint-disable-next-line no-console
              console.warn('[courses-labels-enrich-failed]', { message: labelsResult.error.message });
            }
          }
        }
      }

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
        } else {
          // Fallback to legacy purchases table if needed.
          const { data: purchases, error: purchasesError } = await supabaseAdmin
            .from('course_purchases')
            .select('course_id,status,paid_at')
            .eq('user_id', optionalUser.id);
          if (!purchasesError && Array.isArray(purchases)) {
            purchasedIds = new Set(
              purchases
                .filter((row) => Boolean(row?.paid_at) || ['paid', 'succeeded', 'success', 'completed', 'captured', 'confirmed'].includes(String(row?.status || '').toLowerCase()))
                .map((row) => row.course_id)
                .filter(Boolean),
            );
          }
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
      res.set('x-courses-stage', String(meta.stage));
      res.set('x-courses-enriched', meta.enriched ? '1' : '0');
      if (meta.enrichError) {
        res.set('x-courses-enrich-error', String(meta.enrichError).slice(0, 200));
      }

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

    // Use selective fields to avoid fetching heavy LLM prompts for the whole list.
    // We include 'blocks' as they are required for rendering the lesson content.
    const selectPrimary =
      'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,unlock_rule,settings,mode,settings_mode';
    const selectFallback =
      'id,course_id,slug,title,lesson_type,sort_order,lesson_type_ru,blocks,settings';

    const buildQuery = (selectFields) => {
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

    let query = buildQuery(selectPrimary);

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
      let result = await query;
      if (result.error) {
        // Back-compat: some deployments may not have optional fields yet.
        // eslint-disable-next-line no-console
        console.warn('[lessons-select-fallback]', { message: result.error.message });
        result = await buildQuery(selectFallback);
      }

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
