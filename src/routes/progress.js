import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import {
  ACTIVE_JOB_TTL_MS,
  isActiveJobRunning,
  loadCourseProgress,
  mutateCourseProgress,
  normalizeProgress,
  saveCourseProgress,
} from '../lib/courseProgress.js';
import { ensureWorkspace } from '../lib/htmlWorkspace.js';
import requireUser from '../middleware/requireUser.js';

const router = Router();

const PROGRESS_LIST_CACHE_TTL_MS = 5000;
const progressListCache = new Map(); // key -> { expiresAt, value }
const inFlightProgressList = new Map(); // key -> Promise (deduplication)

const stripLessonHeavyFields = (lesson) => {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) return lesson;
  const { result, result_html, ...rest } = lesson;
  return rest;
};

// `/api/progress` is used for listing; avoid returning heavy workspace HTML/files.
const stripProgressForList = (progress) => {
  const normalized = normalizeProgress(progress);
  const next = { ...normalized };

  if (next.result && typeof next.result === 'object' && !Array.isArray(next.result)) {
    const meta =
      next.result.meta && typeof next.result.meta === 'object' && !Array.isArray(next.result.meta)
        ? next.result.meta
        : {};
    const active_file =
      typeof next.result.active_file === 'string' && next.result.active_file.trim()
        ? next.result.active_file
        : undefined;

    next.result = {
      meta,
      ...(active_file ? { active_file } : {}),
    };
  }

  // Legacy heavy fields
  if ('result_html' in next) delete next.result_html;

  const lessonsRaw = next.lessons && typeof next.lessons === 'object' && !Array.isArray(next.lessons)
    ? next.lessons
    : {};
  const strippedLessons = {};
  Object.entries(lessonsRaw).forEach(([lessonId, value]) => {
    strippedLessons[lessonId] = stripLessonHeavyFields(value);
  });
  next.lessons = strippedLessons;

  return next;
};

const getHeartbeatMs = (activeJob, fallbackUpdatedAt) => {
  const raw = activeJob?.updatedAt || activeJob?.startedAt || fallbackUpdatedAt;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

const ensureLessonNode = (progress, lessonId) => {
  const nextLessons = { ...(progress.lessons || {}) };
  const current = nextLessons[lessonId] || {};

  nextLessons[lessonId] = {
    ...current,
    quiz_answers: { ...(current.quiz_answers || {}) },
  };

  return nextLessons;
};

const applyPatch = (progress, patch) => {
  const next = normalizeProgress(progress);
  const op = patch?.op;

  if (!op) {
    return { error: 'INVALID_PATCH', details: 'op is required' };
  }

  if (op === 'quiz_answer') {
    const { lessonId, quizId, answer } = patch;

    if (!lessonId || !quizId || typeof answer !== 'string') {
      return { error: 'INVALID_PATCH', details: 'lessonId, quizId and answer are required for quiz_answer' };
    }

    const lessons = ensureLessonNode(next, lessonId);
    const lesson = lessons[lessonId];
    lesson.quiz_answers[quizId] = answer;
    lesson.status = lesson.status || 'in_progress';
    lesson.last_viewed_at = new Date().toISOString();

    return {
      progress: {
        ...next,
        lessons,
        last_viewed_lesson_id: lessonId,
      },
    };
  }

  if (op === 'lesson_status') {
    const { lessonId, status } = patch;
    const allowedStatuses = ['in_progress', 'completed'];

    if (!lessonId || !allowedStatuses.includes(status)) {
      return { error: 'INVALID_PATCH', details: 'lesson_status requires lessonId and status (in_progress|completed)' };
    }

    const lessons = ensureLessonNode(next, lessonId);
    lessons[lessonId] = {
      ...lessons[lessonId],
      status,
      completed_at: status === 'completed'
        ? (patch.completedAt || new Date().toISOString())
        : lessons[lessonId].completed_at,
      last_viewed_at: new Date().toISOString(),
    };

    return {
      progress: {
        ...next,
        lessons,
        last_viewed_lesson_id: lessonId,
      },
    };
  }

  if (op === 'set_resume') {
    const { lessonId } = patch;

    if (!lessonId) {
      return { error: 'INVALID_PATCH', details: 'set_resume requires lessonId' };
    }

    return {
      progress: {
        ...next,
        resume_lesson_id: lessonId,
        last_viewed_lesson_id: lessonId,
      },
    };
  }

  if (op === 'touch_lesson') {
    const { lessonId } = patch;

    if (!lessonId) {
      return { error: 'INVALID_PATCH', details: 'touch_lesson requires lessonId' };
    }

    const lessons = ensureLessonNode(next, lessonId);
    lessons[lessonId] = {
      ...lessons[lessonId],
      last_viewed_at: new Date().toISOString(),
    };

    return {
      progress: {
        ...next,
        lessons,
        last_viewed_lesson_id: lessonId,
      },
    };
  }

  if (op === 'finish_course') {
    const { lessonId } = patch;

    if (typeof lessonId !== 'string' || !lessonId.trim()) {
      return { error: 'INVALID_PATCH', details: 'finish_course requires lessonId' };
    }

    const now = patch.completedAt || new Date().toISOString();
    const resolvedLessonId = lessonId.trim();
    const lessons = ensureLessonNode(next, resolvedLessonId);

    // When the course is finished, there should be no remaining "in_progress" lessons.
    Object.entries(lessons).forEach(([id, lesson]) => {
      if (!lesson || typeof lesson !== 'object') return;
      if (lesson.status !== 'in_progress') return;
      lessons[id] = {
        ...lesson,
        status: 'completed',
        completed_at: lesson.completed_at || now,
        last_viewed_at: lesson.last_viewed_at || new Date().toISOString(),
      };
    });

    lessons[resolvedLessonId] = {
      ...lessons[resolvedLessonId],
      status: 'completed',
      completed_at: now,
      last_viewed_at: new Date().toISOString(),
    };

    return {
      progress: {
        ...next,
        lessons,
        course_status: 'completed',
        course_completed_at: now,
        resume_lesson_id: resolvedLessonId,
        last_viewed_lesson_id: resolvedLessonId,
      },
    };
  }

  return { error: 'UNKNOWN_PATCH_OP', details: `Unsupported op "${op}"` };
};

router.get('/courses/:courseId/progress', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;
    const onlyStatus = req.query?.onlyStatus === 'true';

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    // Optimization: if client asks for only status, or by default for status checks, use partial fetch
    let { progress, updatedAt } = await loadCourseProgress(user.id, courseId, { onlyStatus });

    const activeJob = progress.active_job;
    const lastHeartbeat = getHeartbeatMs(activeJob, updatedAt);
    const isStale =
      isActiveJobRunning(activeJob) &&
      (!lastHeartbeat || Date.now() - lastHeartbeat > ACTIVE_JOB_TTL_MS);

    if (isStale) {
      const failed = await mutateCourseProgress(user.id, courseId, (draft) => {
        if (!draft.active_job || draft.active_job.jobId !== activeJob.jobId) return null;
        return {
          ...draft,
          active_job: {
            ...draft.active_job,
            status: 'failed',
            updatedAt: new Date().toISOString(),
            error: 'STALE_HEARTBEAT',
          },
        };
      }, { onlyStatus: true });
      progress = failed.progress;
      updatedAt = failed.updatedAt;
    }

    return res.json({
      courseId,
      progress: onlyStatus ? { active_job: progress.active_job } : progress,
      updatedAt,
    });
  } catch (error) {
    if (error.message === 'FAILED_TO_FETCH_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_PROGRESS' });
    }

    return next(error);
  }
});

router.put('/courses/:courseId/progress', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;
    const bodyProgress = req.body?.progress ?? req.body;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    if (!bodyProgress || typeof bodyProgress !== 'object' || Array.isArray(bodyProgress)) {
      return res.status(400).json({ error: 'INVALID_PROGRESS', details: 'progress must be an object' });
    }

    const normalized = normalizeProgress(bodyProgress);
    const { progress: saved, updatedAt } = await saveCourseProgress(user.id, courseId, normalized);

    return res.json({
      courseId,
      progress: saved,
      updatedAt,
    });
  } catch (error) {
    if (error.message === 'FAILED_TO_SAVE_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_SAVE_PROGRESS' });
    }

    return next(error);
  }
});

router.patch('/courses/:courseId/progress', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;
    const patch = req.body || {};
    const op = patch?.op;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    if (!op) {
      return res.status(400).json({ error: 'INVALID_PATCH', details: 'op is required' });
    }

    if (op === 'lesson_prompt') {
      const { lessonId, prompt } = patch;

      if (typeof lessonId !== 'string' || !lessonId.trim() || typeof prompt !== 'string' || !prompt.trim()) {
        return res
          .status(400)
          .json({ error: 'INVALID_PATCH', details: 'lesson_prompt requires lessonId and prompt' });
      }

      const { error: rpcError } = await supabaseAdmin.rpc('set_lesson_prompt', {
        p_user_id: user.id,
        p_course_id: courseId,
        p_lesson_id: lessonId,
        p_prompt: prompt.trim(),
      });

      if (rpcError) {
        return res
          .status(500)
          .json({ error: 'FAILED_TO_SAVE_LESSON_PROMPT', details: rpcError.message });
      }

      const { progress: saved, updatedAt } = await loadCourseProgress(user.id, courseId);

      return res.json({
        courseId,
        progress: saved,
        updatedAt,
      });
    }

    const { progress: current } = await loadCourseProgress(user.id, courseId);
    const result = applyPatch(current, patch);

    if (result.error) {
      return res.status(400).json({ error: result.error, details: result.details });
    }

    const { progress: saved, updatedAt } = await saveCourseProgress(user.id, courseId, result.progress);

    return res.json({
      courseId,
      progress: saved,
      updatedAt,
    });
  } catch (error) {
    if (error.message === 'FAILED_TO_FETCH_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_PROGRESS' });
    }

    if (error.message === 'FAILED_TO_SAVE_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_SAVE_PROGRESS' });
    }

    return next(error);
  }
});

router.get('/courses/:courseId/resume', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    const { progress } = await loadCourseProgress(user.id, courseId);
    const lessonsById = progress.lessons || {};

    const preferredResume = progress.resume_lesson_id
      || progress.last_viewed_lesson_id
      || progress.lastLessonId
      || progress.last_lesson_id
      || null;

    if (preferredResume) {
      return res.json({ lesson_id: preferredResume });
    }

    const { data: lessons, error } = await supabaseAdmin
      .from('lessons')
      .select('id')
      .eq('course_id', courseId)
      .order('sort_order', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_LESSONS' });
    }

    if (!lessons || lessons.length === 0) {
      return res.json({ lesson_id: null });
    }

    const completedIds = new Set(
      Object.entries(lessonsById)
        .filter(([, value]) => value?.status === 'completed')
        .map(([lessonId]) => lessonId),
    );

    const nextLesson = lessons.find((lesson) => !completedIds.has(lesson.id)) || lessons[0];

    return res.json({ lesson_id: nextLesson.id });
  } catch (error) {
    if (error.message === 'FAILED_TO_FETCH_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_PROGRESS' });
    }

    return next(error);
  }
});

router.patch('/v1/progress/active-file', requireUser, async (req, res, next) => {
  try {
    const { courseId, file } = req.body || {};
    const { user } = req;

    if (typeof courseId !== 'string' || !courseId.trim()) {
      return res.status(400).json({ error: 'courseId is required' });
    }
    if (typeof file !== 'string' || !file.trim()) {
      return res.status(400).json({ error: 'file is required' });
    }

    const { progress: current } = await loadCourseProgress(user.id, courseId.trim());
    const workspace = ensureWorkspace(current);

    const files = workspace.result?.files || {};
    if (!Object.prototype.hasOwnProperty.call(files, file)) {
      return res.status(400).json({ error: 'FILE_NOT_FOUND', details: `Unknown file "${file}"` });
    }

    const next = ensureWorkspace({
      ...workspace,
      result: {
        ...workspace.result,
        active_file: file,
        html: files[file] ?? workspace.result.html ?? null,
      },
    });

    const { progress: saved, updatedAt } = await saveCourseProgress(user.id, courseId.trim(), next);
    const savedWorkspace = ensureWorkspace(saved);

    return res.json({
      courseId,
      progress: savedWorkspace,
      result: {
        files: savedWorkspace.result.files,
        active_file: savedWorkspace.result.active_file,
        meta: savedWorkspace.result.meta,
      },
      updatedAt,
    });
  } catch (error) {
    if (error.message === 'FAILED_TO_FETCH_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_PROGRESS' });
    }

    if (error.message === 'FAILED_TO_SAVE_PROGRESS') {
      return res.status(500).json({ error: 'FAILED_TO_SAVE_PROGRESS' });
    }

    return next(error);
  }
});

router.get('/progress', requireUser, async (req, res, next) => {
  try {
    const courseIdsParam = req.query?.courseIds;
    const { user } = req;

    if (!courseIdsParam) {
      return res.status(400).json({ error: 'courseIds query param is required' });
    }

    const courseIds = String(courseIdsParam)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (courseIds.length === 0) {
      return res.status(400).json({ error: 'courseIds query param is required' });
    }

    const cacheKey = `${user.id}:${[...courseIds].sort().join(',')}`;

    // Check cache first
    const cached = progressListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.value);
    }

    // Check if there's already an in-flight request for same key
    const inFlight = inFlightProgressList.get(cacheKey);
    if (inFlight) {
      try {
        const result = await inFlight;
        return res.json(result);
      } catch (err) {
        // If in-flight failed, we'll try again below
      }
    }

    const startedAt = Date.now();

    // Create the promise and store it for deduplication
    const fetchPromise = (async () => {
      // Optimization: use Postgres JSONB operators to select only light metadata
      // This prevents fetching massive result.html / result.files for the whole list
      const { data, error } = await supabaseAdmin
        .from('user_course_progress')
        .select(`
          course_id, 
          progress->resume_lesson_id, 
          progress->last_viewed_lesson_id, 
          progress->active_job, 
          progress->lessons,
          progress->result->meta
        `)
        .eq('user_id', user.id)
        .in('course_id', courseIds);

      if (error) {
        const err = new Error('FAILED_TO_FETCH_PROGRESS');
        err.details = error;
        throw err;
      }

      const progressMap = {};
      courseIds.forEach((courseId) => {
        progressMap[courseId] = {};
      });

      (data || []).forEach((row) => {
        // Reconstruct a light progress object from partial fields
        const lightProgress = {
          resume_lesson_id: row.resume_lesson_id,
          last_viewed_lesson_id: row.last_viewed_lesson_id,
          active_job: row.active_job,
          lessons: row.lessons || {},
          result: {
            meta: row.meta || {},
          },
        };
        progressMap[row.course_id] = stripProgressForList(lightProgress);
      });

      return { progress: progressMap };
    })();

    inFlightProgressList.set(cacheKey, fetchPromise);

    try {
      const payload = await fetchPromise;

      // Cache the result
      progressListCache.set(cacheKey, {
        expiresAt: Date.now() + PROGRESS_LIST_CACHE_TTL_MS,
        value: payload,
      });

      const elapsed = Date.now() - startedAt;
      if (elapsed >= env.slowLogMs) {
        // eslint-disable-next-line no-console
        console.warn('[slow-progress-list]', { userId: user.id, courseCount: courseIds.length, ms: elapsed });
      }

      return res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timeout') || message.includes('aborted');

      // eslint-disable-next-line no-console
      console.error('[progress-list-error]', {
        userId: user.id,
        courseCount: courseIds.length,
        ms: Date.now() - startedAt,
        error: message,
      });

      return res.status(isTimeout ? 504 : 500).json({
        error: isTimeout ? 'DATABASE_TIMEOUT' : 'FAILED_TO_FETCH_PROGRESS',
        message,
        details: err.details || null,
      });
    } finally {
      // Clean up in-flight map
      if (inFlightProgressList.get(cacheKey) === fetchPromise) {
        inFlightProgressList.delete(cacheKey);
      }
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
