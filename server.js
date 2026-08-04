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
import { supportRouter } from './routes/support.js';
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

// Browsers that signed in before COOKIE_DOMAIN/crossSubDomainCookies was
// enabled are stuck holding a host-only cookie (Domain=api.recon-cil.com)
// alongside every new shared-domain one (Domain=.recon-cil.com) that
// sign-in creates from now on. Both get sent on every request under the
// same name — the `cookie` package keeps only the first (oldest-created,
// per RFC 6265 ordering) value and silently drops the rest, so Better
// Auth deterministically reads the dead host-only token, fails its DB
// lookup, and clears the *working* shared-domain cookie as collateral.
// Its own cleanup can't reach the host-only one since Domain scopes them
// as different cookies — so it never self-heals without this.
const LEGACY_AUTH_COOKIES = [
  '__Secure-better-auth.session_token',
  '__Secure-better-auth.session_data',
  '__Secure-better-auth.dont_remember',
];
app.use('/api/auth', (req, res, next) => {
  const counts = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    const name = pair.slice(0, i).trim();
    counts[name] = (counts[name] || 0) + 1;
  }
  for (const name of LEGACY_AUTH_COOKIES) {
    if (counts[name] > 1) {
      res.cookie(name, '', { maxAge: 0, path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
    }
  }
  next();
});

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
app.use('/api/support', supportRouter);
app.use('/api/team', teamRouter);
app.use('/api/settings', settingsRouter);

app.use(errorHandler);
