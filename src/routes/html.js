import { Router } from 'express';
import { randomUUID } from 'crypto';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import requireUser from '../middleware/requireUser.js';
import {
  ACTIVE_JOB_TTL_MS,
  isActiveJobRunning,
  loadCourseProgress,
  mutateCourseProgress,
  saveCourseProgress,
} from '../lib/courseProgress.js';
import { ensureWorkspace, pickNextPageFilename } from '../lib/htmlWorkspace.js';

const router = Router();

const JOB_TTL_MS = 20 * 60 * 1000;
const jobs = new Map(); // Map<jobId, Job>

const CSS_SYSTEM_SUFFIX = `
Ты генерируешь ГЛОБАЛЬНЫЙ CSS.
Твоя задача:
1. Определить :root переменные для цветов (на основе JSON темы).
2. Добавить красивые @keyframes анимации (fade-in, slide-up), которые можно использовать в классах (например .animate-fade-in).
3. Сделать кастомный скроллбар.
Запрещено: HTML, JSON, markdown. Верни только CSS код.
`;
const SECTION_SYSTEM_SUFFIX = `
Ты генерируешь только HTML фрагмент ОДНОЙ секции.
Формат строго:
<section id="{ID}"> ... </section>

Запрещено: <html>, <head>, <body>, <main>, <style>, <script>, <title>, markdown.
Не экранируй кавычки в атрибутах (никаких \\" внутри HTML).
`;

const escapeHtml = (str) =>
  String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripFences = (s) =>
  String(s || '')
    .replace(/```json/gi, '')
    .replace(/```html/gi, '')
    .replace(/```css/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*json\s*\/?\s*/i, '')
    .trim();

const tryParseJsonObject = (s) => {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const repairJson = (s) => {
  const withoutTrailingCommas = s.replace(/,\s*([}\]])/g, '$1');

  const parsed = tryParseJsonObject(withoutTrailingCommas);
  if (parsed) return parsed;

  const firstBrace = withoutTrailingCommas.indexOf('{');
  const lastBrace = withoutTrailingCommas.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return tryParseJsonObject(withoutTrailingCommas.slice(firstBrace, lastBrace + 1));
  }
  return null;
};

const extractFirstJsonObject = (text) => {
  const cleaned = stripFences(text);
  const direct = repairJson(cleaned);
  if (direct) return direct;

  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return repairJson(m[0]);
};

const cleanCss = (css) => stripFences(css).replace(/<\/?style[^>]*>/gi, '').trim();

const cleanHtmlFragment = (html) => {
  const cleaned = stripFences(html);
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();
  return cleaned.trim();
};

const tryExtractHtmlField = (text) => {
  const obj = extractFirstJsonObject(text);
  if (obj && typeof obj === 'object' && typeof obj.html === 'string') return obj.html;
  return null;
};

const tryParseJsonString = (text) => {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

const decodeEscapes = (value) => {
  let current = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    const next = current
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    if (next === current) break;
    current = next;
  }
  return current;
};

// LLM иногда отдаёт HTML с \" и \\n — приводим к нормальному виду
const normalizeLlmHtml = (raw) => {
  let s = String(raw || '');

  // если это JSON вида {"html":"<section ...>"} — достаём поле html
  const fromJson = tryExtractHtmlField(s);
  if (fromJson) s = fromJson;

  // если это строка в JSON-формате ("<section ...>") — парсим
  const parsedString = tryParseJsonString(s.trim());
  if (parsedString) s = parsedString;

  // разэкранируем типовые последовательности (несколько проходов)
  s = decodeEscapes(s);

  return s;
};

const isValidHtmlDocument = (html) => {
  const s = String(html || '');
  if (s.includes('```')) return false;
  if (s.trim().length <= 300) return false;
  if (!/(<!doctype\s+html|<html\b)/i.test(s)) return false;
  return true;
};

const MAX_HTML_BYTES = 600 * 1024;

const getUtf8Bytes = (value) => Buffer.byteLength(String(value || ''), 'utf8');

const ensureHtmlWithinLimit = (filesByName) => {
  if (!filesByName || typeof filesByName !== 'object' || Array.isArray(filesByName)) return null;

  for (const [name, content] of Object.entries(filesByName)) {
    const bytes = getUtf8Bytes(content);
    if (bytes > MAX_HTML_BYTES) {
      return { file: name, bytes, limit: MAX_HTML_BYTES };
    }
  }

  return null;
};

const hasIndexHtmlInProgress = (progress) => {
  const result = progress?.result;
  const files = result?.files;

  if (files && typeof files === 'object' && !Array.isArray(files)) {
    return Object.prototype.hasOwnProperty.call(files, 'index.html');
  }

  return typeof result?.html === 'string';
};

const toWorkspaceResponse = (progress) => {
  const workspace = ensureWorkspace(progress);
  return {
    result: {
      files: workspace.result.files,
      active_file: workspace.result.active_file,
      meta: workspace.result.meta,
    },
  };
};

const buildFallbackSection = (id, spec) => {
  const heading =
    spec?.title || spec?.heading || spec?.label || spec?.name || `Section ${id || ''}`.trim();
  const desc = spec?.description || spec?.summary || '';
  const body = [
    `<h2>${escapeHtml(heading)}</h2>`,
    desc ? `<p>${escapeHtml(desc)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `<section id="${id}"><div class="section-fallback">${body}</div></section>`;
};

const fallbackCss = `:root {
  --color-bg: #0b1021;
  --color-card: #121a33;
  --color-text: #e3e9ff;
  --color-accent: #5de4c7;
  --color-muted: #9aa4c2;
  --radius: 16px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px;
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  background: radial-gradient(circle at 10% 20%, #14204a, #0b1021 40%), #0b1021;
  color: var(--color-text);
}
h1,h2,h3,p { margin: 0 0 12px 0; }
.section-fallback {
  background: linear-gradient(135deg, rgba(93, 228, 199, 0.08), rgba(93, 228, 199, 0.02));
  border: 1px solid rgba(93, 228, 199, 0.18);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}`;

const ensureFallbackCss = (job, emit) => {
  if (job.css) return;
  job.css = fallbackCss;
  emit('css', { type: 'css', content: job.css, css: job.css });
};

const ensureFallbackSections = (job, emit) => {
  const keys =
    job.sectionOrder?.length
      ? job.sectionOrder
      : Object.keys(job.sectionSpecs || job.outline?.layout || {}) || [];

  const effectiveKeys = keys.length ? keys : ['section_1'];

  effectiveKeys.forEach((key, idx) => {
    if (job.sections[key]) return;
    const spec = job.sectionSpecs?.[key] || job.outline?.layout?.[idx] || job.outline?.[key];
    const fallback = buildFallbackSection(key, spec);
    job.sections[key] = fallback;
    emit('section', { type: 'section', id: key, html: fallback });
  });
};

const canWrite = (res) => res && !res.writableEnded && !res.writableFinished && !res.destroyed;

const sendSse = (res, event, payload) => {
  try {
    if (!canWrite(res)) return;
    const normalized = payload === undefined ? '' : payload;
    const data = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
    const safeData = typeof data === 'string' ? data : '';

    res.write(`event: ${event}\n`);
    safeData.split(/\r?\n/).forEach((line) => res.write(`data: ${line}\n`));
    res.write('\n');
    if (typeof res.flush === 'function') res.flush();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to write SSE chunk', err);
  }
};

const broadcastSse = (job, event, payload) => {
  if (!job?.subscribers) return;
  for (const res of job.subscribers) {
    if (!canWrite(res)) {
      job.subscribers.delete(res);
      continue;
    }
    sendSse(res, event, payload);
  }
};

const emitStatus = (job, status, message, progress) => {
  const payload = {
    status,
    message: typeof message === 'string' ? message : undefined,
    progress: typeof progress === 'number' ? progress : undefined,
  };
  job.lastStatus = payload;
  broadcastSse(job, 'status', payload);
};

const safeEnd = (res) => {
  try {
    if (canWrite(res)) res.end();
  } catch {
    // ignore
  }
};

const scheduleJobCleanup = (jobId) => {
  const job = jobs.get(jobId);
  if (!job) return;

  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    const current = jobs.get(jobId);
    if (!current) return;
    for (const res of current.subscribers || []) safeEnd(res);
    jobs.delete(jobId);
  }, JOB_TTL_MS);
};

const ensureJob = (jobId, init) => {
  const existing = jobs.get(jobId);
  if (existing) return existing;

  const job = {
    jobId,
    status: 'queued',
    mode: init.mode,
    userId: init.userId,
    courseId: init.courseId,
    lessonId: init.lessonId || null,
    instruction: init.instruction,

    subscribers: new Set(),
    cleanupTimer: null,
    createdAt: Date.now(),
    started: false,
    runner: null,

    // output/state
    lastStatus: { status: 'queued', message: 'queued', progress: 0 },
    result: null,
    error: null,

    // create-mode specific state (for replay/debug)
    outline: null,
    css: null,
    sections: {},
    html: null,
    renderSystem: null,
    sectionOrder: [],
    sectionSpecs: {},
    context: null,
    prompt: null,
    debug: [],
  };

  jobs.set(jobId, job);
  scheduleJobCleanup(jobId);
  return job;
};

const recordDebug = (job, entry) => {
  if (!job) return;
  if (!job.debug) job.debug = [];

  const normalized = {
    ...entry,
    prompt: typeof entry.prompt === 'string' ? entry.prompt : undefined,
    response:
      typeof entry.response === 'string' ? entry.response : String(entry.response ?? ''),
  };

  job.debug.push(normalized);

  const limit = 50;
  if (job.debug.length > limit) {
    job.debug = job.debug.slice(-limit);
  }

  return normalized;
};

const deriveSections = (outline) => {
  if (!outline || typeof outline !== 'object') return [];

  if (Array.isArray(outline.layout) && outline.layout.length) {
    return outline.layout.map((block, idx) => ({
      key: block?.id || block?.key || `section_${idx + 1}`,
      spec: block,
    }));
  }

  if (Array.isArray(outline.sections) && outline.sections.length) {
    return outline.sections.map((section, idx) => ({
      key: section?.id || section?.key || `section_${idx + 1}`,
      spec: section,
    }));
  }

  return [];
};

const fetchLessonPrompts = async (lessonId) => {
  const { data: lesson, error } = await supabaseAdmin
    .from('lessons')
    .select('*')
    .eq('id', lessonId)
    .maybeSingle();

  if (error) {
    const err = new Error('FAILED_TO_FETCH_LESSON');
    err.status = 500;
    err.details = error.message;
    throw err;
  }
  if (!lesson) {
    const err = new Error('LESSON_NOT_FOUND');
    err.status = 404;
    throw err;
  }

  const fallbackSystem = typeof lesson.llm_system_prompt === 'string' ? lesson.llm_system_prompt : null;
  const planSystem = (
    typeof lesson.llm_plan_system_prompt === 'string' ? lesson.llm_plan_system_prompt : null
  ) || fallbackSystem;
  const renderSystem = (
    typeof lesson.llm_render_system_prompt === 'string' ? lesson.llm_render_system_prompt : null
  ) || fallbackSystem;

  const normalizedPlan = typeof planSystem === 'string' ? planSystem.trim() : '';
  const normalizedRender = typeof renderSystem === 'string' ? renderSystem.trim() : '';

  if (!normalizedPlan) {
    const err = new Error('LESSON_LLM_PLAN_SYSTEM_PROMPT_MISSING');
    err.status = 400;
    throw err;
  }
  if (!normalizedRender) {
    const err = new Error('LESSON_LLM_RENDER_SYSTEM_PROMPT_MISSING');
    err.status = 400;
    throw err;
  }

  return { planSystem: normalizedPlan, renderSystem: normalizedRender, lesson };
};

const callLlm = async ({ system, prompt, temperature, maxTokens }) => {
  const resp = await fetch(env.llmApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      prompt,
      temperature,
      maxTokens,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => null);
    const err = new Error('LLM_REQUEST_FAILED');
    err.details = errorText || resp.statusText;
    err.status = 502;
    throw err;
  }

  const payload = await resp.json().catch(async () => ({ text: await resp.text() }));
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.html === 'string') return payload.html;
  return String(payload || '');
};

const heartbeatActiveJob = async (job, extra = {}) => {
  const now = new Date().toISOString();
  await mutateCourseProgress(job.userId, job.courseId, (progress) => {
    if (!progress.active_job || progress.active_job.jobId !== job.jobId) return null;
    return {
      ...progress,
      active_job: {
        ...progress.active_job,
        ...extra,
        updatedAt: now,
      },
    };
  });
};

const completeActiveJob = async (job, status, result = {}) => {
  const now = new Date().toISOString();
  const { progress: saved } = await mutateCourseProgress(job.userId, job.courseId, (progress) => {
    if (!progress.active_job || progress.active_job.jobId !== job.jobId) return null;

    const lastUpdatedByLessonId =
      progress.active_job.last_updated_by_lesson_id ||
      progress.active_job.lastUpdatedByLessonId ||
      job.lessonId ||
      progress.active_job.lessonId ||
      progress.active_job.lesson_id ||
      null;

    const nextActiveJob = {
      ...progress.active_job,
      status,
      updatedAt: now,
    };

    if (status === 'done') {
      nextActiveJob.last_updated_by_lesson_id = lastUpdatedByLessonId;
    }

    const baseResult =
      progress.result && typeof progress.result === 'object' && !Array.isArray(progress.result)
        ? { ...progress.result }
        : { html: null, meta: {} };

    const meta = result.meta && typeof result.meta === 'object' ? result.meta : {};
    const files =
      result.files && typeof result.files === 'object' && !Array.isArray(result.files) ? result.files : undefined;
    const activeFile = typeof result.active_file === 'string' ? result.active_file : undefined;

    const nextProgress = {
      ...progress,
      active_job: nextActiveJob,
      result: {
        ...baseResult,
        html: result.html ?? baseResult.html ?? null,
        files: files ?? baseResult.files,
        active_file: activeFile ?? baseResult.active_file,
        meta: { ...(baseResult.meta || {}), ...meta },
      },
    };

    // Back-compat: keep result.html, but also keep multi-page workspace when possible
    const withWorkspace = ensureWorkspace(nextProgress);
    if (withWorkspace.result?.files && typeof withWorkspace.result.html === 'string') {
      const active = withWorkspace.result.active_file || 'index.html';
      if (withWorkspace.result.files[active]) {
        withWorkspace.result.html = withWorkspace.result.files[active];
      }
      withWorkspace.result.meta = withWorkspace.result.meta || {};
      withWorkspace.result.meta.pages_count = Object.keys(withWorkspace.result.files).length;
    }

    return withWorkspace;
  });

  return saved;
};

const failActiveJob = async (job, code) =>
  completeActiveJob(job, 'failed', {
    meta: {
      error: code || 'FAILED',
    },
  });

const getLastHeartbeat = (activeJob, progressUpdatedAt) => {
  const raw =
    activeJob?.updatedAt || activeJob?.startedAt || progressUpdatedAt || activeJob?.started_at;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ts) ? null : ts;
};

const normalizeMode = (value) => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : 'create';
  if (raw === 'add-page') return 'add_page';
  return raw;
};

const enqueueJob = async ({ userId, mode, courseId, lessonId, instruction }) => {
  let resolvedCourseId = courseId;
  let resolvedLessonId = lessonId || null;

  if (mode === 'create') {
    const { lesson } = await fetchLessonPrompts(lessonId);
    resolvedCourseId = lesson.course_id;
    resolvedLessonId = lessonId;
  }

  const { progress: currentProgress, updatedAt: progressUpdatedAt } = await loadCourseProgress(
    userId,
    resolvedCourseId,
  );
  const activeJob = currentProgress.active_job;
  const existingJob = activeJob?.jobId ? jobs.get(activeJob.jobId) : null;
  const lastHeartbeat = getLastHeartbeat(activeJob, progressUpdatedAt);
  const isStale =
    isActiveJobRunning(activeJob) &&
    (!lastHeartbeat || Date.now() - lastHeartbeat > ACTIVE_JOB_TTL_MS || !existingJob);

  if (isStale && activeJob) {
    await saveCourseProgress(userId, resolvedCourseId, {
      ...currentProgress,
      active_job: {
        ...activeJob,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        error: 'STALE_HEARTBEAT',
      },
    });
  }

  if (isActiveJobRunning(activeJob) && !isStale) {
    return { jobId: activeJob.jobId, already_running: true, courseId: resolvedCourseId };
  }

  const jobId = randomUUID();
  const nowIso = new Date().toISOString();
  const initialProgress = {
    ...currentProgress,
    active_job: {
      jobId,
      courseId: resolvedCourseId,
      lessonId: resolvedLessonId,
      status: 'queued',
      prompt: instruction,
      startedAt: nowIso,
      updatedAt: nowIso,
    },
    result: {
      html: null,
      meta:
        currentProgress.result && typeof currentProgress.result.meta === 'object'
          ? { ...currentProgress.result.meta }
          : {},
    },
  };

  await saveCourseProgress(userId, resolvedCourseId, initialProgress);

  const job = ensureJob(jobId, {
    mode,
    userId,
    courseId: resolvedCourseId,
    lessonId: resolvedLessonId,
    instruction,
  });
  job.status = 'queued';
  emitStatus(job, 'queued', 'queued', 0);
  await heartbeatActiveJob(job, { status: 'queued' });

  return { jobId, already_running: false, courseId: resolvedCourseId };
};

router.post('/start', requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = normalizeMode(body.mode);
    const lessonId = typeof body.lessonId === 'string' ? body.lessonId.trim() : '';
    const requestedCourseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
    const instruction =
      typeof body.instruction === 'string'
        ? body.instruction.trim()
        : (typeof body.prompt === 'string' ? body.prompt.trim() : '');
    const { user } = req;

    if (!['create', 'edit', 'add_page'].includes(mode)) {
      return res.status(400).json({
        error: 'INVALID_MODE',
        details: 'mode must be create|edit|add_page',
      });
    }

    if (!instruction) {
      return res.status(400).json({ error: 'instruction is required' });
    }

    if (mode === 'create') {
      if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });
      const { lesson } = await fetchLessonPrompts(lessonId);
      const derivedCourseId = lesson.course_id;
      if (requestedCourseId && requestedCourseId !== derivedCourseId) {
        return res.status(400).json({
          error: 'COURSE_ID_MISMATCH',
          details: `lesson.course_id != courseId (${derivedCourseId} != ${requestedCourseId})`,
        });
      }
    } else {
      if (!requestedCourseId) return res.status(400).json({ error: 'courseId is required' });
    }

    const { jobId } = await enqueueJob({
      userId: user.id,
      mode,
      courseId: requestedCourseId || null,
      lessonId,
      instruction,
    });

    return res.json({ jobId });
  } catch (e) {
    if (e?.status) {
      return res.status(e.status).json({ error: e.message, details: e.details });
    }
    return next(e);
  }
});

router.post('/edit', requireUser, async (req, res, next) => {
  try {
    const { courseId, instruction, lessonId } = req.body || {};
    const { user } = req;

    if (typeof courseId !== 'string' || !courseId.trim()) {
      return res.status(400).json({ error: 'courseId is required' });
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction is required' });
    }

    const { jobId } = await enqueueJob({
      userId: user.id,
      mode: 'edit',
      courseId: courseId.trim(),
      lessonId: typeof lessonId === 'string' ? lessonId.trim() : null,
      instruction: instruction.trim(),
    });

    return res.json({ jobId });
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

router.post('/add-page', requireUser, async (req, res, next) => {
  try {
    const { courseId, instruction, lessonId } = req.body || {};
    const { user } = req;

    if (typeof courseId !== 'string' || !courseId.trim()) {
      return res.status(400).json({ error: 'courseId is required' });
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction is required' });
    }

    const { jobId } = await enqueueJob({
      userId: user.id,
      mode: 'add_page',
      courseId: courseId.trim(),
      lessonId: typeof lessonId === 'string' ? lessonId.trim() : null,
      instruction: instruction.trim(),
    });

    return res.json({ jobId });
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

router.get('/stream', requireUser, async (req, res, next) => {
  let pingInterval;

  const normalizeErrorDetails = (details) => {
    if (details && typeof details === 'object' && !Array.isArray(details)) return details;
    if (typeof details !== 'string') return null;
    const trimmed = details.trim();
    if (!trimmed) return null;
    const looksLikeHtml = /<[^>]+>/.test(trimmed);
    if (looksLikeHtml) return 'INVALID_HTML';
    return trimmed.slice(0, 800);
  };

  const failJob = async (job, err) => {
    const code = err?.message || 'FAILED';
    const safeDetails = normalizeErrorDetails(err?.details) || normalizeErrorDetails(err?.message);
    job.status = 'error';
    job.error = { error: code, details: safeDetails || undefined };
    emitStatus(job, 'error', code);
    broadcastSse(job, 'error', job.error);
    try {
      await failActiveJob(job, code);
    } catch {
      // ignore
    }
  };

  const finishJob = (job) => {
    scheduleJobCleanup(job.jobId);
    for (const client of job.subscribers || []) safeEnd(client);
  };

  const runCreateJob = async (job, debugMode) => {
    const emit = (event, payload) => broadcastSse(job, event, payload);

    emitStatus(job, 'loading_progress', 'loading progress', 0.05);
    const { planSystem, renderSystem, lesson } = await fetchLessonPrompts(job.lessonId);
    if (lesson.course_id !== job.courseId) {
      throw Object.assign(new Error('COURSE_ID_MISMATCH'), { status: 400, details: 'course mismatch' });
    }
    job.renderSystem = renderSystem;

    const { progress: current } = await loadCourseProgress(job.userId, job.courseId);
    const workspace = ensureWorkspace(current);
    const fileList = Object.keys(workspace.result.files || {}).join(', ');
    const activeName = workspace.result.active_file;
    const currentCode = activeName ? workspace.result.files?.[activeName] : null;

    let context = `
=== CONTEXT ===
Existing files: ${fileList || 'None'}
`;
    if (currentCode) {
      context += `
CURRENT CODE OF FILE "${activeName}":
${currentCode}
`;
    }
    context += `=================\n`;
    job.context = context;
    job.prompt = job.instruction;

    emitStatus(job, 'calling_llm', 'planning', 0.12);
    const outlineText = await callLlm({
      system: context + planSystem,
      prompt: job.instruction,
      temperature: 0.6,
      maxTokens: 4096,
    });

    const outline = extractFirstJsonObject(outlineText);
    if (!outline || typeof outline !== 'object') {
      await completeActiveJob(job, 'failed', { meta: { error: 'LLM_PLAN_PARSE_FAILED' } });
      throw Object.assign(new Error('LLM_PLAN_PARSE_FAILED'), {
        status: 502,
        details: stripFences(String(outlineText || '')).slice(0, 800),
      });
    }

    const sectionEntries = deriveSections(outline);
    if (!sectionEntries.length) {
      await completeActiveJob(job, 'failed', {
        meta: { error: 'LLM_PLAN_NO_SECTIONS', last_llm_error: 'LLM_PLAN_NO_SECTIONS' },
      });
      throw Object.assign(new Error('LLM_PLAN_NO_SECTIONS'), {
        status: 502,
        details: JSON.stringify(outline).slice(0, 800),
      });
    }

    job.outline = outline;
    job.sectionOrder = sectionEntries.map(({ key }) => key);
    job.sectionSpecs = Object.fromEntries(sectionEntries.map(({ key, spec }) => [key, spec]));
    job.sections = job.sections || {};

    emitStatus(job, 'calling_llm', 'generating css', 0.2);
    if (!job.css) {
      const cssCtx = {
        title: job.outline?.title,
        lang: job.outline?.lang,
        theme: job.outline?.theme,
        constraints: job.outline?.constraints,
      };

      const cssPrompt = [
        'Сгенерируй полный CSS для страницы.',
        'Учитывай пользовательский запрос:',
        job.prompt,
        'Контекст (JSON):',
        JSON.stringify(cssCtx),
      ].join('\n');

      const cssText = await callLlm({
        system: `${job.renderSystem}\n\n${CSS_SYSTEM_SUFFIX}\n${job.context}`,
        prompt: cssPrompt,
        temperature: 0.2,
        maxTokens: 1800,
      });

      const cssDebugEntry = recordDebug(job, {
        step: 'css',
        prompt: cssPrompt,
        response: cssText,
      });
      if (debugMode && cssDebugEntry) emit('debug', cssDebugEntry);

      job.css = cleanCss(cssText);
      emit('css', { type: 'css', content: job.css, css: job.css });
      await heartbeatActiveJob(job);
    }

    const sectionsToGenerate = job.sectionOrder?.length
      ? job.sectionOrder.filter((key) => !job.sections[key])
      : [];

    for (const [idx, key] of sectionsToGenerate.entries()) {
      emitStatus(
        job,
        'calling_llm',
        `generating section ${idx + 1}/${sectionsToGenerate.length}`,
        0.25 + (0.55 * (idx / Math.max(1, sectionsToGenerate.length))),
      );

      let sectionText;
      try {
        const sectionSpec = job.sectionSpecs?.[key] ?? job.outline?.[key];
        const sectionCtx = {
          title: job.outline?.title,
          theme: job.outline?.theme,
          constraints: job.outline?.constraints,
          css_hint:
            'Используй CSS переменные из root, если нужно, но приоритет Tailwind классам.',
          css: job.css,
        };
        const sectionPrompt = `
User request:
${job.prompt}

Global context (JSON):
${JSON.stringify(sectionCtx)}

Section spec (JSON):
${JSON.stringify(sectionSpec ?? {})}

Return ONLY:
<section id="${key}">...</section>
`;

        sectionText = await callLlm({
          system: `${job.renderSystem}\n\n${SECTION_SYSTEM_SUFFIX.replace('{ID}', key)}\n${job.context}`,
          prompt: sectionPrompt,
          temperature: 0.15,
          maxTokens: 2000,
        });

        const sectionDebug = recordDebug(job, {
          step: 'section',
          id: key,
          prompt: sectionPrompt,
          response: sectionText,
        });
        if (debugMode && sectionDebug) emit('debug', sectionDebug);
      } catch {
        sectionText = '';
      }

      const sectionSpec = job.sectionSpecs?.[key] ?? job.outline?.[key];
      const sectionHtml = cleanHtmlFragment(normalizeLlmHtml(sectionText));
      const finalSection =
        typeof sectionHtml === 'string' && sectionHtml.trim()
          ? sectionHtml
          : buildFallbackSection(key, sectionSpec);

      job.sections[key] = finalSection;
      emit('section', { type: 'section', id: key, html: finalSection });
      await heartbeatActiveJob(job);
    }

    if (!job.css) ensureFallbackCss(job, emit);
    if (!job.sections || !Object.keys(job.sections).length) ensureFallbackSections(job, emit);

    emitStatus(job, 'validating', 'assembling html', 0.9);
    const assembledSections = (job.sectionOrder || Object.keys(job.sections)).map((key) =>
      job.sections[key] ? job.sections[key] : '',
    );

    const lang = job.outline?.lang || 'ru';
    const title = job.outline?.title || 'Site';

    const finalHtml = `<!DOCTYPE html>
<html lang="${lang}" class="scroll-smooth">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>

<!-- ПОДКЛЮЧЕНИЕ БИБЛИОТЕК -->
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">

<script>
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: {
          sans: ['Inter', 'sans-serif'],
          serif: ['Playfair Display', 'serif'],
        },
        colors: {
           // Здесь можно было бы инжектить цвета из job.outline.theme, но пока хватит дефолтных
        }
      }
    }
  }
</script>

<style>
/* Custom CSS generated by LLM */
${job.css || ''}

/* Базовые фиксы */
body { font-family: 'Inter', sans-serif; }
</style>
</head>
<body class="${job.outline?.theme?.backgroundColor || 'bg-gray-50'} text-gray-900">
${assembledSections.join('\n\n')}
</body>
</html>`;

    job.html = finalHtml;

    emitStatus(job, 'saving', 'saving progress', 0.96);
    const saved = await completeActiveJob(job, 'done', { html: finalHtml });
    job.result = toWorkspaceResponse(saved);
    job.status = 'done';
    emitStatus(job, 'done', 'done', 1);
    emit('done', { type: 'done', ...job.result });
  };

  const runEditJob = async (job) => {
    emitStatus(job, 'loading_progress', 'loading progress', 0.05);
    const { progress: current } = await loadCourseProgress(job.userId, job.courseId);
    if (!hasIndexHtmlInProgress(current)) {
      throw Object.assign(new Error('NO_INDEX_HTML'), {
        status: 400,
        details: 'index.html is missing; generate the site first',
      });
    }

    emitStatus(job, 'ensure_workspace', 'ensure workspace', 0.15);
    const workspace = ensureWorkspace(current);
    const targetFile = workspace.result.active_file || 'index.html';
    const currentHtml = workspace.result.files?.[targetFile] ?? '';

    emitStatus(job, 'calling_llm', 'editing html', 0.35);
    const system = [
      'Ты — HTML Editor.',
      'Редактируй существующий HTML документ минимально, строго по инструкции.',
      'НЕ используй markdown и code fences.',
      'Верни только полный HTML документ (включая <!DOCTYPE> и <html>), без пояснений.',
    ].join('\n');

    const prompt = [
      'ИНСТРУКЦИЯ:',
      job.instruction,
      '',
      'CURRENT_HTML_START',
      currentHtml,
      'CURRENT_HTML_END',
      '',
      'Верни полный обновлённый HTML документ.',
    ].join('\n');

    const newHtml = await callLlm({
      system,
      prompt,
      temperature: 0.2,
      maxTokens: 8192,
    });

    emitStatus(job, 'validating', 'validating html', 0.6);
    if (!isValidHtmlDocument(newHtml)) {
      throw Object.assign(new Error('LLM_INVALID_HTML'), {
        status: 502,
        details: stripFences(String(newHtml || '')).slice(0, 500),
      });
    }

    const tooLarge = ensureHtmlWithinLimit({ [targetFile]: newHtml });
    if (tooLarge) {
      throw Object.assign(new Error('LLM_HTML_TOO_LARGE'), { status: 502, details: tooLarge });
    }

    emitStatus(job, 'saving', 'saving progress', 0.85);
    const next = ensureWorkspace({
      ...workspace,
      result: {
        ...workspace.result,
        files: {
          ...workspace.result.files,
          [targetFile]: String(newHtml),
        },
        active_file: targetFile,
        meta: {
          ...(workspace.result.meta || {}),
          edit_count: Number.isFinite(Number(workspace.result.meta?.edit_count))
            ? Number(workspace.result.meta.edit_count) + 1
            : 1,
        },
      },
    });
    next.result.html = next.result.files[next.result.active_file] ?? next.result.html ?? null;

    const saved = await completeActiveJob(job, 'done', {
      files: next.result.files,
      active_file: next.result.active_file,
      html: next.result.html,
      meta: next.result.meta,
    });

    job.result = toWorkspaceResponse(saved);
    job.status = 'done';
    emitStatus(job, 'done', 'done', 1);
    broadcastSse(job, 'done', { type: 'done', ...job.result });
  };

  const runAddPageJob = async (job) => {
    emitStatus(job, 'loading_progress', 'loading progress', 0.05);
    const { progress: current } = await loadCourseProgress(job.userId, job.courseId);
    if (!hasIndexHtmlInProgress(current)) {
      throw Object.assign(new Error('NO_INDEX_HTML'), {
        status: 400,
        details: 'index.html is missing; generate the site first',
      });
    }

    emitStatus(job, 'ensure_workspace', 'ensure workspace', 0.15);
    const workspace = ensureWorkspace(current);
    const files = workspace.result.files || { 'index.html': '' };
    const newFile = pickNextPageFilename(Object.keys(files));
    const indexHtml = files['index.html'] || '';

    const fileNames = Object.keys(files).sort();
    const otherFiles = fileNames.filter((name) => name !== 'index.html');

    emitStatus(job, 'calling_llm', 'adding page', 0.35);
    const system = [
      'Ты — генератор многостраничного HTML сайта.',
      'Верни ТОЛЬКО JSON объект без markdown и без code fences.',
      'Ключи — имена файлов, значения — полный HTML документ.',
      'Никаких пояснений, никакого текста вне JSON.',
    ].join('\n');

    const prompt = [
      `CRITICAL: Верни строго JSON вида: { "index.html": "<...>", "${newFile}": "<...>" }`,
      'Требования:',
      `- Создай новый файл "${newFile}" по инструкции в том же стиле (шрифты/цвета/библиотеки можно копировать из index.html).`,
      `- Обнови "index.html": добавь рабочую ссылку <a href="${newFile}">...</a> в навбар/меню/CTA (если навбар уже есть — аккуратно дополни).`,
      '- Не используй бандлеры; только CDN как в исходном HTML.',
      '- Верни полный HTML в обоих файлах (<!DOCTYPE> + <html>...).',
      '',
      'INSTRUCTION:',
      job.instruction,
      '',
      'CURRENT_INDEX_HTML_START',
      indexHtml,
      'CURRENT_INDEX_HTML_END',
      '',
      otherFiles.length ? `OTHER_FILES: ${otherFiles.join(', ')}` : 'OTHER_FILES: (none)',
    ].join('\n');

    const llmText = await callLlm({
      system,
      prompt,
      temperature: 0.3,
      maxTokens: 8192,
    });

    emitStatus(job, 'validating', 'validating llm output', 0.6);
    const parsed = extractFirstJsonObject(llmText);
    if (!parsed || typeof parsed !== 'object') {
      throw Object.assign(new Error('LLM_JSON_PARSE_FAILED'), {
        status: 502,
        details: stripFences(String(llmText || '')).slice(0, 800),
      });
    }

    const nextIndex = parsed['index.html'];
    const nextNew = parsed[newFile];
    if (typeof nextIndex !== 'string' || typeof nextNew !== 'string') {
      throw Object.assign(new Error('LLM_JSON_MISSING_FILES'), {
        status: 502,
        details: `Expected keys: "index.html", "${newFile}"`,
      });
    }

    if (!isValidHtmlDocument(nextIndex) || !isValidHtmlDocument(nextNew)) {
      throw Object.assign(new Error('LLM_INVALID_HTML'), {
        status: 502,
        details: 'index.html or new page html failed validation',
      });
    }

    const tooLarge = ensureHtmlWithinLimit({ 'index.html': nextIndex, [newFile]: nextNew });
    if (tooLarge) {
      throw Object.assign(new Error('LLM_HTML_TOO_LARGE'), { status: 502, details: tooLarge });
    }

    emitStatus(job, 'saving', 'saving progress', 0.85);
    const next = ensureWorkspace({
      ...workspace,
      result: {
        ...workspace.result,
        files: {
          ...files,
          'index.html': nextIndex,
          [newFile]: nextNew,
        },
        active_file: newFile,
        meta: {
          ...(workspace.result.meta || {}),
          last_added_file: newFile,
        },
      },
    });
    next.result.html = next.result.files[next.result.active_file] ?? next.result.html ?? null;

    const saved = await completeActiveJob(job, 'done', {
      files: next.result.files,
      active_file: next.result.active_file,
      html: next.result.html,
      meta: next.result.meta,
    });

    job.result = toWorkspaceResponse(saved);
    job.status = 'done';
    emitStatus(job, 'done', 'done', 1);
    broadcastSse(job, 'done', { type: 'done', ...job.result });
  };

  try {
    const { jobId, debug } = req.query || {};
    const debugMode =
      typeof debug === 'string' && ['1', 'true', 'yes', 'on'].includes(debug.toLowerCase());

    const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
    if (!job || job.userId !== req.user.id) {
      return res.status(404).json({ error: 'JOB_NOT_FOUND' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    job.subscribers.add(res);
    scheduleJobCleanup(job.jobId);

    req.on('close', () => {
      job.subscribers.delete(res);
      clearInterval(pingInterval);
    });

    if (job.lastStatus) sendSse(res, 'status', job.lastStatus);
    if (job.mode === 'create') {
      if (job.css) sendSse(res, 'css', { type: 'css', content: job.css, css: job.css });
      if (job.sectionOrder?.length) {
        for (const key of job.sectionOrder) {
          if (job.sections?.[key]) sendSse(res, 'section', { type: 'section', id: key, html: job.sections[key] });
        }
      }
      if (debugMode && job.debug?.length) {
        job.debug.forEach((entry) => sendSse(res, 'debug', entry));
      }
    }

    if (job.status === 'done') {
      sendSse(res, 'done', { type: 'done', ...(job.result || {}) });
      return safeEnd(res);
    }
    if (job.status === 'error') {
      sendSse(res, 'error', job.error || { error: 'FAILED' });
      return safeEnd(res);
    }

    pingInterval = setInterval(() => {
      if (!canWrite(res)) return;
      res.write(': ping\n\n');
      if (job.lastStatus) sendSse(res, 'status', job.lastStatus);
    }, 15000);

    if (!job.started) {
      job.started = true;
      job.status = 'running';
      emitStatus(job, 'status', 'running', 0.01);
      await heartbeatActiveJob(job, { status: 'running' });

      job.runner = (async () => {
        try {
          if (job.mode === 'create') await runCreateJob(job, debugMode);
          else if (job.mode === 'edit') await runEditJob(job);
          else if (job.mode === 'add_page') await runAddPageJob(job);
          else throw new Error('INVALID_MODE');
        } catch (err) {
          await failJob(job, err);
        } finally {
          finishJob(job);
        }
      })();
    }

    return;
  } catch (e) {
    return next(e);
  }
});

router.get('/result', requireUser, (req, res) => {
  const { jobId, debug } = req.query || {};
  const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
  const debugMode =
    typeof debug === 'string' && ['1', 'true', 'yes', 'on'].includes(debug.toLowerCase());

  if (!job || job.userId !== req.user.id) {
    return res.status(404).json({ error: 'JOB_NOT_FOUND' });
  }

  return res.json({
    jobId,
    status: job.status,
    outline: job.outline,
    css: job.css,
    sections: job.sections,
    html: job.html,
    debug: debugMode ? job.debug || [] : undefined,
  });
});

export default router;
