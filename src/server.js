import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import llmRouter from './routes/llm.js';
import contentRouter from './routes/content.js';
import progressRouter from './routes/progress.js';

const app = express();

const corsAllowlist = env.webOrigins.map((origin) => origin.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.trim();

    if (corsAllowlist.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

const api = express.Router();

api.get('/health', (req, res) => {
  res.json({ ok: true });
});

api.use('/auth', authRouter);
api.use('/me', meRouter);
api.use('/llm', llmRouter);
api.use('/', progressRouter);
api.use('/rest/v1', contentRouter);

app.use('/api', api);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${env.port}`);
});
