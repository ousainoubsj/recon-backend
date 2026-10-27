import { getUserMembership } from '../services/organizationService.js';
import { hasPermission } from '../services/permissions.js';
import { logAuditSafely } from '../services/auditLogService.js';
import { AuthorisationError } from '../errors.js';
import { auditContext } from '../utils/audit.js';

export function requirePermission(resource, action) {
  return async (req, res, next) => {
    const { role, status } = await getUserMembership(req.session.user.id);
    const isInactive = status === 'inactive';
    if (isInactive || !hasPermission(role, resource, action)) {
      await logAuditSafely(req.session.user.id, {
        action: `${resource}.${action}.denied`,
        entityType: resource,
        entityId: req.params?.id ?? null,
        status: 'failed',
        ...auditContext(req),
        metadata: { role, reason: isInactive ? 'inactive' : 'insufficient_role' },
      });
      return next(new AuthorisationError());
    }
    next();
  };
}
