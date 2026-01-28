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

const parseGenericText = (payload) => {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();

  // OpenAI-like response
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();

  return '';
};

const buildCombinedPrompt = ({ system, prompt }) => {
  const sys = typeof system === 'string' ? system.trim() : '';
  const usr = typeof prompt === 'string' ? prompt.trim() : '';
  if (!sys) return usr;
  if (!usr) return sys;
  // Gateway expects a single plain-text input (like curl example).
  return `${sys}\n\n${usr}`;
};

class LlmRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LlmRequestError';
    this.details = details;
    this.status = details?.status || 502;
  }
}

const shouldUseGateway = () => !env.llmApiUrlIsDefault || Boolean(env.llmGatewayToken);

export async function llmGenerateText(
  { system, prompt, temperature, maxTokens },
  { name = 'llm', timeoutMs = null, slowMs = null, logger = null } = {},
) {
  const combined = buildCombinedPrompt({ system, prompt });

  const generationConfig = {};
  const t = toFiniteOrNull(temperature);
  const mt = toFiniteOrNull(maxTokens);
  if (t != null) generationConfig.temperature = t;
  if (mt != null) generationConfig.maxOutputTokens = Math.max(1, Math.floor(mt));

  let url;
  let headers;
  let body;
  let provider;

  if (shouldUseGateway()) {
    url = env.llmApiUrl;
    provider = 'gateway';
    headers = {
      'Content-Type': 'application/json',
      ...(env.llmGatewayToken ? { 'X-Gateway-Token': env.llmGatewayToken } : {}),
    };
    body = JSON.stringify({
      contents: [{ parts: [{ text: combined }]}],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    });
  } else {
    if (!env.geminiApiKey) {
      throw new LlmRequestError('LLM_GEMINI_API_KEY_MISSING', { status: 500 });
    }

    provider = 'gemini';
    const model = env.geminiModel || 'gemini-2.5-flash';
    url = `${env.geminiApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.geminiApiKey,
    };
    body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: combined }]}],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    });
  }

  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body,
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
      provider,
    });
  }

  const payload = await resp.json().catch(() => null);
  const text = parseGeminiText(payload) || parseGenericText(payload);
  if (text) return String(text).trim();
  return JSON.stringify(payload ?? {});
}
