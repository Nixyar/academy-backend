import supabaseAdmin from './supabaseAdmin.js';

export const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
export const ACTIVE_JOB_TTL_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableSupabaseMessage = (message) => {
  const msg = String(message || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('terminated') ||
    msg.includes('fetch failed') ||
    msg.includes('networkerror') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('aborterror') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout')
  );
};

const toSupabaseErrorDetails = (error) => {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error !== 'object') return { message: String(error) };

  const details = {};
  if ('message' in error) details.message = String(error.message || '');
  if ('code' in error && error.code != null) details.code = String(error.code);
  if ('details' in error && error.details != null) details.details = String(error.details);
  if ('hint' in error && error.hint != null) details.hint = String(error.hint);

  return Object.keys(details).length ? details : { message: String(error) };
};

const normalizeActiveJob = (activeJob) => {
  if (!activeJob || typeof activeJob !== 'object' || Array.isArray(activeJob)) {
    return null;
  }

  const jobId = activeJob.jobId || activeJob.job_id || activeJob.id || null;
  const lessonId = activeJob.lessonId || activeJob.lesson_id || null;
  const courseId = activeJob.courseId || activeJob.course_id || null;
  const status = activeJob.status || activeJob.state || null;
  const statusMessage =
    typeof activeJob.status_message === 'string'
      ? activeJob.status_message
      : (typeof activeJob.statusMessage === 'string' ? activeJob.statusMessage : null);
  const progressValue =
    typeof activeJob.progress === 'number'
      ? activeJob.progress
      : (typeof activeJob.progress === 'string' && activeJob.progress.trim()
        ? Number(activeJob.progress)
        : null);
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

  const isFailed = status === 'failed';

  return {
    jobId,
    lessonId,
    courseId,
    status,
    status_message: statusMessage,
    progress: Number.isFinite(progressValue) ? progressValue : null,
    prompt: typeof activeJob.prompt === 'string' ? activeJob.prompt : null,
    startedAt: activeJob.startedAt || activeJob.started_at || null,
    updatedAt: activeJob.updatedAt || activeJob.updated_at || activeJob.heartbeat_at || null,
    lastEventId: activeJob.lastEventId || activeJob.last_event_id || null,
    error: isFailed ? error : null,
    error_details: isFailed ? errorDetails : null,
    last_updated_by_lesson_id: lastUpdatedByLessonId,
  };
};

export const normalizeProgress = (progress) => {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return { lessons: {}, result: { html: null, text: null, meta: {} }, active_job: null };
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
      text: resultRaw?.text ?? null,
      files: normalizeFiles(resultRaw?.files) ?? undefined,
      active_file:
        typeof resultRaw?.active_file === 'string'
          ? resultRaw.active_file
          : (typeof resultRaw?.activeFile === 'string' ? resultRaw.activeFile : undefined),
      meta: resultRaw?.meta && typeof resultRaw.meta === 'object' && !Array.isArray(resultRaw.meta)
        ? { ...resultRaw.meta }
        : {},
    }
    : { html: null, text: null, meta: {} };

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

export const loadCourseProgress = async (userId, courseId, opts = {}) => {
  let lastError;
  const selectFields = opts.onlyStatus
    ? 'progress->active_job, updated_at'
    : 'progress, updated_at';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const query = supabaseAdmin
      .from('user_course_progress')
      .select(selectFields)
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .maybeSingle();

    const { data, error } = await query;

    if (!error) {
      const rawProgress = data?.progress || (data?.active_job ? { active_job: data.active_job } : {});
      return {
        progress: normalizeProgress(rawProgress),
        updatedAt: data?.updated_at || null,
      };
    }

    lastError = error;
    if (attempt < 2 && isRetryableSupabaseMessage(error.message)) {
      // Exponential backoff with jitter
      await sleep(1000 * attempt + Math.floor(Math.random() * 500));
      continue;
    }
    break;
  }

  const err = new Error('FAILED_TO_FETCH_PROGRESS');
  err.status = 500;
  err.details = toSupabaseErrorDetails(lastError);
  throw err;
};

export const saveCourseProgress = async (userId, courseId, progress) => {
  const payload = {
    user_id: userId,
    course_id: courseId,
    progress,
    updated_at: new Date().toISOString(),
  };

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { data, error } = await supabaseAdmin
      .from('user_course_progress')
      .upsert([payload], { onConflict: 'user_id,course_id' })
      .select('progress, updated_at')
      .single();

    if (!error) {
      return {
        progress: normalizeProgress(data?.progress || progress || {}),
        updatedAt: data?.updated_at || payload.updated_at,
      };
    }

    lastError = error;
    if (attempt < 2 && isRetryableSupabaseMessage(error.message)) {
      await sleep(800 * attempt + Math.floor(Math.random() * 400));
      continue;
    }
    break;
  }

  const err = new Error('FAILED_TO_SAVE_PROGRESS');
  err.status = 500;
  err.details = toSupabaseErrorDetails(lastError);
  throw err;
};

export const mutateCourseProgress = async (userId, courseId, mutator, opts = {}) => {
  // If we only need status for mutation check, we can load it partially first
  // But usually mutator needs full state. If opts.onlyStatus is true, we assume mutator is smart.
  const { progress: current, updatedAt } = await loadCourseProgress(userId, courseId, opts);
  const draft = normalizeProgress({ ...current });
  const next = await mutator(draft);

  if (!next) {
    return { progress: current, updatedAt };
  }

  // If we loaded partially, WE CANNOT SAVE back partially as it would overwrite other fields!
  // Unless we use a specialized SQL update. For now, if we mutate, we should probably have full state.
  // Specialized optimization: if only active_job changed, use a RPC or specialized update.

  if (opts.onlyStatus) {
    const { progress: fullCurrent } = await loadCourseProgress(userId, courseId);
    const fullDraft = normalizeProgress({ ...fullCurrent });
    const fullNext = await mutator(fullDraft);
    if (!fullNext) return { progress: fullCurrent, updatedAt };
    return saveCourseProgress(userId, courseId, fullNext);
  }

  return saveCourseProgress(userId, courseId, next);
};
