import cron from 'node-cron';
import { prisma } from '../db/index.js';
import { resolveSections, getTemplateName } from './reportTemplateService.js';
import { recordExport } from './reportExportService.js';
import { computeNextRunAt } from './scheduledReportService.js';
import { sendScheduledReportEmail } from './emailService.js';
import { getOrganizationBrand } from './organizationService.js';
import { buildXlsxReport } from '../utils/xlsxReport.js';
import { buildPdfReport } from '../utils/pdfReport.js';

async function advanceSchedule(scheduleId, cadence, now) {
  await prisma.scheduledReport.update({
    where: { id: scheduleId },
    data: { lastRunAt: now, nextRunAt: computeNextRunAt(cadence, now) },
  });
}

// Each schedule is isolated in its own try/catch, and always advances in
// `finally` regardless of outcome — one broken schedule (e.g. pointing at a
// report that's no longer completed) logs an error and tries again next
// cadence, instead of retry-looping forever on the same failure or blocking
// every other schedule in the same run.
function recordFailedRun(schedule, message) {
  return recordExport({
    reportId: schedule.reportId,
    userId: schedule.userId,
    organizationId: schedule.organizationId,
    templateId: schedule.templateId,
    scheduleId: schedule.id,
    source: 'scheduled',
    format: schedule.format,
    status: 'failed',
    errorMessage: message,
  });
}

async function runSchedule(schedule, now) {
  try {
    if (!schedule.report || schedule.report.status !== 'completed') {
      const message = 'Report missing or not completed';
      console.error('Skipping scheduled report —', message, schedule.id);
      await recordFailedRun(schedule, message);
      return;
    }

    const sections = await resolveSections({
      organizationId: schedule.organizationId,
      templateId: schedule.templateId,
      overrideSections: schedule.sections,
    });

    let pdfMeta;
    if (schedule.format === 'pdf') {
      const [org, templateName] = await Promise.all([
        getOrganizationBrand(schedule.organizationId),
        getTemplateName(schedule.organizationId, schedule.templateId),
      ]);
      pdfMeta = {
        generatedByName: 'Automated (Scheduled Report)',
        organizationName: org?.name ?? null,
        organizationLogo: org?.logo ?? null,
        organizationType: org?.orgType ?? null,
        templateName,
      };
    }

    const buffer = schedule.format === 'pdf' ? await buildPdfReport(schedule.report, sections, pdfMeta) : buildXlsxReport(schedule.report, sections);

    await recordExport({
      reportId: schedule.reportId,
      userId: schedule.userId,
      organizationId: schedule.organizationId,
      templateId: schedule.templateId,
      scheduleId: schedule.id,
      source: 'scheduled',
      format: schedule.format,
      status: 'success',
      fileSizeBytes: buffer.length,
    });

    if (schedule.recipientEmails?.length) {
      await sendScheduledReportEmail(schedule.report, buffer, schedule.format, schedule.recipientEmails);
    }
  } catch (err) {
    console.error('Scheduled report run failed', schedule.id, err);
    await recordFailedRun(schedule, err.message);
  } finally {
    await advanceSchedule(schedule.id, schedule.cadence, now);
  }
}

/**
 * Finds every due, active schedule and runs it. Plain, directly-callable
 * function (not tied to the cron wiring below) so it can be tested and
 * manually invoked without waiting for a real tick.
 * @param {Date} now
 * @returns {Promise<number>} how many schedules were processed
 */
export async function runDueScheduledReports(now = new Date()) {
  const due = await prisma.scheduledReport.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    include: { report: { include: { rows: true } } },
  });

  for (const schedule of due) {
    await runSchedule(schedule, now);
  }

  return due.length;
}

/** Only ever called from app.js — never imported by tests. */
export function startScheduledReportCron() {
  cron.schedule('*/15 * * * *', () => {
    runDueScheduledReports().catch((err) => console.error('runDueScheduledReports failed', err));
  });
}
