import { hasPermission, ROLE_PERMISSIONS } from '../../services/permissions.js';

describe('hasPermission', () => {
  const cases = [
    ['admin', 'file', 'upload', true],
    ['admin', 'report', 'create', true],
    ['admin', 'report', 'delete', true],
    ['admin', 'member', 'create', true],
    ['admin', 'organization', 'delete', true],
    ['analyst', 'file', 'upload', true],
    ['analyst', 'report', 'create', true],
    ['analyst', 'report', 'delete', false],
    ['analyst', 'member', 'create', false],
    ['analyst', 'organization', 'delete', false],
    ['viewer', 'file', 'upload', false],
    ['viewer', 'report', 'create', false],
    ['viewer', 'report', 'read', true],
    ['viewer', 'report', 'export', true],
    ['viewer', 'report', 'delete', false],
    ['admin', 'auditLog', 'create', true],
    ['admin', 'auditLog', 'read', true],
    ['analyst', 'auditLog', 'create', true],
    ['analyst', 'auditLog', 'read', false],
    ['viewer', 'auditLog', 'create', false],
    ['viewer', 'auditLog', 'read', false],
  ];

  it.each(cases)('%s can %s:%s -> %s', (role, resource, action, expected) => {
    expect(hasPermission(role, resource, action)).toBe(expected);
  });

  it('returns false for an unknown role', () => {
    expect(hasPermission('nonexistent', 'report', 'read')).toBe(false);
  });

  it('returns false for an unknown resource', () => {
    expect(hasPermission('admin', 'nonexistent', 'read')).toBe(false);
  });

  it('defines exactly the three domain roles', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['admin', 'analyst', 'viewer']);
  });
});
