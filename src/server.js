import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import llmRouter from './routes/llm.js';
import htmlRouter from './routes/html.js';
import contentRouter from './routes/content.js';
import progressRouter from './routes/progress.js';
import purchasesRouter from './routes/purchases.js';
import paymentsRouter from './routes/payments.js';

const app = express();

const corsAllowlist = env.webOrigins.map((origin) => origin.trim());

const isAllowedOrigin = (origin) => {
  if (!origin) return true;

  const normalized = origin.trim();
  if (corsAllowlist.includes(normalized)) return true;

  // Always allow localhost so local dev ports like 3000/3001/5173 work even if NODE_ENV=production
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) return true;

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
api.use('/purchases', purchasesRouter);
api.use('/payments', paymentsRouter);
api.use('/lessons', llmRouter);
api.use('/v1/html', htmlRouter);
api.use('/', progressRouter);
api.use('/rest/v1', contentRouter);

app.use('/api', api);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Произошла ошибка. Попробуйте ещё раз.' });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${env.port}`);
});
