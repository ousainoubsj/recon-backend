import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as matchRuleTemplateController from '../controllers/matchRuleTemplate.controller.js';

export const matchRuleTemplatesRouter = Router();

// Deliberately duplicated from routes/reports.js's matchRuleConfigSchema
// rather than imported — importing from reports.js would transitively pull
// in its entire controller chain (reportService.js, db/index.js, etc.) into
// every test that touches this router, forcing a much heavier mock surface
// for no real benefit.
const matchRuleConfigSchema = z.object({
  amountTolerance: z.number().min(0, 'amount_tolerance must be a non-negative number').max(1),
  dateToleranceDays: z.number().int().min(0).max(3).optional(),
  sameCurrencyOnly: z.boolean().optional().default(true),
  ignoreCase: z.boolean().optional().default(true),
  ignoreSpaces: z.boolean().optional().default(true),
  trimLeadingZeros: z.boolean().optional().default(true),
  duplicateHandling: z.enum(['keep-first', 'keep-last', 'flag-all', 'skip']).optional().default('keep-first'),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  config: matchRuleConfigSchema,
});

matchRuleTemplatesRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(matchRuleTemplateController.listTemplates),
);

matchRuleTemplatesRouter.post(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(createTemplateSchema),
  catchAsync(matchRuleTemplateController.createTemplate),
);

matchRuleTemplatesRouter.delete(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  catchAsync(matchRuleTemplateController.deleteTemplate),
);

matchRuleTemplatesRouter.post(
  '/:id/use',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  catchAsync(matchRuleTemplateController.recordUsage),
);
