import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';
import { AuthenticationError } from '../errors.js';

export async function authenticate(req, res, next) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return next(new AuthenticationError());
  req.session = session;
  next();
}
