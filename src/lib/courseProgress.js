import supabaseAdmin from './supabaseAdmin.js';

export const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
export const ACTIVE_JOB_TTL_MS = 5 * 60 * 1000;

const normalizeActiveJob = (activeJob) => {
  if (!activeJob || typeof activeJob !== 'object' || Array.isArray(activeJob)) {
    return null;
  }

  const jobId = activeJob.jobId || activeJob.job_id || activeJob.id || null;
  const lessonId = activeJob.lessonId || activeJob.lesson_id || null;
  const courseId = activeJob.courseId || activeJob.course_id || null;
  const status = activeJob.status || activeJob.state || null;
  const error =
    typeof activeJob.error === 'string'
      ? activeJob.error
      : (typeof activeJob.code === 'string' ? activeJob.code : null);
  const errorDetails =
    typeof activeJob.error_details === 'string'
      ? activeJob.error_details
      : (typeof activeJob.details === 'string' ? activeJob.details : null);
  const lastUpdatedByLessonId =
    activeJob.lastUpdatedByLessonId || activeJob.last_updated_by_lesson_id || null;

  return {
    jobId,
    lessonId,
    courseId,
    status,
    prompt: typeof activeJob.prompt === 'string' ? activeJob.prompt : null,
    startedAt: activeJob.startedAt || activeJob.started_at || null,
    updatedAt: activeJob.updatedAt || activeJob.updated_at || activeJob.heartbeat_at || null,
    lastEventId: activeJob.lastEventId || activeJob.last_event_id || null,
    error,
    error_details: errorDetails,
    last_updated_by_lesson_id: lastUpdatedByLessonId,
  };
};

export const normalizeProgress = (progress) => {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return { lessons: {}, result: { html: null, meta: {} }, active_job: null };
  }

  const resultRaw =
    progress.result && typeof progress.result === 'object' && !Array.isArray(progress.result)
      ? progress.result
      : null;

  const normalizeFiles = (files) => {
    if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
    const next = {};
    Object.entries(files).forEach(([name, content]) => {
      if (typeof name !== 'string' || !name.trim()) return;
      next[name] = typeof content === 'string' ? content : String(content ?? '');
    });
    return next;
  };

  const normalizedResult = progress.result && typeof progress.result === 'object' && !Array.isArray(progress.result)
    ? {
        html: resultRaw?.html ?? null,
        files: normalizeFiles(resultRaw?.files) ?? undefined,
        active_file:
          typeof resultRaw?.active_file === 'string'
            ? resultRaw.active_file
            : (typeof resultRaw?.activeFile === 'string' ? resultRaw.activeFile : undefined),
        meta: resultRaw?.meta && typeof resultRaw.meta === 'object' && !Array.isArray(resultRaw.meta)
          ? { ...resultRaw.meta }
          : {},
      }
    : { html: null, meta: {} };

  return {
    ...progress,
    lessons:
      progress.lessons && typeof progress.lessons === 'object' && !Array.isArray(progress.lessons)
        ? { ...progress.lessons }
        : {},
    active_job: normalizeActiveJob(progress.active_job),
    result: normalizedResult,
  };
};

export const isActiveJobRunning = (job) => !!job && ACTIVE_JOB_STATUSES.has(job.status);

export const loadCourseProgress = async (userId, courseId) => {
  const { data, error } = await supabaseAdmin
    .from('user_course_progress')
    .select('progress, updated_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .maybeSingle();

  if (error) {
    const err = new Error('FAILED_TO_FETCH_PROGRESS');
    err.details = error.message;
    throw err;
  }

  return {
    progress: normalizeProgress(data?.progress),
    updatedAt: data?.updated_at || null,
  };
};

export const saveCourseProgress = async (userId, courseId, progress) => {
  const payload = {
    user_id: userId,
    course_id: courseId,
    progress,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('user_course_progress')
    .upsert([payload], { onConflict: 'user_id,course_id' })
    .select('progress, updated_at')
    .single();

  if (error) {
    const err = new Error('FAILED_TO_SAVE_PROGRESS');
    err.details = error.message;
    throw err;
  }

  return {
    progress: normalizeProgress(data?.progress || progress || {}),
    updatedAt: data?.updated_at || payload.updated_at,
  };
};

export const mutateCourseProgress = async (userId, courseId, mutator) => {
  const { progress: current, updatedAt } = await loadCourseProgress(userId, courseId);
  const draft = normalizeProgress({ ...current });
  const next = await mutator(draft);

  if (!next) {
    return { progress: current, updatedAt };
  }

  return saveCourseProgress(userId, courseId, next);
};
