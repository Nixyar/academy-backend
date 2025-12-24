import { Router } from 'express';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import requireUser from '../middleware/requireUser.js';

const router = Router();

const normalizeProgress = (progress) => {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return { lessons: {} };
  }

  return {
    ...progress,
    lessons: progress.lessons && typeof progress.lessons === 'object' && !Array.isArray(progress.lessons)
      ? { ...progress.lessons }
      : {},
  };
};

const loadCourseProgress = async (userId, courseId) => {
  const { data, error } = await supabaseAdmin
    .from('user_course_progress')
    .select('progress')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .maybeSingle();

  if (error) {
    throw new Error('FAILED_TO_FETCH_PROGRESS');
  }

  return normalizeProgress(data?.progress);
};

const saveCourseProgress = async (userId, courseId, progress) => {
  const payload = {
    user_id: userId,
    course_id: courseId,
    progress,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('user_course_progress')
    .upsert([payload], { onConflict: 'user_id,course_id' })
    .select('course_id, progress')
    .single();

  if (error) {
    throw new Error('FAILED_TO_SAVE_PROGRESS');
  }

  return normalizeProgress(data?.progress || progress || {});
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

  return { error: 'UNKNOWN_PATCH_OP', details: `Unsupported op "${op}"` };
};

router.get('/courses/:courseId/progress', requireUser, async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const { user } = req;

    const progress = await loadCourseProgress(user.id, courseId);

    return res.json({
      course_id: courseId,
      progress,
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
    const { courseId } = req.params;
    const { user } = req;
    const bodyProgress = req.body?.progress ?? req.body;

    if (!bodyProgress || typeof bodyProgress !== 'object' || Array.isArray(bodyProgress)) {
      return res.status(400).json({ error: 'INVALID_PROGRESS', details: 'progress must be an object' });
    }

    const normalized = normalizeProgress(bodyProgress);
    const saved = await saveCourseProgress(user.id, courseId, normalized);

    return res.json({
      course_id: courseId,
      progress: saved,
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
    const { courseId } = req.params;
    const { user } = req;
    const patch = req.body || {};

    const current = await loadCourseProgress(user.id, courseId);
    const result = applyPatch(current, patch);

    if (result.error) {
      return res.status(400).json({ error: result.error, details: result.details });
    }

    const saved = await saveCourseProgress(user.id, courseId, result.progress);

    return res.json({
      course_id: courseId,
      progress: saved,
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
    const { courseId } = req.params;
    const { user } = req;

    const progress = await loadCourseProgress(user.id, courseId);
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

    const { data, error } = await supabaseAdmin
      .from('user_course_progress')
      .select('course_id, progress')
      .eq('user_id', user.id)
      .in('course_id', courseIds);

    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_PROGRESS' });
    }

    const progressMap = {};

    courseIds.forEach((courseId) => {
      progressMap[courseId] = {};
    });

    (data || []).forEach((row) => {
      progressMap[row.course_id] = normalizeProgress(row.progress);
    });

    return res.json({ progress: progressMap });
  } catch (error) {
    return next(error);
  }
});

export default router;
