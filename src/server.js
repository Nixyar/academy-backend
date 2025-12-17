import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';

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

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRouter);
app.use('/me', meRouter);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${env.port}`);
});
