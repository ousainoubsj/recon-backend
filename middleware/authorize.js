import { getUserMembership } from '../services/organizationService.js';
import { hasPermission } from '../services/permissions.js';
import { AuthorisationError } from '../errors.js';

export function requirePermission(resource, action) {
  return async (req, res, next) => {
    const { role } = await getUserMembership(req.session.user.id);
    if (!hasPermission(role, resource, action)) return next(new AuthorisationError());
    next();
  };
}
