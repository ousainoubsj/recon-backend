import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate, validateParams } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as reportsController from '../controllers/reports.controller.js';

export const reportsRouter = Router();

// Every id here is a UUID; a malformed one is a 404 (validateParams), never a Prisma 500.
const idParams = z.object({ id: z.string().uuid() });
const rowParams = z.object({ id: z.string().uuid(), rowId: z.string().uuid() });
const exportParams = z.object({ exportId: z.string().uuid() });

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
  ignoreNonNumericPrefix: z.boolean().optional().default(false),
  // 'skip' is no longer offered (it dropped rows silently); an old client sending it gets flag-all.
  duplicateHandling: z
    .enum(['keep-first', 'keep-last', 'flag-all', 'skip'])
    .optional()
    .default('keep-first')
    .transform((value) => (value === 'skip' ? 'flag-all' : value)),
});

const fileColumnMappingSchema = z.object({
  referenceNumber: z.string(),
  amount: z.string(),
  transactionDate: z.string().optional(),
  currency: z.string().optional(),
});

const columnMappingSchema = z.object({ fileA: fileColumnMappingSchema, fileB: fileColumnMappingSchema });

reportsRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(reportsController.listReports),
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
  validateParams(exportParams),
  catchAsync(reportsController.downloadExport),
);

reportsRouter.delete(
  '/exports/:exportId',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  validateParams(exportParams),
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
  validateParams(idParams),
  validate(draftSchema),
  catchAsync(reportsController.updateDraft),
);

// Downloads+parses the draft's uploaded files fresh from R2, returns
// per-file preview/validation/mapping-suggestion data, and caches a bounded
// row sample on the draft for the rule-preview endpoint below to reuse.
reportsRouter.post(
  '/:id/mapping-preview',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
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
  validateParams(idParams),
  validate(rulePreviewSchema),
  catchAsync(reportsController.getRulePreview),
);

const runReconciliationSchema = z.object({
  name: z.string().max(255).optional(),
  columnMapping: columnMappingSchema,
  config: matchRuleConfigSchema,
});

// The actual matching engine: re-downloads+re-parses the full files (not
// the cached sample), computes real results, and persists them.
// Creates a new draft from a completed report's files, mapping and rules; the source is left as it is.
reportsRouter.post(
  '/:id/rerun',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  catchAsync(reportsController.rerunReport),
);

reportsRouter.post(
  '/:id/run',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  validate(runReconciliationSchema),
  catchAsync(reportsController.runReconciliation),
);

reportsRouter.get(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.getReport),
);

reportsRouter.delete(
  '/:id',
  authenticate,
  catchAsync(requirePermission('report', 'delete')),
  validateParams(idParams),
  catchAsync(reportsController.deleteReport),
);

const updateTagSchema = z.object({ tag: z.enum(['bank', 'supplier', 'year_end']).nullable() });

reportsRouter.patch(
  '/:id/tag',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  validate(updateTagSchema),
  catchAsync(reportsController.updateReportTag),
);

const updateNameSchema = z.object({ name: z.string().min(1).max(255) });

reportsRouter.patch(
  '/:id/name',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  validate(updateNameSchema),
  catchAsync(reportsController.updateReportName),
);

reportsRouter.put(
  '/:id/favorite',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.addFavorite),
);

reportsRouter.delete(
  '/:id/favorite',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.removeFavorite),
);

// Transaction Explorer — search/filter/sort/paginate over a single report's
// rows, plus per-row drill-down and the "Mark as Reviewed" workflow.
reportsRouter.get(
  '/:id/transactions',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.getTransactions),
);

reportsRouter.get(
  '/:id/transactions/:rowId',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(rowParams),
  catchAsync(reportsController.getTransaction),
);

const markReviewedSchema = z.object({ reviewed: z.boolean().optional() });

reportsRouter.patch(
  '/:id/transactions/:rowId/review',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(rowParams),
  validate(markReviewedSchema),
  catchAsync(reportsController.markRowReviewed),
);

// Manual resolution: a match pairs one unmatched internal row with one unmatched counterparty row;
// an explanation accepts 1–100 breaks. Neither changes the rows' status or amounts.
const resolveRowsSchema = z
  .object({
    kind: z.enum(['matched', 'explained']),
    rowIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Each transaction can only be listed once'),
    note: z.string().trim().min(1).max(1000),
  })
  .refine((body) => body.kind !== 'matched' || body.rowIds.length === 2, {
    message: 'A match pairs exactly two transactions',
    path: ['rowIds'],
  });

reportsRouter.post(
  '/:id/resolutions',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  validate(resolveRowsSchema),
  catchAsync(reportsController.resolveRows),
);

reportsRouter.delete(
  '/:id/resolutions/:resolutionId',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(z.object({ id: z.string().uuid(), resolutionId: z.string().uuid() })),
  catchAsync(reportsController.unresolve),
);

// Corrections override a source row's mapped value on the next run; the uploaded file is never changed.
const createCorrectionSchema = z.object({
  rowId: z.string().uuid(),
  side: z.enum(['A', 'B']),
  field: z.enum(['reference', 'amount', 'date', 'currency']),
  correctedValue: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
});

reportsRouter.get(
  '/:id/corrections',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.listCorrections),
);

reportsRouter.post(
  '/:id/corrections',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(idParams),
  validate(createCorrectionSchema),
  catchAsync(reportsController.createCorrection),
);

reportsRouter.delete(
  '/:id/corrections/:correctionId',
  authenticate,
  catchAsync(requirePermission('report', 'create')),
  validateParams(z.object({ id: z.string().uuid(), correctionId: z.string().uuid() })),
  catchAsync(reportsController.deleteCorrection),
);

reportsRouter.get(
  '/:id/break-breakdown',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
  catchAsync(reportsController.getBreakBreakdown),
);

reportsRouter.get(
  '/:id/trend',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  validateParams(idParams),
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
  validateParams(idParams),
  validate(exportSchema),
  catchAsync(reportsController.exportReport),
);

const emailSchema = z.object({ to: z.array(z.string().email()).min(1).max(20) });

reportsRouter.post(
  '/:id/email',
  authenticate,
  catchAsync(requirePermission('report', 'email')),
  validateParams(idParams),
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
