import { getUserMembership } from '../services/organizationService.js';
import { hasPermission } from '../services/permissions.js';
import { logAuditOnce } from '../services/auditLogService.js';
import { AuthorisationError } from '../errors.js';
import { auditContext } from '../utils/audit.js';

// A client retrying or refetching a refused request is one attempt, not many; the first is always recorded.
const DENIED_DEDUP_MS = 5 * 60 * 1000;

export function requirePermission(resource, action) {
  return async (req, res, next) => {
    const { role, status } = await getUserMembership(req.session.user.id);
    const isInactive = status === 'inactive';
    if (isInactive || !hasPermission(role, resource, action)) {
      await logAuditOnce(
        req.session.user.id,
        {
          action: `${resource}.${action}.denied`,
          entityType: resource,
          entityId: req.params?.id ?? null,
          status: 'failed',
          ...auditContext(req),
          metadata: { role, reason: isInactive ? 'inactive' : 'insufficient_role' },
        },
        DENIED_DEDUP_MS,
      );
      return next(new AuthorisationError());
    }
    next();
  };
}

// Gate for /api/super-admin. Platform roles live on the user, not on any membership.
export function requirePlatformRole(...roles) {
  return (req, res, next) => {
    const { platformRole, platformStatus } = req.session.user;
    if (!roles.includes(platformRole) || platformStatus !== 'active') return next(new AuthorisationError());
    next();
  };
}
