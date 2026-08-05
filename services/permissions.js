export const ROLE_PERMISSIONS = {
  admin: {
    organization: ['read', 'update', 'delete'],
    member: ['create', 'read', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    report: ['create', 'read', 'delete', 'export', 'email'],
    // Separate from `report` (which also gates actually running a
    // reconciliation, still allowed for analysts) — only admins may create a
    // MatchRuleTemplate, so the org's saved-template catalog stays a
    // deliberately curated set an admin can designate a default from.
    matchRuleTemplate: ['create'],
    file: ['upload'],
    auditLog: ['create', 'read'],
  },
  analyst: {
    organization: ['read'],
    member: ['read'],
    invitation: [],
    report: ['create', 'read', 'export', 'email'],
    matchRuleTemplate: [],
    file: ['upload'],
    auditLog: ['create'],
  },
  viewer: {
    organization: ['read'],
    member: ['read'],
    invitation: [],
    report: ['read', 'export', 'email'],
    matchRuleTemplate: [],
    file: [],
    auditLog: [],
  },
};

export function hasPermission(role, resource, action) {
  return ROLE_PERMISSIONS[role]?.[resource]?.includes(action) ?? false;
}
