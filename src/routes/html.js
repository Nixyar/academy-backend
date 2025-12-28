import { Router } from 'express';
import { randomUUID } from 'crypto';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

const jobs = new Map(); // Map<jobId, { status, outline, css, sections, html }>

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

// LLM иногда отдаёт HTML с \" и \\n — приводим к нормальному виду
const normalizeLlmHtml = (raw) => {
  let s = String(raw || '');

  // если это JSON вида {"html":"<section ...>"} — достаём поле html
  const fromJson = tryExtractHtmlField(s);
  if (fromJson) s = fromJson;

  // разэкранируем типовые последовательности
  s = s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');

  return s;
};

const stripStyleTags = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').trim();

// опционально: если хочешь максимально "чистый" HTML без inline стилей
const stripInlineStyleAttrs = (html) =>
  String(html || '')
    // style="..."
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
    // style='...'
    .replace(/\sstyle\s*=\s*'[^']*'/gi, '')
    .trim();

const hasSectionWithId = (html, id) => {
  const re = new RegExp(
    `<section\\b[^>]*\\bid\\s*=\\s*(?:"${id}"|'${id}'|${id})\\b[^>]*>`,
    'i',
  );
  return re.test(html);
};

const isValidSection = (html, id) => {
  if (typeof html !== 'string') return false;
  const s = html.trim();
  if (!s.toLowerCase().includes('<section')) return false;
  if (!s.toLowerCase().includes('</section>')) return false;
  return hasSectionWithId(s, id);
};

const sectionDiagnostics = (html, id) => {
  const s = String(html || '');
  const sample = s.replace(/[<>]/g, '').slice(0, 120);
  return {
    id,
    hasSectionTag: /<section\b/i.test(s),
    hasClose: /<\/section>/i.test(s),
    hasId: hasSectionWithId(s, id),
    sample,
  };
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
    const { jobId } = req.query || {};
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
        sendSse(res, 'error', { code, details: safeDetails || code });
      } catch {
        // ignore
      } finally {
        clearInterval(pingInterval);
        clearInterval(watcherInterval);
        if (canWrite(res)) res.end();
      }
    };

    let replayed = false;
    if (job.css) sendSse(res, 'css', { css: job.css });
    if (job.sectionOrder?.length) {
      job.sectionOrder.forEach((key) => {
        if (job.sections[key]) {
          sendSse(res, 'section', { id: key, html: job.sections[key] });
          replayed = true;
        }
      });
    }

    if (replayed || job.css) {
      sendSse(res, 'info', { status: 'replayed' });
    }

    if (job.status === 'done') {
      sendSse(res, 'done', { status: 'ready' });
      return res.end();
    }

    if (job.status === 'running') {
      sendSse(res, 'info', { status: 'running' });
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
          sendSse(res, 'done', { status: 'ready' });
          res.end();
          clearInterval(watcherInterval);
          clearInterval(pingInterval);
        } else if (job.status === 'error') {
          sendSse(res, 'error', { code: 'STREAM_FAILED', details: 'STREAM_FAILED' });
          res.end();
          clearInterval(watcherInterval);
          clearInterval(pingInterval);
        }
      }, 1000);

      return;
    }

    job.status = 'running';
    sendSse(res, 'info', { status: 'running' });

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

        job.css = cleanCss(cssText);
        sendSse(res, 'css', { css: job.css });
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

        let sectionHtml = cleanHtmlFragment(normalizeLlmHtml(sectionText));
        sectionHtml = stripStyleTags(sectionHtml);
        // опционально:
        sectionHtml = stripInlineStyleAttrs(sectionHtml);

        if (!isValidSection(sectionHtml, key)) {
          const repairPrompt = `
Исправь HTML так, чтобы он был строго:
<section id="${key}"> ... </section>

Запрещено: markdown/JSON, любые другие теги-обёртки.
Верни только исправленный HTML.
Исходник:
${sectionHtml}
`;

          const repairedText = await callLlm({
            system: `${job.renderSystem}\n\n${SECTION_SYSTEM_SUFFIX.replace('{ID}', key)}`,
            prompt: repairPrompt,
            temperature: 0.05,
            maxTokens: 1500,
          });

          sectionHtml = cleanHtmlFragment(normalizeLlmHtml(repairedText));
          sectionHtml = stripStyleTags(sectionHtml);
          // опционально:
          sectionHtml = stripInlineStyleAttrs(sectionHtml);

          if (!isValidSection(sectionHtml, key)) {
            failStream({
              message: 'LLM_SECTION_INVALID',
              details: JSON.stringify(sectionDiagnostics(sectionHtml, key)),
            });
            return;
          }
        }
        job.sections[key] = sectionHtml;
        sendSse(res, 'section', { id: key, html: sectionHtml });
      }
    } catch (err) {
      failStream(err);
      return;
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

    sendSse(res, 'done', { status: 'ready' });
    clearInterval(pingInterval);
    clearInterval(watcherInterval);
    if (canWrite(res)) res.end();
    return;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('HTML stream failed', e);
    if (job) {
      job.status = 'error';
    }
    if (streamStarted) {
      const looksLikeHtml = typeof e?.details === 'string' && /<[^>]+>/.test(e.details);
      const code = e?.message || 'STREAM_FAILED';
      const safeDetails =
        looksLikeHtml || typeof e?.details !== 'string'
          ? code
          : e.details.trim().slice(0, 200) || code;
      sendSse(res, 'error', { code, details: safeDetails });
      if (canWrite(res)) res.end();
      return;
    }

    return res
      .status(e?.status || 500)
      .json({ error: 'STREAM_FAILED', details: e?.details || e?.message || null });
  }
});

router.get('/result', (req, res) => {
  const { jobId } = req.query || {};
  const job = typeof jobId === 'string' ? jobs.get(jobId) : null;

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
  });
});

export default router;
