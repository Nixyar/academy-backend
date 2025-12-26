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

  const tryParseHtml = (value) => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.html === 'string') {
        return parsed.html;
      }
    } catch {
      // fall through
    }
    return null;
  };

  const directParsed = tryParseHtml(cleaned);
  if (directParsed) return directParsed;

  const jsonMatch = cleaned.match(/\{[\s\S]*?"html"[\s\S]*?\}/);
  if (jsonMatch) {
    const parsed = tryParseHtml(jsonMatch[0]);
    if (parsed) return parsed;

    const htmlCapture = jsonMatch[0].match(/"html"\s*:\s*"([\s\S]*?)"/);
    if (htmlCapture) {
      return htmlCapture[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n');
    }
  }

  return cleaned.includes('<') ? cleaned : null;
};

const unwrapHtml = (value) => {
  let s = typeof value === 'string' ? value.trim() : '';
  for (let i = 0; i < 3; i += 1) {
    if (/<(!doctype|html)\b/i.test(s) || /<head\b/i.test(s) || /<body\b/i.test(s)) {
      return s;
    }

    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj.html === 'string') {
          s = obj.html.trim();
          continue;
        }
      } catch {
        // not JSON, stop unwrapping
      }
    }

    break;
  }
  return s;
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
        maxTokens: 8192,
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
    // Debug log for tracing upstream LLM responses
    // eslint-disable-next-line no-console
    console.log('[LLM] response', { lessonId, payload: llmPayload });

    const directHtml = llmPayload && typeof llmPayload === 'object' && typeof llmPayload.html === 'string'
      ? llmPayload.html
      : null;

    const llmText =
      (llmPayload && typeof llmPayload === 'object' && typeof llmPayload.text === 'string'
        ? llmPayload.text
        : null) || (typeof llmPayload === 'string' ? llmPayload : null);

    let html = extractHtmlFromLlmText(directHtml) || extractHtmlFromLlmText(llmText);

    if (typeof html === 'string') {
      html = unwrapHtml(html);
    }

    if (!html) {
      return res.status(502).json({
        error: 'LLM_PARSE_FAILED',
        details: typeof llmText === 'string' ? llmText.slice(0, 500) : undefined,
      });
    }

    if (!/<(!doctype|html)\b/i.test(html)) {
      return res.status(502).json({
        error: 'LLM_RETURNED_NON_HTML',
        details: html.slice(0, 500),
      });
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    return next(error);
  }
});

export default router;
