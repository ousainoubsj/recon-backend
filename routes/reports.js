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

reportsRouter.post(
  '/:id/export',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
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
