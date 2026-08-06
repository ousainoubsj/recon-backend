import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as reportsController from '../controllers/reports.controller.js';

export const reportsRouter = Router();

const RECON_STATUSES = ['matched', 'mismatched', 'unmatched_a', 'unmatched_b', 'duplicate'];

// Full reconciliation rule config (MatchingRulesSidebar) — amountTolerance/
// dateToleranceDays double as the Report columns of the same name, the rest
// (toggles + duplicateHandling) live only in Report.rulesConfig/config JSON.
// Optional-with-default so older callers that only ever sent
// {amountTolerance, dateToleranceDays} keep working unchanged.
const matchRuleConfigSchema = z.object({
  amountTolerance: z.number().min(0, 'amount_tolerance must be a non-negative number').max(1),
  dateToleranceDays: z.number().int().min(0).max(90).optional(),
  sameCurrencyOnly: z.boolean().optional().default(true),
  ignoreCase: z.boolean().optional().default(true),
  ignoreSpaces: z.boolean().optional().default(true),
  trimLeadingZeros: z.boolean().optional().default(true),
  duplicateHandling: z.enum(['keep-first', 'keep-last', 'flag-all', 'skip']).optional().default('keep-first'),
});

const fileColumnMappingSchema = z.object({
  referenceNumber: z.string(),
  amount: z.string(),
  transactionDate: z.string().optional(),
  currency: z.string().optional(),
});

const columnMappingSchema = z.object({ fileA: fileColumnMappingSchema, fileB: fileColumnMappingSchema });

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
  config: matchRuleConfigSchema,
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
  // Set once the frontend has PUT the file to R2 via the presigned upload
  // (POST /files/presign) — distinct from fileAName/fileBName above, which
  // are just display names.
  fileAKey: z.string().optional(),
  fileBKey: z.string().optional(),
  // Partial: the mapping UI lets a user assign one canonical field at a
  // time, so a draft may be saved mid-mapping.
  columnMapping: z
    .object({ fileA: fileColumnMappingSchema.partial(), fileB: fileColumnMappingSchema.partial() })
    .partial()
    .optional(),
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
  '/exports/:exportId/download',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
  catchAsync(reportsController.downloadExport),
);

reportsRouter.delete(
  '/exports/:exportId',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  catchAsync(reportsController.deleteExport),
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

// Min 2 — comparing a single report against itself isn't a comparison; no
// templateId (the "Combined Report" template is a client-only pseudo-card,
// never a real ReportTemplate row, same as "Custom Report").
const comparisonExportSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(100),
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  sections: sectionsSchema.optional(),
  preview: z.boolean().optional(),
});

reportsRouter.post(
  '/comparison-export',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
  validate(comparisonExportSchema),
  catchAsync(reportsController.comparisonExport),
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

// Downloads+parses the draft's uploaded files fresh from R2, returns
// per-file preview/validation/mapping-suggestion data, and caches a bounded
// row sample on the draft for the rule-preview endpoint below to reuse.
reportsRouter.post(
  '/:id/mapping-preview',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  catchAsync(reportsController.getMappingPreview),
);

const rulePreviewSchema = z.object({
  columnMapping: columnMappingSchema.optional(),
  config: matchRuleConfigSchema,
});

// Cheap, sample-based estimate — safe to call on every rule-slider tick.
// Requires mapping-preview to have run first (it's what populates the
// cached sample rows this reads).
reportsRouter.post(
  '/:id/rule-preview',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(rulePreviewSchema),
  catchAsync(reportsController.getRulePreview),
);

const runReconciliationSchema = z.object({
  name: z.string().max(255).optional(),
  columnMapping: columnMappingSchema,
  config: matchRuleConfigSchema,
});

// The actual matching engine: re-downloads+re-parses the full files (not
// the cached sample), computes real results, and persists them exactly like
// completeDraft does.
reportsRouter.post(
  '/:id/run',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(runReconciliationSchema),
  catchAsync(reportsController.runReconciliation),
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

const updateNameSchema = z.object({ name: z.string().min(1).max(255) });

reportsRouter.patch(
  '/:id/name',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(updateNameSchema),
  catchAsync(reportsController.updateReportName),
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

// Transaction Explorer — search/filter/sort/paginate over a single report's
// rows, plus per-row drill-down and the "Mark as Reviewed" workflow.
reportsRouter.get(
  '/:id/transactions',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getTransactions),
);

reportsRouter.get(
  '/:id/transactions/:rowId',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getTransaction),
);

const markReviewedSchema = z.object({ reviewed: z.boolean().optional() });

reportsRouter.patch(
  '/:id/transactions/:rowId/review',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validate(markReviewedSchema),
  catchAsync(reportsController.markRowReviewed),
);

reportsRouter.get(
  '/:id/break-breakdown',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getBreakBreakdown),
);

reportsRouter.get(
  '/:id/trend',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.getFilePairTrend),
);

const exportSchema = z.object({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  templateId: z.string().uuid().optional(),
  sections: sectionsSchema.optional(),
  // Set by ReportPreviewCard's "Preview Full Report" dialog — same file
  // generation, but not tracked as a real export (no R2 persistence, no
  // ReportExport row, no audit log), so opening a preview doesn't spawn a
  // phantom row in RecentExports every time.
  preview: z.boolean().optional(),
});

reportsRouter.post(
  '/:id/export',
  authenticate,
  catchAsync(requirePermission('report', 'export')),
  validate(exportSchema),
  catchAsync(reportsController.exportReport),
);

const emailSchema = z.object({ to: z.array(z.string().email()).min(1).max(20) });

reportsRouter.post(
  '/:id/email',
  authenticate,
  catchAsync(requirePermission('report', 'email')),
  validate(emailSchema),
  catchAsync(reportsController.emailReport),
);

const comparisonEmailSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(100),
  to: z.array(z.string().email()).min(1).max(20),
});

reportsRouter.post(
  '/comparison-email',
  authenticate,
  catchAsync(requirePermission('report', 'email')),
  validate(comparisonEmailSchema),
  catchAsync(reportsController.comparisonEmailReport),
);
