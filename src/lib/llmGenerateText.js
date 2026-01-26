import env from '../config/env.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';

const toFiniteOrNull = (value) => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const parseGeminiText = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const first = candidates[0];
  const parts = Array.isArray(first?.content?.parts) ? first.content.parts : [];
  const text = parts
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('');
  return String(text || '').trim();
};

const buildCombinedPrompt = ({ system, prompt }) => {
  const sys = typeof system === 'string' ? system.trim() : '';
  const usr = typeof prompt === 'string' ? prompt.trim() : '';
  if (!sys) return usr;
  if (!usr) return sys;
  return `${sys}\n\nUSER:\n${usr}`;
};

class LlmRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LlmRequestError';
    this.details = details;
    this.status = details?.status || 502;
  }
}

export async function llmGenerateText(
  { system, prompt, temperature, maxTokens },
  { name = 'llm', timeoutMs = null, slowMs = null, logger = null } = {},
) {
  if (!env.geminiApiKey) {
    throw new LlmRequestError('LLM_GEMINI_API_KEY_MISSING', { status: 500 });
  }

  const model = env.geminiModel || 'gemini-2.5-flash';
  const url = `${env.geminiApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const combined = buildCombinedPrompt({ system, prompt });

  const generationConfig = {};
  const t = toFiniteOrNull(temperature);
  const mt = toFiniteOrNull(maxTokens);
  if (t != null) generationConfig.temperature = t;
  if (mt != null) generationConfig.maxOutputTokens = Math.max(1, Math.floor(mt));

  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: combined }]}],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }),
    },
    { name, timeoutMs, slowMs, logger },
  );

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '');
    throw new LlmRequestError('LLM_REQUEST_FAILED', {
      status: resp.status,
      statusText: resp.statusText,
      contentType: resp.headers.get('content-type') || '',
      body: String(errorText || '').slice(0, 2000),
      provider: 'gemini',
    });
  }

  const payload = await resp.json().catch(() => null);
  const text = parseGeminiText(payload);
  if (text) return text;
  return JSON.stringify(payload ?? {});
}
