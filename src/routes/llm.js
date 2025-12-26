import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

const extractHtmlFromLlmText = (text) => {
  if (typeof text !== 'string') return null;

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*json\s*\/?\s*/i, '')
    .trim();

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed.html === 'string') {
            return parsed.html;
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
};

router.post('/:lessonId/llm', async (req, res, next) => {
  try {
    const { lessonId } = req.params;
    const { prompt } = req.body || {};

    if (typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const { data: lesson, error: lessonError } = await supabaseAdmin
      .from('lessons')
      .select('id, llm_system_prompt')
      .eq('id', lessonId)
      .maybeSingle();

    if (lessonError) {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_LESSON' });
    }

    if (!lesson) {
      return res.status(404).json({ error: 'LESSON_NOT_FOUND' });
    }

    if (!lesson.llm_system_prompt || typeof lesson.llm_system_prompt !== 'string') {
      return res.status(400).json({ error: 'LESSON_LLM_SYSTEM_PROMPT_MISSING' });
    }

    const llmResponse = await fetch(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system: lesson.llm_system_prompt,
        temperature: 0.2,
        maxTokens: 1024,
      }),
    });

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => null);
      return res.status(502).json({
        error: 'LLM_REQUEST_FAILED',
        details: errorText || llmResponse.statusText,
      });
    }

    let llmPayload;
    try {
      llmPayload = await llmResponse.json();
    } catch {
      llmPayload = await llmResponse.text();
    }

    const llmText =
      (llmPayload && typeof llmPayload === 'object' && typeof llmPayload.text === 'string'
        ? llmPayload.text
        : null) || (typeof llmPayload === 'string' ? llmPayload : null);

    const html = extractHtmlFromLlmText(llmText);

    if (!html) {
      return res.status(502).json({
        error: 'LLM_PARSE_FAILED',
        details: typeof llmText === 'string' ? llmText.slice(0, 500) : undefined,
      });
    }

    return res.json({ html });
  } catch (error) {
    return next(error);
  }
});

export default router;
