import * as auditLogService from '../services/auditLogService.js';
import { parsePositiveInt } from '../utils/queryParams.js';

export const listAuditLogs = async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 200);
  const offset = parsePositiveInt(req.query.offset);
  const { q, action, entityType, userId: actorUserId, dateFrom, dateTo, status } = req.query;
  const logs = await auditLogService.listAuditLogs(req.session.user.id, {
    limit,
    offset,
    q,
    action,
    entityType,
    actorUserId,
    dateFrom,
    dateTo,
    status,
  });
  res.json(logs);
};

export const createAuditLog = async (req, res) => {
  const log = await auditLogService.createAuditLog(req.session.user.id, req.body);
  res.status(201).json(log);
};

export const getAuditLogStats = async (req, res) => {
  const stats = await auditLogService.getAuditLogStats(req.session.user.id);
  res.json(stats);
};

export const getTopActions = async (req, res) => {
  const actions = await auditLogService.getTopActions(req.session.user.id);
  res.json(actions);
};

export const getTopUsers = async (req, res) => {
  const users = await auditLogService.getTopUsers(req.session.user.id);
  res.json(users);
};
