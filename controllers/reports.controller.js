import { ZipArchive } from 'archiver';
import * as reportService from '../services/reportService.js';
import { sendReportEmail } from '../services/emailService.js';
import { logAuditSafely } from '../services/auditLogService.js';
import { resolveSections } from '../services/reportTemplateService.js';
import { recordExport, listExports as listReportExports } from '../services/reportExportService.js';
import * as scheduledReportService from '../services/scheduledReportService.js';
import { buildXlsxReport } from '../utils/xlsxReport.js';
import { buildPdfReport } from '../utils/pdfReport.js';
import { parsePositiveInt } from '../utils/queryParams.js';

export const listReports = async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100);
  const offset = parsePositiveInt(req.query.offset);
  const { q, dateFrom, dateTo, tag, favoritesOnly, status } = req.query;
  const reports = await reportService.listReports(req.session.user.id, {
    limit,
    offset,
    q,
    dateFrom,
    dateTo,
    tag,
    favoritesOnly: favoritesOnly === 'true',
    status,
  });
  res.json(reports);
};

export const getReportsSummary = async (req, res) => {
  const summary = await reportService.getReportsSummary(req.session.user.id);
  res.json(summary);
};

export const getHistoryStats = async (req, res) => {
  const stats = await reportService.getHistoryStats(req.session.user.id);
  res.json(stats);
};

export const getMatchRateDistribution = async (req, res) => {
  const distribution = await reportService.getMatchRateDistribution(req.session.user.id);
  res.json(distribution);
};

export const getTopFilePairs = async (req, res) => {
  const pairs = await reportService.getTopFilePairs(req.session.user.id);
  res.json(pairs);
};

export const getReportsTrend = async (req, res) => {
  const months = parsePositiveInt(req.query.months, 12);
  const trend = await reportService.getReportsTrend(req.session.user.id, months ? { months } : undefined);
  res.json(trend);
};

export const saveReport = async (req, res) => {
  const id = await reportService.saveReport(req.session.user.id, req.body, { ip: req.ip });
  res.status(201).json({ id });
};

export const saveDraft = async (req, res) => {
  const draft = await reportService.saveDraft(req.session.user.id, req.body);
  res.status(201).json(draft);
};

export const updateDraft = async (req, res) => {
  const draft = await reportService.updateDraft(req.session.user.id, req.params.id, req.body, { ip: req.ip });
  res.json(draft);
};

export const listDrafts = async (req, res) => {
  const drafts = await reportService.listDrafts(req.session.user.id);
  res.json(drafts);
};

export const completeDraft = async (req, res) => {
  const id = await reportService.completeDraft(req.session.user.id, req.params.id, req.body, { ip: req.ip });
  res.status(200).json({ id });
};

export const getMappingPreview = async (req, res) => {
  const preview = await reportService.getMappingPreview(req.session.user.id, req.params.id);
  res.json(preview);
};

export const getRulePreview = async (req, res) => {
  const preview = await reportService.getRulePreview(req.session.user.id, req.params.id, req.body);
  res.json(preview);
};

export const runReconciliation = async (req, res) => {
  const id = await reportService.runReconciliation(req.session.user.id, req.params.id, req.body, { ip: req.ip });
  res.status(200).json({ id });
};

export const getReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  res.json(report);

  // Only completed reports count as "viewing reconciliation results" — a
  // draft being reopened for editing isn't that. Not logged from
  // reportService.getReport itself since export/email/bulk-export also call
  // it internally and shouldn't each register as a "view".
  if (report.status === 'completed') {
    await logAuditSafely(req.session.user.id, {
      action: 'report.results.viewed',
      entityType: 'report',
      entityId: report.id,
      status: 'info',
      ip: req.ip,
    });
  }
};

export const getTransactions = async (req, res) => {
  const { search, status, amountMin, amountMax, dateFrom, dateTo, sortBy, sortDir } = req.query;
  const result = await reportService.getTransactions(req.session.user.id, req.params.id, {
    search,
    status,
    amountMin: amountMin !== undefined ? Number(amountMin) : undefined,
    amountMax: amountMax !== undefined ? Number(amountMax) : undefined,
    dateFrom,
    dateTo,
    sortBy,
    sortDir,
    limit: parsePositiveInt(req.query.limit, 50),
    offset: parsePositiveInt(req.query.offset),
  });
  res.json(result);
};

export const getTransaction = async (req, res) => {
  const transaction = await reportService.getTransaction(req.session.user.id, req.params.id, req.params.rowId);
  res.json(transaction);
};

export const markRowReviewed = async (req, res) => {
  const row = await reportService.markRowReviewed(
    req.session.user.id,
    req.params.id,
    req.params.rowId,
    req.body.reviewed ?? true,
    { ip: req.ip },
  );
  res.json(row);
};

export const getBreakBreakdown = async (req, res) => {
  const breakdown = await reportService.getBreakBreakdown(req.session.user.id, req.params.id);
  res.json(breakdown);
};

export const getFilePairTrend = async (req, res) => {
  const trend = await reportService.getFilePairTrend(req.session.user.id, req.params.id);
  res.json(trend);
};

export const deleteReport = async (req, res) => {
  await reportService.deleteReport(req.session.user.id, req.params.id, { ip: req.ip });
  res.status(204).end();
};

export const updateReportTag = async (req, res) => {
  const report = await reportService.updateReportTag(req.session.user.id, req.params.id, req.body.tag ?? null);
  res.json(report);
};

export const addFavorite = async (req, res) => {
  await reportService.addFavorite(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const removeFavorite = async (req, res) => {
  await reportService.removeFavorite(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const bulkDeleteReports = async (req, res) => {
  const result = await reportService.bulkDeleteReports(req.session.user.id, req.body.ids, { ip: req.ip });
  res.json(result);
};

// All-or-nothing: every buffer is built in memory *before* any response
// bytes are sent, so a single failed report aborts the whole request with a
// normal RFC 7807 error (same shape as the single-report export failure)
// instead of streaming a silently-incomplete zip.
export const bulkExportReports = async (req, res) => {
  const { ids, format = 'xlsx', templateId, sections: overrideSections } = req.body;
  const reports = await reportService.getReportsByIds(req.session.user.id, ids, { requireCompleted: true });

  const sections = await resolveSections({
    organizationId: reports[0].organizationId,
    templateId,
    overrideSections,
  });

  const built = [];
  for (const report of reports) {
    try {
      const buffer = format === 'pdf' ? await buildPdfReport(report, sections) : buildXlsxReport(report, sections);
      built.push({ report, buffer });
    } catch (err) {
      await recordExport({
        reportId: report.id,
        userId: req.session.user.id,
        organizationId: report.organizationId,
        templateId,
        format,
        source: 'manual',
        status: 'failed',
        errorMessage: err.message,
      });
      throw err;
    }
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="reports_export_${Date.now()}.zip"`);

  const archive = new ZipArchive();
  archive.pipe(res);
  for (const { report, buffer } of built) {
    archive.append(buffer, { name: `${report.name || 'report'}-${report.id}.${format}` });
  }
  await archive.finalize();

  await logAuditSafely(req.session.user.id, {
    action: 'report.bulk_export',
    entityType: 'report',
    status: 'info',
    ip: req.ip,
    metadata: { ids, format, templateId: templateId ?? null },
  });

  for (const { report, buffer } of built) {
    await recordExport({
      reportId: report.id,
      userId: req.session.user.id,
      organizationId: report.organizationId,
      templateId,
      format,
      source: 'manual',
      status: 'success',
      fileSizeBytes: buffer.length,
    });
  }
};

const CONTENT_TYPE_BY_FORMAT = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export const exportReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  const { format = 'xlsx', templateId, sections: overrideSections } = req.body ?? {};

  const sections = await resolveSections({
    organizationId: report.organizationId,
    templateId,
    overrideSections,
  });

  let buffer;
  try {
    buffer = format === 'pdf' ? await buildPdfReport(report, sections) : buildXlsxReport(report, sections);
  } catch (err) {
    await recordExport({
      reportId: report.id,
      userId: req.session.user.id,
      organizationId: report.organizationId,
      templateId,
      format,
      source: 'manual',
      status: 'failed',
      errorMessage: err.message,
    });
    throw err;
  }

  res.setHeader('Content-Type', CONTENT_TYPE_BY_FORMAT[format]);
  res.setHeader('Content-Disposition', `attachment; filename="reconciliation_report_${report.id}.${format}"`);
  res.send(buffer);

  await logAuditSafely(req.session.user.id, {
    action: 'report.export',
    entityType: 'report',
    entityId: report.id,
    status: 'info',
    ip: req.ip,
    metadata: { format, templateId: templateId ?? null },
  });

  await recordExport({
    reportId: report.id,
    userId: req.session.user.id,
    organizationId: report.organizationId,
    templateId,
    format,
    source: 'manual',
    status: 'success',
    fileSizeBytes: buffer.length,
  });
};

export const listExports = async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100);
  const offset = parsePositiveInt(req.query.offset);
  const exports = await listReportExports(req.session.user.id, { limit, offset, q: req.query.q });
  res.json(exports);
};

export const createSchedule = async (req, res) => {
  const schedule = await scheduledReportService.createSchedule(req.session.user.id, req.params.id, req.body);
  res.status(201).json(schedule);
};

export const listSchedules = async (req, res) => {
  const schedules = await scheduledReportService.listSchedules(req.session.user.id);
  res.json(schedules);
};

export const updateSchedule = async (req, res) => {
  const schedule = await scheduledReportService.updateSchedule(req.session.user.id, req.params.id, req.body);
  res.json(schedule);
};

export const deleteSchedule = async (req, res) => {
  await scheduledReportService.deleteSchedule(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const emailReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  await sendReportEmail(report, req.body.to);
  res.status(202).json({ sent: true });

  await logAuditSafely(req.session.user.id, {
    action: 'report.email',
    entityType: 'report',
    entityId: report.id,
    status: 'info',
    ip: req.ip,
    metadata: { to: req.body.to },
  });
};
