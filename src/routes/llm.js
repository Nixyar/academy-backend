import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { Semaphore } from '../lib/semaphore.js';

const router = Router();
const llmSemaphore = new Semaphore(env.llmMaxConcurrency);

const stripFences = (s) =>
  String(s || '')
    .replace(/```json/gi, '')
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

router.post('/:lessonId/llm', async (req, res, next) => {
  try {
    const { lessonId } = req.params;
    const { prompt, mode, target_file, files } = req.body || {};

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // --- REZ: Context Injection ---
    const fileList = Object.keys(files || {}).join(', ');
    const currentCode = (files && target_file) ? files[target_file] : null;

    let context = `
=== CONTEXT ===
Existing files: ${fileList || 'None'}
`;

    if (currentCode) {
      context += `
CURRENT CODE OF FILE "${target_file}":
${currentCode}
`;
    }
    context += `=================\n`;

    const multiFileInstruction = `
CRITICAL: You must return a JSON object where keys are filenames and values are the full updated HTML code.
Example: { "index.html": "<!DOCTYPE html>...", "about.html": "<!DOCTYPE html>..." }
If you need to update a file, include its full new content.
If you need to create a new file, include it too.
`;
    // ----------------------------

    const { data: lesson, error: lessonError } = await supabaseAdmin
      .from('lessons')
      .select('*')
      .eq('id', lessonId)
      .maybeSingle();

    if (lessonError) {
      return res.status(500).json({
        error: 'FAILED_TO_FETCH_LESSON',
        details: lessonError.message,
      });
    }
    if (!lesson) return res.status(404).json({ error: 'LESSON_NOT_FOUND' });

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
      return res.status(400).json({ error: 'LESSON_LLM_PLAN_SYSTEM_PROMPT_MISSING' });
    }
    if (!normalizedRender) {
      return res.status(400).json({ error: 'LESSON_LLM_RENDER_SYSTEM_PROMPT_MISSING' });
    }

    // Plan request
    const planResp = await llmSemaphore.run(() => fetchWithTimeout(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: context + normalizedPlan,
        prompt: prompt.trim(),
        temperature: 0.6,
        maxTokens: 4096,
      }),
    }, {
      name: 'llm-plan',
      timeoutMs: env.llmTimeoutMs,
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    }));

    if (!planResp.ok) {
      const errorText = await planResp.text().catch(() => null);
      return res.status(502).json({
        error: 'LLM_PLAN_REQUEST_FAILED',
        details: errorText || planResp.statusText,
      });
    }

    const planPayload = await planResp.json().catch(async () => ({ text: await planResp.text() }));
    const planText = typeof planPayload?.text === 'string' ? planPayload.text : String(planPayload || '');
    const planObj = extractFirstJsonObject(planText);

    if (!planObj || typeof planObj !== 'object') {
      return res.status(502).json({
        error: 'LLM_PLAN_PARSE_FAILED',
        details: stripFences(planText).slice(0, 800),
      });
    }

    const renderPrompt = `Сгенерируй код файлов по плану.
${context}
План (JSON):
${JSON.stringify(planObj)}

${multiFileInstruction}`;

    const htmlResp = await llmSemaphore.run(() => fetchWithTimeout(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: normalizedRender,
        prompt: renderPrompt,
        temperature: 0.3,
        maxTokens: 8192,
      }),
    }, {
      name: 'llm-render',
      timeoutMs: env.llmTimeoutMs,
      slowMs: env.externalSlowLogMs,
      logger: (event, data) => console.warn(`[${event}]`, data),
    }));

    if (!htmlResp.ok) {
      const errorText = await htmlResp.text().catch(() => null);
      return res.status(502).json({
        error: 'LLM_RENDER_REQUEST_FAILED',
        details: errorText || htmlResp.statusText,
      });
    }

    const htmlPayload = await htmlResp.json().catch(async () => ({ text: await htmlResp.text() }));
    const htmlText = typeof htmlPayload?.text === 'string' ? htmlPayload.text : (typeof htmlPayload === 'string' ? htmlPayload : JSON.stringify(htmlPayload));

    const filesObj = extractFirstJsonObject(htmlText);

    if (!filesObj || typeof filesObj !== 'object') {
      return res.status(502).json({
        error: 'LLM_RENDER_PARSE_FAILED',
        details: stripFences(String(htmlText || '')).slice(0, 800),
      });
    }

    return res.json({ files: filesObj, plan: planObj });
  } catch (e) {
    return next(e);
  }
});

export default router;
