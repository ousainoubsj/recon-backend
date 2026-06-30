import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { reportsRouter } from './routes/reports.js';
import { authRateLimiter, apiRateLimiter } from './middleware/rateLimit.js';
import { AppError } from './errors.js';

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(cookieParser());
app.use(pinoHttp());

// Better Auth's own handler reads the raw body itself, so it's mounted
// before express.json() and gets its own (tighter) rate limit.
app.use('/api/auth', authRateLimiter, authRouter);

app.use(express.json());
app.use('/api', apiRateLimiter);
app.use('/api/files', filesRouter);
app.use('/api/reports', reportsRouter);

// Operational errors (AppError subclasses) -> RFC 7807. Anything else is a
// programmer error: logged, never leaked to the client, 500.
app.use((err, req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      type: err.type,
      title: err.name,
      status: err.status,
      detail: err.message,
      instance: req.originalUrl,
      ...(err.fieldErrors ? { errors: err.fieldErrors } : {}),
    });
  }

  req.log?.error(err);
  res.status(500).json({
    type: 'https://recon.app/errors/internal-error',
    title: 'InternalError',
    status: 500,
    detail: 'An unexpected error occurred',
    instance: req.originalUrl,
  });
});
