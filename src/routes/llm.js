import { Router } from 'express';
import env from '../config/env.js';

const router = Router();

router.post('/generate', async (req, res, next) => {
  try {
    const { prompt, system } = req.body || {};

    if (typeof prompt !== 'string' || typeof system !== 'string') {
      return res.status(400).json({ error: 'prompt and system are required' });
    }

    const llmResponse = await fetch(env.llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system,
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
