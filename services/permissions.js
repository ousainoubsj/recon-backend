export const ROLE_PERMISSIONS = {
  admin: {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    report: ['create', 'read', 'delete', 'export', 'email'],
    file: ['upload'],
    auditLog: ['create', 'read'],
  },
  analyst: {
    organization: [],
    member: [],
    invitation: [],
    report: ['create', 'read', 'export', 'email'],
    file: ['upload'],
    auditLog: ['create'],
  },
  viewer: {
    organization: [],
    member: [],
    invitation: [],
    report: ['read', 'export', 'email'],
    file: [],
    auditLog: [],
  },
};

export function hasPermission(role, resource, action) {
  return ROLE_PERMISSIONS[role]?.[resource]?.includes(action) ?? false;
}
