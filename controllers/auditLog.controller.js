import * as auditLogService from '../services/auditLogService.js';

export const listAuditLogs = async (req, res) => {
  const logs = await auditLogService.listAuditLogs(req.session.user.id);
  res.json(logs);
};

export const createAuditLog = async (req, res) => {
  const log = await auditLogService.createAuditLog(req.session.user.id, req.body);
  res.status(201).json(log);
};
