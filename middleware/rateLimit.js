import rateLimit from 'express-rate-limit';

// Auth routes: 10 req/min. API routes: 200 req/min per IP (Section 5.2).
export const authRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10 });
export const apiRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 200 });
