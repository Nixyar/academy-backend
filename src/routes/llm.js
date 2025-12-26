import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

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
    const { prompt } = req.body || {};

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const { data: lesson, error: lessonError } = await supabaseAdmin
      .from('lessons')
      .select('id, llm_plan_system_prompt, llm_render_system_prompt')
      .eq('id', lessonId)
      .maybeSingle();

    if (lessonError) return res.status(500).json({ error: 'FAILED_TO_FETCH_LESSON' });
    if (!lesson) return res.status(404).json({ error: 'LESSON_NOT_FOUND' });

    const planSystem = lesson.llm_plan_system_prompt;
    const renderSystem = lesson.llm_render_system_prompt;

    if (typeof planSystem !== 'string' || !planSystem.trim()) {
      return res.status(400).json({ error: 'LESSON_LLM_PLAN_SYSTEM_PROMPT_MISSING' });
    }
    if (typeof renderSystem !== 'string' || !renderSystem.trim()) {
      return res.status(400).json({ error: 'LESSON_LLM_RENDER_SYSTEM_PROMPT_MISSING' });
    }

    const planResp = await fetch(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: planSystem,
        prompt: prompt.trim(),
        temperature: 0.6,
        maxTokens: 1200,
      }),
    });

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

    const renderPrompt = `Сгенерируй HTML по этому плану. План (JSON):\n${JSON.stringify(planObj)}`;

    const htmlResp = await fetch(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: renderSystem,
        prompt: renderPrompt,
        temperature: 0.3,
        maxTokens: 4096,
      }),
    });

    if (!htmlResp.ok) {
      const errorText = await htmlResp.text().catch(() => null);
      return res.status(502).json({
        error: 'LLM_RENDER_REQUEST_FAILED',
        details: errorText || htmlResp.statusText,
      });
    }

    const htmlPayload = await htmlResp.json().catch(async () => ({ text: await htmlResp.text() }));
    const directHtml = typeof htmlPayload?.html === 'string' ? htmlPayload.html : null;
    const htmlText = typeof htmlPayload?.text === 'string' ? htmlPayload.text : null;

    const htmlObj = directHtml ? { html: directHtml } : extractFirstJsonObject(htmlText);
    const html = typeof htmlObj?.html === 'string' ? htmlObj.html : null;

    if (!html || !html.includes('</html>')) {
      return res.status(502).json({
        error: 'LLM_RENDER_PARSE_FAILED',
        details: stripFences(String(htmlText || directHtml || '')).slice(0, 800),
      });
    }

    return res.json({ html, plan: planObj });
  } catch (e) {
    return next(e);
  }
});

export default router;
