import * as XLSX from 'xlsx';
import { Resend } from 'resend';
import * as reportService from '../services/reportService.js';

const RECON_STATUSES = ['matched', 'mismatched', 'unmatched_a', 'unmatched_b', 'duplicate'];

const resend = new Resend(process.env.RESEND_API_KEY);

export const listReports = async (req, res) => {
  const reports = await reportService.listReports(req.session.user.id);
  res.json(reports);
};

export const saveReport = async (req, res) => {
  const id = await reportService.saveReport(req.session.user.id, req.body);
  res.status(201).json({ id });
};

export const getReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  res.json(report);
};

export const deleteReport = async (req, res) => {
  await reportService.deleteReport(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const exportReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  const wb = XLSX.utils.book_new();
  for (const status of RECON_STATUSES) {
    const filtered = report.rows.filter((r) => r.status === status);
    const ws = XLSX.utils.json_to_sheet(filtered);
    XLSX.utils.book_append_sheet(wb, ws, status);
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reconciliation_report_${report.id}.xlsx"`);
  res.send(buffer);
};

export const emailReport = async (req, res) => {
  const report = await reportService.getReport(req.session.user.id, req.params.id);
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: req.body.to,
    subject: `Reconciliation report — ${report.fileAName} vs ${report.fileBName}`,
    text: `Matched: ${report.matchedCount}/${report.totalRows} (run ${report.runDate.toISOString()})`,
  });
  res.status(202).json({ sent: true });
};
