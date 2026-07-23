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

const sectionsSchema = z
  .object({
    summary: z.boolean(),
    matchStatistics: z.boolean(),
    breakAnalysis: z.boolean(),
    unmatchedDetails: z.boolean(),
    chartsAndGraphs: z.boolean(),
  })
  .partial();

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

reportsRouter.get(
  '/schedules',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.listSchedules),
);

reportsRouter.get(
  '/history-stats',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getHistoryStats),
);

reportsRouter.get(
  '/match-rate-distribution',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getMatchRateDistribution),
);

reportsRouter.get(
  '/top-file-pairs',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getTopFilePairs),
);

const bulkIdsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

reportsRouter.post(
  '/bulk-delete',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  validate(bulkIdsSchema),
  catchAsync(reportsController.bulkDeleteReports),
);

const bulkExportSchema = bulkIdsSchema.extend({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  templateId: z.string().uuid().optional(),
  sections: sectionsSchema.optional(),
});

reportsRouter.post(
  '/bulk-export',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
  validate(bulkExportSchema),
  catchAsync(reportsController.bulkExportReports),
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

const updateTagSchema = z.object({ tag: z.enum(['bank', 'supplier', 'year_end']).nullable() });

reportsRouter.patch(
  '/:id/tag',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(updateTagSchema),
  catchAsync(reportsController.updateReportTag),
);

reportsRouter.put(
  '/:id/favorite',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.addFavorite),
);

reportsRouter.delete(
  '/:id/favorite',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.removeFavorite),
);

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

const createScheduleSchema = z.object({
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  templateId: z.string().uuid().optional(),
  sections: sectionsSchema.optional(),
  recipientEmails: z.array(z.string().email()).max(20).optional(),
});

const updateScheduleSchema = createScheduleSchema.partial().extend({ isActive: z.boolean().optional() });

reportsRouter.post(
  '/:id/schedule',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(createScheduleSchema),
  catchAsync(reportsController.createSchedule),
);

reportsRouter.patch(
  '/schedules/:id',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(updateScheduleSchema),
  catchAsync(reportsController.updateSchedule),
);

reportsRouter.delete(
  '/schedules/:id',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  catchAsync(reportsController.deleteSchedule),
);

const emailSchema = z.object({ to: z.string().email() });

reportsRouter.post(
  '/:id/email',
  authenticate,
  catchAsync(requirePermission('report', 'email')),
  validate(emailSchema),
  catchAsync(reportsController.emailReport),
);
