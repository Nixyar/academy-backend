import { Router } from 'express';
import { randomUUID } from 'crypto';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

const jobs = new Map(); // Map<jobId, { status, outline, css, sections, html }>

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

const canWrite = (res) => res && !res.writableEnded && !res.writableFinished && !res.destroyed;

const sendSse = (res, event, payload) => {
  if (!canWrite(res)) return;

  try {
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
  if (!outline) return [];

  if (Array.isArray(outline?.sections)) {
    return outline.sections.map((section, idx) => ({
      key: section?.id || section?.key || section?.name || `section_${idx + 1}`,
      spec: section,
    }));
  }

  if (Array.isArray(outline)) {
    return outline.map((section, idx) => ({
      key: section?.id || section?.key || section?.name || `section_${idx + 1}`,
      spec: section,
    }));
  }

  if (typeof outline === 'object') {
    return Object.entries(outline).map(([key, spec]) => ({ key, spec }));
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
    });

    const failStream = (err) => {
      const message = err?.details || err?.message || 'STREAM_FAILED';
      job.status = 'error';
      sendSse(res, 'error', message);
      if (canWrite(res)) res.end();
    };

    if (job.css) sendSse(res, 'css', job.css);
    if (job.sectionOrder?.length) {
      job.sectionOrder.forEach((key) => {
        if (job.sections[key]) {
          sendSse(res, `section:${key}`, job.sections[key]);
        }
      });
    }

    if (job.status === 'done') {
      sendSse(res, 'done', 'ready');
      return res.end();
    }

    job.status = 'running';

    try {
      if (!job.css) {
        const cssPrompt = [
          'Сгенерируй полный CSS для страницы по плану ниже.',
          'Верни только CSS, без markdown, без html и без тегов <style>.',
          'Учитывай пользовательский запрос:',
          job.prompt,
          'План (JSON):',
          JSON.stringify(job.outline),
        ].join('\n');

        const cssText = await callLlm({
          system: job.renderSystem,
          prompt: cssPrompt,
          temperature: 0.4,
          maxTokens: 2048,
        });

        job.css = cleanCss(cssText);
        sendSse(res, 'css', job.css);
      }

      const sectionsToGenerate = job.sectionOrder?.length
        ? job.sectionOrder.filter((key) => !job.sections[key])
        : [];

      for (const key of sectionsToGenerate) {
        if (aborted) return;

        const sectionSpec = job.sectionSpecs?.[key] ?? job.outline?.[key];
        const sectionPrompt = [
          `Сгенерируй HTML секцию "${key}" по плану ниже.`,
          'Верни только разметку секции без <html>, <head>, <body> и без стилей.',
          'Учитывай пользовательский запрос:',
          job.prompt,
          'План (JSON):',
          JSON.stringify(job.outline),
          'Детали секции:',
          JSON.stringify(sectionSpec ?? {}),
        ].join('\n');

        const sectionText = await callLlm({
          system: job.renderSystem,
          prompt: sectionPrompt,
          temperature: 0.35,
          maxTokens: 4096,
        });

        const sectionHtml = cleanHtmlFragment(sectionText);
        job.sections[key] = sectionHtml;
        sendSse(res, `section:${key}`, sectionHtml);
      }
    } catch (err) {
      failStream(err);
      return;
    }

    if (aborted) return;

    const assembledSections = (job.sectionOrder || Object.keys(job.sections)).map(
      (key) => job.sections[key] || '',
    );

    const finalHtml = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '<style>',
      job.css || '',
      '</style>',
      '</head>',
      '<body>',
      ...assembledSections,
      '</body>',
      '</html>',
    ].join('\n');

    job.html = finalHtml;
    job.status = 'done';

    sendSse(res, 'done', 'ready');
    return res.end();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('HTML stream failed', e);
    if (job) {
      job.status = 'error';
    }
    if (streamStarted) {
      sendSse(res, 'error', e?.details || e?.message || 'STREAM_FAILED');
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
