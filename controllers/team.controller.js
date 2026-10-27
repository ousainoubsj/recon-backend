import * as teamService from '../services/teamService.js';
import { parsePositiveInt } from '../utils/queryParams.js';
import { auditContext } from '../utils/audit.js';

export const listMembers = async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100);
  const offset = parsePositiveInt(req.query.offset);
  const { q, role, status, department } = req.query;
  const members = await teamService.listMembers(req.session.user.id, {
    limit,
    offset,
    q,
    role,
    status,
    department,
  });
  res.json(members);
};

export const getTeamStats = async (req, res) => {
  const stats = await teamService.getTeamStats(req.session.user.id);
  res.json(stats);
};

export const updateMember = async (req, res) => {
  const member = await teamService.updateMember(req.session.user.id, req.params.id, req.body, auditContext(req));
  res.json(member);
};

export const updateMemberRole = async (req, res) => {
  const member = await teamService.updateMemberRole(req.session.user.id, req.params.id, req.body.role, auditContext(req));
  res.json(member);
};

export const removeMember = async (req, res) => {
  await teamService.removeMember(req.session.user.id, req.params.id, auditContext(req));
  res.status(204).end();
};

export const getDepartments = async (req, res) => {
  const departments = await teamService.getDepartments(req.session.user.id);
  res.json(departments);
};

export const addDepartment = async (req, res) => {
  const departments = await teamService.addDepartment(req.session.user.id, req.body.name, auditContext(req));
  res.status(201).json(departments);
};
