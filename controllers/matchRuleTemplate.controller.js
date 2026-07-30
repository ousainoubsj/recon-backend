import * as matchRuleTemplateService from '../services/matchRuleTemplateService.js';

export const listTemplates = async (req, res) => {
  const templates = await matchRuleTemplateService.listTemplates(req.session.user.id);
  res.json(templates);
};

export const createTemplate = async (req, res) => {
  const template = await matchRuleTemplateService.createTemplate(req.session.user.id, req.body);
  res.status(201).json(template);
};

export const deleteTemplate = async (req, res) => {
  await matchRuleTemplateService.deleteTemplate(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const recordUsage = async (req, res) => {
  await matchRuleTemplateService.recordUsage(req.session.user.id, req.params.id);
  res.status(204).end();
};
