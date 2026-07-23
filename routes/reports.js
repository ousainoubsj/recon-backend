import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as reportsController from '../controllers/reports.controller.js';

export const reportsRouter = Router();

const RECON_STATUSES = ['matched', 'mismatched', 'unmatched_a', 'unmatched_b', 'duplicate'];

const saveReportSchema = z.object({
  name: z.string().max(255).optional(),
  fileAName: z.string(),
  fileBName: z.string(),
  summary: z.object({
    total: z.number(),
    matched: z.number(),
    mismatched: z.number(),
    unmatchedA: z.number(),
    unmatchedB: z.number(),
    duplicates: z.number(),
    matchRate: z.number(),
    totalBreakValue: z.number(),
    durationMs: z.number(),
  }),
  rows: z.array(
    z.object({
      ref: z.string(),
      status: z.enum(RECON_STATUSES),
      amountA: z.number().nullable(),
      amountB: z.number().nullable(),
      amountDiff: z.number().nullable(),
      dateA: z.string().nullable().optional(),
      dateB: z.string().nullable().optional(),
      rawA: z.record(z.string()).nullable().optional(),
      rawB: z.record(z.string()).nullable().optional(),
    }),
  ),
  config: z.object({
    amountTolerance: z.number().min(0, 'amount_tolerance must be a non-negative number'),
    dateToleranceDays: z.number().optional(),
  }),
});

reportsRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.listReports),
);

reportsRouter.post(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(saveReportSchema),
  catchAsync(reportsController.saveReport),
);

// Draft fields are all optional — a draft can be saved at any point in the
// reconcile flow, from just a name up to everything but the final match run.
const draftSchema = z.object({
  name: z.string().max(255).optional(),
  fileAName: z.string().optional(),
  fileBName: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  config: z.record(z.unknown()).optional(),
});

// Registered before /:id so Express doesn't match these as a report id.
reportsRouter.get(
  '/summary',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getReportsSummary),
);

reportsRouter.get(
  '/trend',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getReportsTrend),
);

reportsRouter.get(
  '/drafts',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.listDrafts),
);

reportsRouter.get(
  '/exports',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.listExports),
);

reportsRouter.post(
  '/draft',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(draftSchema),
  catchAsync(reportsController.saveDraft),
);

reportsRouter.patch(
  '/draft/:id',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(draftSchema),
  catchAsync(reportsController.updateDraft),
);

reportsRouter.post(
  '/draft/:id/complete',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(saveReportSchema),
  catchAsync(reportsController.completeDraft),
);

reportsRouter.get(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getReport),
);

reportsRouter.delete(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  catchAsync(reportsController.deleteReport),
);

const sectionsSchema = z
  .object({
    summary: z.boolean(),
    matchStatistics: z.boolean(),
    breakAnalysis: z.boolean(),
    unmatchedDetails: z.boolean(),
    chartsAndGraphs: z.boolean(),
  })
  .partial();

const exportSchema = z.object({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  templateId: z.string().uuid().optional(),
  sections: sectionsSchema.optional(),
});

reportsRouter.post(
  '/:id/export',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
  validate(exportSchema),
  catchAsync(reportsController.exportReport),
);

const emailSchema = z.object({ to: z.string().email() });

reportsRouter.post(
  '/:id/email',
  authenticate,
  catchAsync(requirePermission('report', 'email')),
  validate(emailSchema),
  catchAsync(reportsController.emailReport),
);
