import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';
import { AccessBlockedError, AuthenticationError } from '../errors.js';
import { touchLastActive } from '../services/organizationService.js';
import { catchAsync } from '../utils/catchAsync.js';

// Wrapped here, not at each route: every route mounts it bare, and Express 4 would leave a rejected getSession unhandled.
export const authenticate = catchAsync(async (req, res, next) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return next(new AuthenticationError());
  // Their sessions are deleted when suspended or removed; this covers any request already in flight.
  // A suspended company's members are refused in getUserMembership instead, with no extra query here.
  if (session.user.platformRole && session.user.platformStatus !== 'active') {
    return next(new AccessBlockedError('Platform access has been revoked', 'platform-access-revoked'));
  }
  req.session = session;
  await touchLastActive(session.user.id);
  next();
});
