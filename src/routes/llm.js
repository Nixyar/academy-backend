import { Router } from 'express';
import env from '../config/env.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

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

    const data = await llmResponse.json();
    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

export default router;
