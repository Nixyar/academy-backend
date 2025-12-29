import { Router } from 'express';
import { randomUUID } from 'crypto';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

const jobs = new Map(); // Map<jobId, { status, outline, css, sections, html, debug }>

const CSS_SYSTEM_SUFFIX = `
Ты генерируешь только CSS.
Запрещено: HTML, JSON, markdown, <style>.
Верни чистый CSS-текст.
`;
const SECTION_SYSTEM_SUFFIX = `
Ты генерируешь только HTML фрагмент ОДНОЙ секции.
Формат строго:
<section id="{ID}"> ... </section>

Запрещено: <html>, <head>, <body>, <main>, <style>, <script>, <title>, JSON, markdown.
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

const ensureFallbackCss = (job, res) => {
  if (job.css) return;
  job.css = fallbackCss;
  sendSse(res, 'css', { type: 'css', content: job.css, css: job.css });
};

const ensureFallbackSections = (job, res) => {
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
    sendSse(res, 'section', { type: 'section', id: key, html: fallback });
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

  return { planSystem: normalizedPlan, renderSystem: normalizedRender };
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

router.post('/start', async (req, res, next) => {
  try {
    const { prompt, lessonId } = req.body || {};

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    if (typeof lessonId !== 'string' || !lessonId.trim()) {
      return res.status(400).json({ error: 'lessonId is required' });
    }

    const { planSystem, renderSystem } = await fetchLessonPrompts(lessonId);

    const outlineText = await callLlm({
      system: planSystem,
      prompt: prompt.trim(),
      temperature: 0.6,
      maxTokens: 4096,
    });

    const outline = extractFirstJsonObject(outlineText);

    if (!outline || typeof outline !== 'object') {
      return res.status(502).json({
        error: 'LLM_PLAN_PARSE_FAILED',
        details: stripFences(String(outlineText || '')).slice(0, 800),
      });
    }

    const sectionEntries = deriveSections(outline);
    if (!sectionEntries.length) {
      return res
        .status(502)
        .json({ error: 'LLM_PLAN_NO_SECTIONS', details: JSON.stringify(outline).slice(0, 800) });
    }
    const jobId = randomUUID();

    jobs.set(jobId, {
      status: 'pending',
      outline,
      css: null,
      sections: {},
      html: null,
      renderSystem,
      lessonId,
      prompt: prompt.trim(),
      sectionOrder: sectionEntries.map(({ key }) => key),
      sectionSpecs: Object.fromEntries(sectionEntries.map(({ key, spec }) => [key, spec])),
      debug: [],
    });

    return res.json({ jobId, outline });
  } catch (e) {
    if (e?.status) {
      return res.status(e.status).json({ error: e.message, details: e.details });
    }
    return next(e);
  }
});

router.get('/stream', async (req, res, next) => {
  let job;
  let streamStarted = false;
  let pingInterval;
  let watcherInterval;

  try {
    const { jobId, debug } = req.query || {};
    const debugMode =
      typeof debug === 'string' && ['1', 'true', 'yes', 'on'].includes(debug.toLowerCase());
    job = typeof jobId === 'string' ? jobs.get(jobId) : null;

    if (!job) {
      return res.status(404).json({ error: 'JOB_NOT_FOUND' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    streamStarted = true;

    let aborted = false;
    req.on('close', () => {
      aborted = true;
      clearInterval(pingInterval);
      clearInterval(watcherInterval);
    });

    const failStream = (err) => {
      const normalizeDetails = (details) => {
        if (typeof details !== 'string') return null;
        const trimmed = details.trim();
        if (!trimmed) return null;
        const looksLikeHtml = /<[^>]+>/.test(trimmed);
        if (looksLikeHtml) return 'INVALID_SECTION_HTML';
        return trimmed.slice(0, 200);
      };

      try {
        const code = err?.message || 'STREAM_FAILED';
        const safeDetails = normalizeDetails(err?.details) || normalizeDetails(err?.message);
        job.status = 'error';
        sendSse(res, 'error', { type: 'error', code, details: safeDetails || code });
      } catch {
        // ignore
      } finally {
        clearInterval(pingInterval);
        clearInterval(watcherInterval);
        if (canWrite(res)) res.end();
      }
    };

    let replayed = false;
    if (job.css) sendSse(res, 'css', { type: 'css', content: job.css, css: job.css });
    if (job.sectionOrder?.length) {
      job.sectionOrder.forEach((key) => {
        if (job.sections[key]) {
        sendSse(res, 'section', { type: 'section', id: key, html: job.sections[key] });
          replayed = true;
        }
      });
    }

    if (debugMode && job.debug?.length) {
      job.debug.forEach((entry) => sendSse(res, 'debug', entry));
    }

    if (job.status === 'done') {
      sendSse(res, 'done', { type: 'done' });
      return res.end();
    }

    if (job.status === 'running') {
      pingInterval = setInterval(() => {
        if (canWrite(res)) {
          res.write(': ping\n\n');
        } else {
          clearInterval(pingInterval);
        }
      }, 20000);

      watcherInterval = setInterval(() => {
        if (!canWrite(res)) {
          clearInterval(watcherInterval);
          return;
        }
        if (job.status === 'done') {
          sendSse(res, 'done', { type: 'done' });
          res.end();
          clearInterval(watcherInterval);
          clearInterval(pingInterval);
        } else if (job.status === 'error') {
          sendSse(res, 'error', { type: 'error', code: 'STREAM_FAILED', details: 'STREAM_FAILED' });
          res.end();
          clearInterval(watcherInterval);
          clearInterval(pingInterval);
        }
      }, 1000);

      return;
    }

    job.status = 'running';
    pingInterval = setInterval(() => {
      if (canWrite(res)) {
        res.write(': ping\n\n');
      } else {
        clearInterval(pingInterval);
      }
    }, 20000);

    try {
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
          system: `${job.renderSystem}\n\n${CSS_SYSTEM_SUFFIX}`,
          prompt: cssPrompt,
          temperature: 0.2,
          maxTokens: 1800,
        });

        const cssDebugEntry = recordDebug(job, {
          step: 'css',
          prompt: cssPrompt,
          response: cssText,
        });
        if (debugMode && cssDebugEntry) sendSse(res, 'debug', cssDebugEntry);

        job.css = cleanCss(cssText);
        sendSse(res, 'css', { type: 'css', content: job.css, css: job.css });
      }

      const sectionsToGenerate = job.sectionOrder?.length
        ? job.sectionOrder.filter((key) => !job.sections[key])
        : [];

      for (const key of sectionsToGenerate) {
        const sectionSpec = job.sectionSpecs?.[key] ?? job.outline?.[key];
        const sectionCtx = {
          title: job.outline?.title,
          theme: job.outline?.theme,
          constraints: job.outline?.constraints,
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

        const sectionText = await callLlm({
          system: `${job.renderSystem}\n\n${SECTION_SYSTEM_SUFFIX.replace('{ID}', key)}`,
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
        if (debugMode && sectionDebug) sendSse(res, 'debug', sectionDebug);

        const sectionHtml = cleanHtmlFragment(normalizeLlmHtml(sectionText));
        const finalSection =
          typeof sectionHtml === 'string' && sectionHtml.trim()
            ? sectionHtml
            : buildFallbackSection(key, sectionSpec);

        job.sections[key] = finalSection;
        sendSse(res, 'section', { type: 'section', id: key, html: finalSection });
      }
    } catch (err) {
      // Если LLM сломался — отправляем фолбэки и всё равно завершаем
      ensureFallbackCss(job, res);
      ensureFallbackSections(job, res);
    }

    const assembledSections = (job.sectionOrder || Object.keys(job.sections)).map((key) =>
      job.sections[key] ? job.sections[key] : '',
    );

    const lang = job.outline?.lang || 'ru';
    const title = job.outline?.title || 'Site';

    const finalHtml = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
${job.css || ''}
</style>
</head>
<body>
${assembledSections.join('\n\n')}
</body>
</html>`;

    job.html = finalHtml;
    job.status = 'done';

    sendSse(res, 'done', { type: 'done' });
    clearInterval(pingInterval);
    clearInterval(watcherInterval);
    if (canWrite(res)) res.end();
    return;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('HTML stream failed', e);
    if (job && !job.sections) job.sections = {};

    // Попытаться отправить фолбэк-поток даже если ошибка случилась до начала SSE
    try {
      if (!streamStarted) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.flushHeaders?.();
        streamStarted = true;
      }

      if (job) {
        ensureFallbackCss(job, res);
        ensureFallbackSections(job, res);
        job.status = 'done';
        sendSse(res, 'done', { type: 'done' });
        if (canWrite(res)) res.end();
        return;
      }
    } catch (fallbackErr) {
      // eslint-disable-next-line no-console
      console.error('HTML stream fallback failed', fallbackErr);
    }

    if (streamStarted) {
      const looksLikeHtml = typeof e?.details === 'string' && /<[^>]+>/.test(e.details);
      const code = e?.message || 'STREAM_FAILED';
      const safeDetails =
        looksLikeHtml || typeof e?.details !== 'string'
          ? code
          : e.details.trim().slice(0, 200) || code;
      sendSse(res, 'error', { type: 'error', code, details: safeDetails });
      if (canWrite(res)) res.end();
      return;
    }

    return res
      .status(e?.status || 500)
      .json({ error: 'STREAM_FAILED', details: e?.details || e?.message || null });
  }
});

router.get('/result', (req, res) => {
  const { jobId, debug } = req.query || {};
  const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
  const debugMode =
    typeof debug === 'string' && ['1', 'true', 'yes', 'on'].includes(debug.toLowerCase());

  if (!job) {
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
