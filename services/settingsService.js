import { prisma } from '../db/index.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';

const ORG_INFO_FIELDS = ['orgType', 'country', 'timezone', 'dateFormat', 'currency'];
const RECONCILIATION_DEFAULT_FIELDS = ['defaultAmountTolerance', 'defaultDateToleranceDays', 'defaultAmountType'];

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

export async function updateOrganizationInfo(userId, dto) {
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

export async function updateReconciliationDefaults(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const provided = pickProvided(dto, RECONCILIATION_DEFAULT_FIELDS);

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
      metadata: { changes },
    });
  }

  return organization;
}

// Self-scoped to the caller's own User row — unlike the two above, these
// aren't org-wide settings, mirroring notificationService.js's per-recipient
// model rather than reportService.js's org-scoped one.
export async function getNotificationPreferences(userId) {
  return prisma.user.findFirst({
    where: { id: userId },
    select: { emailNotificationsEnabled: true, weeklyDigestEnabled: true },
  });
}

export async function updateNotificationPreferences(userId, dto) {
  const data = pickProvided(dto, ['emailNotificationsEnabled', 'weeklyDigestEnabled']);

  const before =
    Object.keys(data).length > 0
      ? await prisma.user.findFirst({
          where: { id: userId },
          select: Object.fromEntries(Object.keys(data).map((f) => [f, true])),
        })
      : null;

  const user = await prisma.user.update({ where: { id: userId }, data });

  const changes = diffFields(before ?? {}, data);
  if (Object.keys(changes).length > 0) {
    await logAuditSafely(userId, {
      action: 'settings.notifications.update',
      entityType: 'user',
      entityId: userId,
      status: 'info',
      metadata: { changes },
    });
  }

  return { emailNotificationsEnabled: user.emailNotificationsEnabled, weeklyDigestEnabled: user.weeklyDigestEnabled };
}
