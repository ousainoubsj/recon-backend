import * as platformService from '../services/platformService.js';
import { parsePositiveInt } from '../utils/queryParams.js';
import { auditContext } from '../utils/audit.js';

const pageOf = (query) => ({ offset: parsePositiveInt(query.offset) ?? 0, limit: parsePositiveInt(query.limit, 100) ?? 20 });

export const listCompanies = async (req, res) => {
  const { q, status } = req.query;
  res.json(await platformService.listCompanies(req.session.user, { q: q?.trim() || undefined, status, ...pageOf(req.query) }));
};

export const getCompany = async (req, res) => {
  res.json(await platformService.getCompany(req.session.user, req.params.id));
};

export const createCompany = async (req, res) => {
  res.status(201).json(await platformService.createCompany(req.session.user, req.body, auditContext(req)));
};

export const updateCompany = async (req, res) => {
  res.json(await platformService.updateCompany(req.session.user, req.params.id, req.body, auditContext(req)));
};

export const suspendCompany = async (req, res) => {
  res.json(await platformService.setCompanyStatus(req.session.user, req.params.id, 'suspended', auditContext(req)));
};

export const activateCompany = async (req, res) => {
  res.json(await platformService.setCompanyStatus(req.session.user, req.params.id, 'active', auditContext(req)));
};

export const inviteCompanyUser = async (req, res) => {
  await platformService.inviteCompanyUser(req.session.user, req.params.id, req.body, auditContext(req));
  res.status(201).end();
};

export const enterCompany = async (req, res) => {
  res.json(await platformService.enterCompany(req.session.user, req.params.id));
};

export const exitCompany = async (req, res) => {
  await platformService.exitCompany(req.session.user.id);
  res.status(204).end();
};

export const listPlatformAdmins = async (req, res) => {
  res.json(await platformService.listPlatformAdmins({ q: req.query.q?.trim() || undefined, ...pageOf(req.query) }));
};

export const invitePlatformAdmin = async (req, res) => {
  await platformService.invitePlatformAdmin(req.session.user, req.body, auditContext(req));
  res.status(201).end();
};

export const suspendPlatformAdmin = async (req, res) => {
  await platformService.setPlatformAdminStatus(req.session.user, req.params.userId, 'suspended', auditContext(req));
  res.status(204).end();
};

export const activatePlatformAdmin = async (req, res) => {
  await platformService.setPlatformAdminStatus(req.session.user, req.params.userId, 'active', auditContext(req));
  res.status(204).end();
};

export const removePlatformAdmin = async (req, res) => {
  await platformService.setPlatformAdminStatus(req.session.user, req.params.userId, 'removed', auditContext(req));
  res.status(204).end();
};

export const getAdminCompanies = async (req, res) => {
  res.json(await platformService.getAdminCompanies(req.session.user, req.params.userId));
};

export const setAdminCompanies = async (req, res) => {
  res.json(await platformService.setAdminCompanies(req.session.user, req.params.userId, req.body.organizationIds, auditContext(req)));
};
