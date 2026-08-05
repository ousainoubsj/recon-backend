import { prisma } from '../config/prisma.config.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';
import { AuthorisationError, ValidationError } from '../errors.js';

const ORG_INFO_FIELDS = ['orgType', 'country', 'timezone', 'dateFormat', 'currency'];
const RECONCILIATION_DEFAULT_FIELDS = ['defaultAmountTolerance', 'defaultDateToleranceDays', 'enforcedMatchRuleTemplateId'];

function pickProvided(dto, fields) {
  const data = {};
  for (const field of fields) {
    if (dto[field] !== undefined) data[field] = dto[field];
  }
  return data;
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber(); // Prisma Decimal
  return value;
}

// Only fields that actually changed value end up in the audit log's
// metadata — the frontend's "Save Changes" button always PATCHes the full
// form regardless of what the user actually touched, so naively logging
// whatever was provided would falsely claim every field changed on every
// save (and spam the activity feed with no-op entries).
function diffFields(before, after) {
  const changes = {};
  for (const [field, newValue] of Object.entries(after)) {
    const oldValue = normalizeValue(before?.[field]);
    const normalizedNew = normalizeValue(newValue);
    if (oldValue !== normalizedNew) {
      changes[field] = { from: oldValue, to: normalizedNew };
    }
  }
  return changes;
}

export async function getOrganizationInfo(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.organization.findFirst({
    where: { id: organizationId },
    select: { name: true, logo: true, ...Object.fromEntries(ORG_INFO_FIELDS.map((f) => [f, true])) },
  });
}

export async function updateOrganizationInfo(userId, dto, { ip } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const provided = pickProvided(dto, ORG_INFO_FIELDS);

  const before =
    Object.keys(provided).length > 0
      ? await prisma.organization.findFirst({
          where: { id: organizationId },
          select: Object.fromEntries(Object.keys(provided).map((f) => [f, true])),
        })
      : null;

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: provided,
  });

  const changes = diffFields(before ?? {}, provided);
  if (Object.keys(changes).length > 0) {
    await logAuditSafely(userId, {
      action: 'settings.organization_info.update',
      entityType: 'organization',
      entityId: organizationId,
      ip,
      metadata: { changes },
    });
  }

  return organization;
}

export async function getReconciliationDefaults(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.organization.findFirst({
    where: { id: organizationId },
    select: Object.fromEntries(RECONCILIATION_DEFAULT_FIELDS.map((f) => [f, true])),
  });
}

export async function updateReconciliationDefaults(userId, dto, { ip } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const provided = pickProvided(dto, RECONCILIATION_DEFAULT_FIELDS);

  // Picking a different org's template (or a stale/deleted id) should 422,
  // not silently link to nothing or another org's data.
  if (provided.enforcedMatchRuleTemplateId) {
    const template = await prisma.matchRuleTemplate.findFirst({
      where: { id: provided.enforcedMatchRuleTemplateId, organizationId },
      select: { id: true },
    });
    if (!template) throw new ValidationError('Template does not belong to this organization');
  }

  const before =
    Object.keys(provided).length > 0
      ? await prisma.organization.findFirst({
          where: { id: organizationId },
          select: Object.fromEntries(Object.keys(provided).map((f) => [f, true])),
        })
      : null;

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: provided,
  });

  const changes = diffFields(before ?? {}, provided);
  if (Object.keys(changes).length > 0) {
    await logAuditSafely(userId, {
      action: 'settings.reconciliation_defaults.update',
      entityType: 'organization',
      entityId: organizationId,
      ip,
      metadata: { changes },
    });
  }

  return organization;
}

// emailNotificationsEnabled is self-scoped to the caller's own User row (not
// an org-wide setting, mirroring notificationService.js's per-recipient
// model). weeklyDigestEnabled is org-wide/admin-only (Organization, not
// User) — combined into one read/write pair here since the frontend still
// presents them as a single Notifications settings panel.
export async function getNotificationPreferences(userId) {
  const { organizationId } = await getUserMembership(userId);
  const [user, org] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId }, select: { emailNotificationsEnabled: true } }),
    prisma.organization.findFirst({ where: { id: organizationId }, select: { weeklyDigestEnabled: true } }),
  ]);
  return { emailNotificationsEnabled: user.emailNotificationsEnabled, weeklyDigestEnabled: org.weeklyDigestEnabled };
}

export async function updateNotificationPreferences(userId, dto, { ip } = {}) {
  const userData = pickProvided(dto, ['emailNotificationsEnabled']);
  const orgData = pickProvided(dto, ['weeklyDigestEnabled']);
  const { organizationId, role } = await getUserMembership(userId);

  if (Object.keys(orgData).length > 0 && role !== 'admin') throw new AuthorisationError();

  const [userBefore, orgBefore] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId }, select: { emailNotificationsEnabled: true } }),
    prisma.organization.findFirst({ where: { id: organizationId }, select: { weeklyDigestEnabled: true } }),
  ]);

  const user =
    Object.keys(userData).length > 0 ? await prisma.user.update({ where: { id: userId }, data: userData }) : userBefore;
  const org =
    Object.keys(orgData).length > 0
      ? await prisma.organization.update({ where: { id: organizationId }, data: orgData })
      : orgBefore;

  const userChanges = diffFields(userBefore ?? {}, userData);
  if (Object.keys(userChanges).length > 0) {
    await logAuditSafely(userId, {
      action: 'settings.notifications.update',
      entityType: 'user',
      entityId: userId,
      status: 'info',
      ip,
      metadata: { changes: userChanges },
    });
  }

  const orgChanges = diffFields(orgBefore ?? {}, orgData);
  if (Object.keys(orgChanges).length > 0) {
    await logAuditSafely(userId, {
      action: 'settings.notifications.update',
      entityType: 'organization',
      entityId: organizationId,
      status: 'info',
      ip,
      metadata: { changes: orgChanges },
    });
  }

  return { emailNotificationsEnabled: user.emailNotificationsEnabled, weeklyDigestEnabled: org.weeklyDigestEnabled };
}

// Report-export recipients are free-typed addresses, most of which aren't
// registered Users at all (external counterparties) — the toggle only means
// something for the subset that are, so this only ever removes addresses that
// match a registered, opted-out User and leaves everything else untouched.
export async function filterEmailNotificationOptedIn(emails) {
  const lower = emails.map((e) => e.toLowerCase());
  const users = await prisma.user.findMany({
    where: { email: { in: lower } },
    select: { email: true, emailNotificationsEnabled: true },
  });
  const optedOut = new Set(users.filter((u) => !u.emailNotificationsEnabled).map((u) => u.email.toLowerCase()));
  return emails.filter((e) => !optedOut.has(e.toLowerCase()));
}
