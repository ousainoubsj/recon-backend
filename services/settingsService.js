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

export async function getOrganizationInfo(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.organization.findFirst({
    where: { id: organizationId },
    select: { name: true, logo: true, ...Object.fromEntries(ORG_INFO_FIELDS.map((f) => [f, true])) },
  });
}

export async function updateOrganizationInfo(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: pickProvided(dto, ORG_INFO_FIELDS),
  });

  await logAuditSafely(userId, {
    action: 'settings.organization_info.update',
    entityType: 'organization',
    entityId: organizationId,
    metadata: pickProvided(dto, ORG_INFO_FIELDS),
  });

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
  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: pickProvided(dto, RECONCILIATION_DEFAULT_FIELDS),
  });

  await logAuditSafely(userId, {
    action: 'settings.reconciliation_defaults.update',
    entityType: 'organization',
    entityId: organizationId,
    metadata: pickProvided(dto, RECONCILIATION_DEFAULT_FIELDS),
  });

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
  const user = await prisma.user.update({ where: { id: userId }, data });

  await logAuditSafely(userId, {
    action: 'settings.notifications.update',
    entityType: 'user',
    entityId: userId,
    status: 'info',
    metadata: data,
  });

  return { emailNotificationsEnabled: user.emailNotificationsEnabled, weeklyDigestEnabled: user.weeklyDigestEnabled };
}
