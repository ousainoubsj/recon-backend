// Mirrors the frontend's formatReportReference (recon-frontend/lib/format.ts)
// exactly — audit-log metadata and generated files should show the same
// human-readable REC-YYYY-NNNNNN reference the UI does, not the raw UUID.
// Lives in utils/ (not services/reportService.js, where it originated) so
// dependency-free consumers like utils/pdfReport.js can use it without
// pulling in reportService.js's Prisma/db dependency.
export function formatReportReference(sequenceYear, sequenceNumber) {
  if (sequenceYear == null || sequenceNumber == null) return null;
  return `REC-${sequenceYear}-${String(sequenceNumber).padStart(6, '0')}`;
}
