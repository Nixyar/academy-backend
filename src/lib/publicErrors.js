import env from '../config/env.js';

const DEFAULT_MESSAGE = 'Произошла ошибка. Попробуйте ещё раз.';

const messages = {
  UNAUTHORIZED: 'Нужно войти в аккаунт.',
  FORBIDDEN: 'Недостаточно прав для выполнения действия.',

  INVALID_MODE: 'Некорректный режим операции.',
  INVALID_REQUEST: 'Некорректный запрос. Перезагрузите страницу и попробуйте ещё раз.',
  INVALID_PATCH: 'Некорректные данные запроса.',
  INVALID_PROGRESS: 'Некорректные данные прогресса.',
  COURSE_ID_MISMATCH: 'Некорректный запрос. Перезагрузите страницу и попробуйте ещё раз.',
  FAILED_TO_SAVE_LESSON_PROMPT: 'Не удалось сохранить запрос. Попробуйте ещё раз.',

  FAILED_TO_FETCH_PROGRESS: 'Не удалось загрузить прогресс. Попробуйте ещё раз.',
  FAILED_TO_SAVE_PROGRESS: 'Не удалось сохранить прогресс. Попробуйте ещё раз.',
  FAILED_TO_FETCH_LESSONS: 'Не удалось загрузить уроки. Попробуйте ещё раз.',
  FAILED_TO_FETCH_COURSES: 'Не удалось загрузить курсы. Попробуйте ещё раз.',

  DATABASE_TIMEOUT: 'Сервер долго отвечает. Попробуйте ещё раз.',
  DATABASE_ERROR: 'Ошибка сервера при обращении к базе. Попробуйте ещё раз.',

  PAYMENTS_NOT_CONFIGURED: 'Оплата временно недоступна. Попробуйте позже.',
  PAYMENT_PROVIDER_ERROR: 'Платёжный сервис сейчас недоступен. Попробуйте позже.',
  COURSE_NOT_FOUND: 'Курс не найден.',
  PURCHASE_NOT_FOUND: 'Платёж не найден.',

  JOB_NOT_FOUND: 'Задача не найдена. Попробуйте перезапустить.',
  NO_INDEX_HTML: 'Сначала сгенерируйте сайт, затем попробуйте ещё раз.',

  LLM_REQUEST_FAILED: 'Не удалось выполнить запрос к AI. Попробуйте ещё раз.',
  LLM_PLAN_PARSE_FAILED: 'Не удалось обработать ответ AI. Попробуйте ещё раз.',
  LLM_PLAN_NO_SECTIONS: 'AI вернул некорректный план. Попробуйте переформулировать запрос.',
  LLM_INVALID_HTML: 'AI вернул некорректный результат. Попробуйте ещё раз.',
  LLM_HTML_TOO_LARGE: 'Результат слишком большой. Попробуйте упростить запрос.',
};

export const getPublicMessage = (code) => {
  const key = typeof code === 'string' ? code : '';
  return messages[key] || DEFAULT_MESSAGE;
};

export const toPublicError = (input) => {
  const code =
    input && typeof input === 'object' && typeof input.error === 'string' && input.error.trim()
      ? input.error.trim()
      : 'INTERNAL_ERROR';

  const message =
    input && typeof input === 'object' && typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : getPublicMessage(code);

  const details =
    env.nodeEnv !== 'production' && input && typeof input === 'object' && 'details' in input
      ? input.details
      : undefined;

  return {
    error: code,
    message,
    ...(details !== undefined ? { details } : {}),
  };
};

export const sendApiError = (res, status, code, opts = {}) => {
  const payload = toPublicError({
    error: code,
    message: opts.message,
    details: opts.details,
  });
  return res.status(status).json(payload);
};
