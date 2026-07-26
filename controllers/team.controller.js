import * as teamService from '../services/teamService.js';
import { parsePositiveInt } from '../utils/queryParams.js';

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
  const member = await teamService.updateMember(req.session.user.id, req.params.id, req.body);
  res.json(member);
};

export const getDepartments = async (req, res) => {
  const departments = await teamService.getDepartments(req.session.user.id);
  res.json(departments);
};

export const addDepartment = async (req, res) => {
  const departments = await teamService.addDepartment(req.session.user.id, req.body.name);
  res.status(201).json(departments);
};
