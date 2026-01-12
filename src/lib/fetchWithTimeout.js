const nowMs = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
};

const normalizeUrlForLog = (input) => {
  try {
    const url = new URL(String(input));
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return String(input);
  }
};

const forwardAbortSignal = (upstreamSignal, controller) => {
  const onAbort = () => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) onAbort();
    else upstreamSignal.addEventListener('abort', onAbort, { once: true });
  }

  return () => {
    try {
      upstreamSignal?.removeEventListener?.('abort', onAbort);
    } catch {
      // ignore
    }
  };
};

export async function fetchWithTimeout(url, init = {}, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null;
  const slowMs = typeof opts.slowMs === 'number' && Number.isFinite(opts.slowMs) ? opts.slowMs : null;
  const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : 'fetch';
  const logger = typeof opts.logger === 'function' ? opts.logger : null;

  const controller = new AbortController();
  const cleanupSignals = forwardAbortSignal(init.signal, controller);

  let timeoutId = null;
  if (timeoutMs != null && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      try {
        controller.abort(new Error(`timeout ${timeoutMs}ms`));
      } catch {
        controller.abort();
      }
    }, timeoutMs);
  }

  const startedAt = nowMs();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const elapsedMs = nowMs() - startedAt;
    if (slowMs != null && elapsedMs >= slowMs && logger) {
      logger('slow-external', {
        name,
        ms: Math.round(elapsedMs),
        url: normalizeUrlForLog(url),
        method: init?.method || 'GET',
        status: response.status,
      });
    }
    return response;
  } catch (error) {
    const elapsedMs = nowMs() - startedAt;
    if (logger) {
      const isAbort =
        error && typeof error === 'object' && ('name' in error ? error.name === 'AbortError' : false);
      logger(isAbort ? 'aborted-external' : 'failed-external', {
        name,
        ms: Math.round(elapsedMs),
        url: normalizeUrlForLog(url),
        method: init?.method || 'GET',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    cleanupSignals();
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createTimedFetch(timeoutMs, defaults = {}) {
  return (url, init = {}) =>
    fetchWithTimeout(url, init, { ...defaults, timeoutMs });
}
