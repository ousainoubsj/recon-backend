import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { reportsRouter } from './routes/reports.js';
import { reportTemplatesRouter } from './routes/reportTemplates.js';
import { matchRuleTemplatesRouter } from './routes/matchRuleTemplates.js';
import { auditLogsRouter } from './routes/auditLogs.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter } from './routes/search.js';
import { teamRouter } from './routes/team.js';
import { settingsRouter } from './routes/settings.js';
import { authRateLimiter, apiRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';

export const app = express();

// Sits behind a reverse proxy (nginx) in production — trust its
// X-Forwarded-For so req.ip and express-rate-limit see the real client IP
// instead of the proxy's.
app.set('trust proxy', 1);

// Google Search Console site-verification file — must stay reachable at
// this exact path indefinitely, even after verification succeeds.
app.get('/google311a0ff38634ffd8.html', (_req, res) => {
  res.type('text/html').send('google-site-verification: google311a0ff38634ffd8.html');
});

// Frontend and backend are separate subdomains of the same site
// (recon-cil.com / api.recon-cil.com), so Helmet's default same-origin
// CORP header blocks cross-subdomain fetches in Chrome (not enforced as
// strictly by Safari) — relax it to same-site.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
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
app.use('/api/report-templates', reportTemplatesRouter);
app.use('/api/match-rule-templates', matchRuleTemplatesRouter);
app.use('/api/audit-logs', auditLogsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/team', teamRouter);
app.use('/api/settings', settingsRouter);

app.use(errorHandler);
