import { Router } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../auth.js';

export const authRouter = Router();

// toNodeHandler builds Better Auth's internal Request from the raw HTTP
// headers only — it never sees Express's own req.ip (which already resolves
// the real client address whether or not a reverse proxy is present). Fill
// x-forwarded-for from req.ip before handing off, so orgAuditHookService.js's
// extractIp() has something to read; a genuine proxy-supplied header (in
// front of this server, not this one) still wins since it's only set here
// when absent.
authRouter.all(
  '/*',
  (req, res, next) => {
    if (!req.headers['x-forwarded-for']) {
      req.headers['x-forwarded-for'] = req.ip;
    }
    next();
  },
  toNodeHandler(auth),
);
