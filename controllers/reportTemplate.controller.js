import * as reportTemplateService from '../services/reportTemplateService.js';
import { auditContext } from '../utils/audit.js';

export const listTemplates = async (req, res) => {
  const templates = await reportTemplateService.listTemplates(req.session.user.id);
  res.json(templates);
};

export const createTemplate = async (req, res) => {
  const template = await reportTemplateService.createTemplate(req.session.user.id, req.body, auditContext(req));
  res.status(201).json(template);
};

export const deleteTemplate = async (req, res) => {
  await reportTemplateService.deleteTemplate(req.session.user.id, req.params.id, auditContext(req));
  res.status(204).end();
};
