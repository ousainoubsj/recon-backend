import { Router } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../auth.js';

export const authRouter = Router();

// Better Auth catch-all — handles /sign-up/email, /sign-in/email,
// /sign-out, /get-session, etc. Mounted under /api/auth in app.js.
authRouter.all('/*', toNodeHandler(auth));
