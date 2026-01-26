import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { Semaphore } from '../lib/semaphore.js';
import { sendApiError } from '../lib/publicErrors.js';
import { llmGenerateText } from '../lib/llmGenerateText.js';

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
      return sendApiError(res, 400, 'INVALID_REQUEST');
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

    const { data: prompts, error } = await supabaseAdmin
      .from('lesson_llm_prompts')
      .select('llm_system_prompt,llm_plan_system_prompt,llm_render_system_prompt')
      .eq('lesson_id', lessonId)
      .single();

    if (error) return sendApiError(res, 500, 'INTERNAL_ERROR');
    if (!prompts) return sendApiError(res, 404, 'LESSON_NOT_FOUND');

    const fallbackSystem = prompts.llm_system_prompt ?? null;
    const planSystem = prompts.llm_plan_system_prompt ?? fallbackSystem;
    const renderSystem = prompts.llm_render_system_prompt ?? fallbackSystem;

    const normalizedPlan = typeof planSystem === 'string' ? planSystem.trim() : '';
    const normalizedRender = typeof renderSystem === 'string' ? renderSystem.trim() : '';

    if (!normalizedPlan) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }
    if (!normalizedRender) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }

    // Plan request
    let planText;
    try {
      planText = await llmSemaphore.run(() =>
        llmGenerateText(
          {
            system: context + normalizedPlan,
            prompt: prompt.trim(),
            temperature: 0.6,
            maxTokens: 4096,
          },
          {
            name: 'llm-plan',
            slowMs: env.externalSlowLogMs,
            logger: (event, data) => console.warn(`[${event}]`, data),
          },
        ));
    } catch (e) {
      return res.status(502).json({
        error: 'LLM_PLAN_REQUEST_FAILED',
        details:
          e && typeof e === 'object' && 'details' in e && e.details != null
            ? e.details
            : (e instanceof Error ? e.message : String(e)),
      });
    }

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

    let htmlText;
    try {
      htmlText = await llmSemaphore.run(() =>
        llmGenerateText(
          {
            system: normalizedRender,
            prompt: renderPrompt,
            temperature: 0.3,
            maxTokens: 8192,
          },
          {
            name: 'llm-render',
            slowMs: env.externalSlowLogMs,
            logger: (event, data) => console.warn(`[${event}]`, data),
          },
        ));
    } catch (e) {
      return res.status(502).json({
        error: 'LLM_RENDER_REQUEST_FAILED',
        details:
          e && typeof e === 'object' && 'details' in e && e.details != null
            ? e.details
            : (e instanceof Error ? e.message : String(e)),
      });
    }

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
