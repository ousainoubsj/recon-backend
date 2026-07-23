import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as reportTemplateController from '../controllers/reportTemplate.controller.js';

export const reportTemplatesRouter = Router();

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  sections: z
    .object({
      summary: z.boolean(),
      matchStatistics: z.boolean(),
      breakAnalysis: z.boolean(),
      unmatchedDetails: z.boolean(),
      chartsAndGraphs: z.boolean(),
    })
    .partial()
    .optional(),
});

reportTemplatesRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportTemplateController.listTemplates),
);

reportTemplatesRouter.post(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(createTemplateSchema),
  catchAsync(reportTemplateController.createTemplate),
);

reportTemplatesRouter.delete(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  catchAsync(reportTemplateController.deleteTemplate),
);
