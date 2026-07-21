import * as auditLogService from '../services/auditLogService.js';
import { parsePositiveInt } from '../utils/queryParams.js';

export const listAuditLogs = async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 200);
  const logs = await auditLogService.listAuditLogs(req.session.user.id, { limit });
  res.json(logs);
};

export const createAuditLog = async (req, res) => {
  const log = await auditLogService.createAuditLog(req.session.user.id, req.body);
  res.status(201).json(log);
};
