import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import env from './config/env.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import llmRouter from './routes/llm.js';
import lessonContentRouter from './routes/lessonContent.js';
import htmlRouter from './routes/html.js';
import contentRouter from './routes/content.js';
import progressRouter from './routes/progress.js';
import purchasesRouter from './routes/purchases.js';
import paymentsRouter, { startTbankPurchaseReconciler } from './routes/payments.js';
import coursesRouter from './routes/courses.js';
import feedbackRouter from './routes/feedback.js';

const app = express();

app.use(helmet({
  contentSecurityPolicy: false, // Отключен, т.к. фронт на отдельном домене
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
}));

const corsAllowlist = env.webOrigins.map((origin) => origin.trim());

const isAllowedOrigin = (origin) => {
  // В development разрешаем запросы без Origin (например, от прокси)
  if (!origin && env.nodeEnv === 'development') {
    return true;
  }

  if (!origin) return false; // Блокировать запросы без Origin в production

  const normalized = origin.trim();
  if (corsAllowlist.includes(normalized)) return true;

  // Разрешить localhost ТОЛЬКО в development
  if (env.nodeEnv === 'development') {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return true;
    }
  }

  return false;
};

const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    const err = new Error('Not allowed by CORS');
    err.status = 403;
    return callback(err);
  },
  credentials: true,
});

app.use((req, res, next) => corsMiddleware(req, res, (err) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(err.status || 403).json({
      error: 'CORS_NOT_ALLOWED',
      origin: req.headers.origin || null,
    });
  }

  return next(err);
}));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < env.slowLogMs) return;
    // eslint-disable-next-line no-console
    console.warn('[slow-request]', {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      ms: elapsed,
    });
  });
  next();
});
app.use(express.json());
app.use(cookieParser());

const api = express.Router();

api.get('/health', (req, res) => {
  res.json({ ok: true });
});

api.use('/auth', authRouter);
api.use('/me', meRouter);
api.use('/feedback', feedbackRouter);
api.use('/purchases', purchasesRouter);
api.use('/payments', paymentsRouter);
api.use('/lessons', lessonContentRouter);
api.use('/lessons', llmRouter);
api.use('/v1/html', htmlRouter);
api.use('/', progressRouter);
api.use('/courses', coursesRouter);
api.use('/rest/v1', contentRouter);

app.use('/api', api);

app.use((err, req, res, next) => {
  // Безопасное логирование без чувствительных данных
  // eslint-disable-next-line no-console
  console.error('[ERROR]', {
    message: err.message,
    stack: env.nodeEnv === 'production' ? undefined : err.stack,
    method: req.method,
    path: req.originalUrl || req.url,
    status: err.status || 500,
    // НЕ логируем: req.cookies, req.headers.authorization, req.body.password
  });

  res.status(err.status || 500).json({
    error: 'INTERNAL_ERROR',
    message: 'Произошла ошибка. Попробуйте ещё раз.'
  });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${env.port}`);
  startTbankPurchaseReconciler();
});
