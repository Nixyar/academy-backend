import supabaseAdmin from './supabaseAdmin.js';

const normalizeId = (value) => String(value || '').trim();

// Backend-side cache to reduce database load
const QUOTA_CACHE_TTL_MS = 3000; // 3 seconds
const quotaCache = new Map();
const inFlightQueries = new Map();

function getCacheKey(userId, courseId) {
  return `${userId}:${courseId}`;
}

const isMissingColumnError = (error, columnName) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return (
    message.includes(`column \"${columnName}\"`) ||
    message.includes(`column '${columnName}'`) ||
    message.includes(`column ${columnName}`) ||
    /does not exist|schema cache|could not find|not found/i.test(message)
  );
};

const isMissingTableError = (error, tableName) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const name = String(tableName || '').trim();
  if (!name) return false;
  return (
    code === '42P01' ||
    message.includes(`relation \"${name}\" does not exist`) ||
    message.includes(`relation '${name}' does not exist`) ||
    message.includes(`relation ${name} does not exist`) ||
    message.includes(`Could not find the '${name}' table`) ||
    message.includes(`could not find the '${name}' table`)
  );
};

const isMissingFieldError = (error, fieldName) => {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const name = String(fieldName || '').trim();
  if (!name) return false;
  return (
    message.includes(`column \"${name}\"`) ||
    message.includes(`column '${name}'`) ||
    message.includes(`column ${name}`) ||
    /does not exist|schema cache|could not find|not found/i.test(message)
  );
};

const toIntOrNull = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
};

const computeRemaining = (limit, used) => {
  if (limit == null) return null;
  const safeLimit = Math.max(0, limit);
  const safeUsed = Math.max(0, used ?? 0);
  return Math.max(0, safeLimit - safeUsed);
};

async function fetchCourseLimit(courseId) {
  const id = normalizeId(courseId);
  if (!id) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });

  const result = await supabaseAdmin.from('courses').select('id,llm_limit').eq('id', id).maybeSingle();
  if (result.error) {
    if (isMissingColumnError(result.error, 'llm_limit')) {
      return { courseId: id, limit: null };
    }
    throw Object.assign(new Error('FAILED_TO_FETCH_COURSE_LIMIT'), { status: 500, details: result.error });
  }
  if (!result.data) throw Object.assign(new Error('COURSE_NOT_FOUND'), { status: 404 });

  const rawLimit = toIntOrNull(result.data.llm_limit);
  const limit = rawLimit != null && rawLimit > 0 ? rawLimit : null;
  return { courseId: id, limit };
}

async function fetchQuotaRow(userId, courseId) {
  const uid = normalizeId(userId);
  const cid = normalizeId(courseId);
  if (!uid || !cid) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });

  const baseQuery = (selectFields) =>
    supabaseAdmin
      .from('llm_course_quota')
      .select(selectFields)
      .eq('user_id', uid)
      .eq('course_id', cid)
      .maybeSingle();

  let result = await baseQuery('user_id,course_id,used,limit,updated_at');
  if (result.error && isMissingFieldError(result.error, 'limit')) {
    // Back-compat: older deployments may not have a per-row `limit` column.
    result = await baseQuery('user_id,course_id,used,updated_at');
  }

  if (result.error) {
    if (isMissingTableError(result.error, 'llm_course_quota')) {
      throw Object.assign(new Error('COURSE_QUOTA_NOT_CONFIGURED'), { status: 503, details: result.error });
    }
    throw Object.assign(new Error('FAILED_TO_FETCH_COURSE_QUOTA'), { status: 500, details: result.error });
  }

  if (!result.data) return null;

  return {
    user_id: uid,
    course_id: cid,
    used: toIntOrNull(result.data.used) ?? 0,
    limit: 'limit' in result.data ? toIntOrNull(result.data.limit) : null,
    updated_at: result.data.updated_at,
  };
}

async function ensureQuotaRow(userId, courseId, limit) {
  const uid = normalizeId(userId);
  const cid = normalizeId(courseId);
  if (!uid || !cid) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });

  // Сначала пытаемся получить существующую запись
  const existing = await fetchQuotaRow(uid, cid);

  if (!existing) {
    // Записи нет - создаем новую с used: 0
    const nowIso = new Date().toISOString();
    const payloadBase = {
      user_id: uid,
      course_id: cid,
      used: 0,
      updated_at: nowIso,
    };

    let insert = await supabaseAdmin
      .from('llm_course_quota')
      .insert({ ...payloadBase, limit: limit == null ? null : Math.max(0, limit) });

    if (insert.error && isMissingFieldError(insert.error, 'limit')) {
      insert = await supabaseAdmin.from('llm_course_quota').insert(payloadBase);
    }

    if (insert.error) {
      throw Object.assign(new Error('FAILED_TO_CREATE_COURSE_QUOTA'), { status: 500, details: insert.error });
    }

    // Возвращаем свежесозданную запись
    const row = await fetchQuotaRow(uid, cid);
    if (!row) throw Object.assign(new Error('FAILED_TO_FETCH_COURSE_QUOTA'), { status: 500 });
    return row;
  }

  // Запись существует - обновляем только limit, если нужно (НЕ трогаем used!)
  if (limit != null && existing.limit != null && existing.limit !== limit) {
    const nowIsoUpdate = new Date().toISOString();
    const update = await supabaseAdmin
      .from('llm_course_quota')
      .update({ limit, updated_at: nowIsoUpdate })
      .eq('user_id', uid)
      .eq('course_id', cid);

    if (update.error && !isMissingFieldError(update.error, 'limit')) {
      throw Object.assign(new Error('FAILED_TO_UPDATE_COURSE_QUOTA'), { status: 500, details: update.error });
    }

    // После обновления получаем свежую запись
    const row = await fetchQuotaRow(uid, cid);
    if (!row) throw Object.assign(new Error('FAILED_TO_FETCH_COURSE_QUOTA'), { status: 500 });
    return row;
  }

  // Запись существует и limit не изменился - возвращаем как есть
  return existing;
}

async function getCourseQuotaUncached({ userId, courseId }) {
  const uid = normalizeId(userId);
  const cid = normalizeId(courseId);
  if (!uid || !cid) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });

  const { limit } = await fetchCourseLimit(cid);

  // Unlimited courses don't need persistent quota rows.
  if (limit == null) {
    return { userId: uid, courseId: cid, limit: null, used: 0, remaining: null };
  }

  const row = await ensureQuotaRow(uid, cid, limit);
  const used = Math.max(0, row.used ?? 0);
  const effectiveLimit = limit;
  return {
    userId: uid,
    courseId: cid,
    limit: effectiveLimit,
    used,
    remaining: computeRemaining(effectiveLimit, used),
  };
}

export async function getCourseQuota({ userId, courseId }) {
  const uid = normalizeId(userId);
  const cid = normalizeId(courseId);
  const cacheKey = getCacheKey(uid, cid);

  // Check cache
  const cached = quotaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Deduplicate concurrent requests
  const existingPromise = inFlightQueries.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = (async () => {
    try {
      const result = await getCourseQuotaUncached({ userId: uid, courseId: cid });
      quotaCache.set(cacheKey, { expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, value: result });
      return result;
    } finally {
      if (inFlightQueries.get(cacheKey) === promise) {
        inFlightQueries.delete(cacheKey);
      }
    }
  })();

  inFlightQueries.set(cacheKey, promise);
  return promise;
}

export async function consumeCourseQuota({ userId, courseId, amount = 1 }) {
  const uid = normalizeId(userId);
  const cid = normalizeId(courseId);
  const delta = Math.max(1, toIntOrNull(amount) ?? 1);
  if (!uid || !cid) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });

  const quota = await getCourseQuota({ userId: uid, courseId: cid });
  if (quota.limit == null) return quota;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const row = await fetchQuotaRow(uid, cid);
    if (!row) {
      // Row disappeared; recreate and retry.
      await ensureQuotaRow(uid, cid, quota.limit);
      continue;
    }

    const used = Math.max(0, row.used ?? 0);
    const limit = quota.limit;
    const remaining = computeRemaining(limit, used);
    if (remaining != null && remaining < delta) {
      throw Object.assign(new Error('COURSE_QUOTA_EXCEEDED'), {
        status: 429,
        details: { remaining, limit, used },
      });
    }

    const nowIso = new Date().toISOString();
    const update = await supabaseAdmin
      .from('llm_course_quota')
      .update({ used: used + delta, updated_at: nowIso })
      .eq('user_id', uid)
      .eq('course_id', cid)
      .eq('used', used)
      .select('used')
      .maybeSingle();

    if (update.error) {
      throw Object.assign(new Error('FAILED_TO_CONSUME_COURSE_QUOTA'), { status: 500, details: update.error });
    }

    // Another concurrent request updated the row; retry.
    if (!update.data) continue;

    const nextUsed = toIntOrNull(update.data.used) ?? used + delta;
    const result = {
      userId: uid,
      courseId: cid,
      limit,
      used: nextUsed,
      remaining: computeRemaining(limit, nextUsed),
    };

    // Invalidate cache after consuming quota
    const cacheKey = getCacheKey(uid, cid);
    quotaCache.delete(cacheKey);

    return result;
  }

  throw Object.assign(new Error('COURSE_QUOTA_CONFLICT'), { status: 409 });
}
