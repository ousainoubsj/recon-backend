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
  const reports = await reportService.listReports(req.session.user.id, { limit });
  res.json(reports);
};

export const getReportsSummary = async (req, res) => {
  const summary = await reportService.getReportsSummary(req.session.user.id);
  res.json(summary);
};

export const getReportsTrend = async (req, res) => {
  const months = parsePositiveInt(req.query.months, 12);
  const trend = await reportService.getReportsTrend(req.session.user.id, months ? { months } : undefined);
  res.json(trend);
};

export const saveReport = async (req, res) => {
  const id = await reportService.saveReport(req.session.user.id, req.body);
  res.status(201).json({ id });
};

export const saveDraft = async (req, res) => {
  const draft = await reportService.saveDraft(req.session.user.id, req.body);
  res.status(201).json(draft);
};

export const updateDraft = async (req, res) => {
  const draft = await reportService.updateDraft(req.session.user.id, req.params.id, req.body);
  res.json(draft);
};

export const listDrafts = async (req, res) => {
  const drafts = await reportService.listDrafts(req.session.user.id);
  res.json(drafts);
};

export const completeDraft = async (req, res) => {
  const id = await reportService.completeDraft(req.session.user.id, req.params.id, req.body);
  res.status(200).json({ id });
};

export const getReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  res.json(report);
};

export const deleteReport = async (req, res) => {
  await reportService.deleteReport(req.session.user.id, req.params.id);
  res.status(204).end();
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
  const exports = await listReportExports(req.session.user.id, { limit });
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
    metadata: { to: req.body.to },
  });
};
