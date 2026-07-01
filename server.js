import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { reportsRouter } from './routes/reports.js';
import { auditLogsRouter } from './routes/auditLogs.js';
import { authRateLimiter, apiRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';

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
app.use('/api/audit-logs', auditLogsRouter);

app.use(errorHandler);
