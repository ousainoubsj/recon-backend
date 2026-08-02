import { prisma } from '../config/prisma.config.js';
import { NotFoundError, ConflictError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { getReport } from './reportService.js';

/** Advances a schedule's next-run time by one cadence period from `from`. */
export function computeNextRunAt(cadence, from = new Date()) {
  const next = new Date(from);
  if (cadence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else if (cadence === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

// Schedules are org-shared, like completed reports and templates — not
// private like drafts (see reportService.js's getReport/listDrafts).
export async function createSchedule(userId, reportId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const report = await getReport(userId, reportId); // 404s if not found/not visible
  if (report.status !== 'completed') {
    throw new ConflictError('Cannot schedule a report that has not been completed yet');
  }

  return prisma.scheduledReport.create({
    data: {
      reportId,
      organizationId,
      userId,
      cadence: dto.cadence,
      format: dto.format ?? 'xlsx',
      templateId: dto.templateId ?? null,
      sections: dto.sections ?? undefined,
      recipientEmails: dto.recipientEmails ?? undefined,
      nextRunAt: computeNextRunAt(dto.cadence),
    },
  });
}

export async function listSchedules(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.scheduledReport.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateSchedule(userId, scheduleId, dto) {
  const { organizationId } = await getUserMembership(userId);

  // Changing cadence recomputes nextRunAt from now — otherwise switching
  // e.g. weekly -> daily would leave the next run days further out than
  // the newly-chosen cadence implies.
  const { count } = await prisma.scheduledReport.updateMany({
    where: { id: scheduleId, organizationId },
    data: {
      ...(dto.cadence !== undefined ? { cadence: dto.cadence, nextRunAt: computeNextRunAt(dto.cadence) } : {}),
      ...(dto.format !== undefined ? { format: dto.format } : {}),
      ...(dto.templateId !== undefined ? { templateId: dto.templateId } : {}),
      ...(dto.sections !== undefined ? { sections: dto.sections } : {}),
      ...(dto.recipientEmails !== undefined ? { recipientEmails: dto.recipientEmails } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    },
  });
  if (count === 0) throw new NotFoundError();

  return prisma.scheduledReport.findFirst({ where: { id: scheduleId, organizationId } });
}

export async function deleteSchedule(userId, scheduleId) {
  const { organizationId } = await getUserMembership(userId);
  const { count } = await prisma.scheduledReport.deleteMany({ where: { id: scheduleId, organizationId } });
  if (count === 0) throw new NotFoundError();
}
