// recon-backend/types/recon.js (mirrored manually in recon-frontend/lib/types/recon.ts)
//
// Plain JS has no types at compile time — these are JSDoc typedefs purely
// for editor intellisense (hover/autocomplete), not enforced at runtime.

/**
 * @typedef {'matched'|'mismatched'|'unmatched_a'|'unmatched_b'|'duplicate'} ReconStatus
 */

/**
 * @typedef {Object} ReconConfig
 * @property {number} amountTolerance
 * @property {number} [dateToleranceDays]
 */

/**
 * @typedef {Object} ReconRow
 * @property {string} ref
 * @property {ReconStatus} status
 * @property {number|null} amountA
 * @property {number|null} amountB
 * @property {number|null} amountDiff - amountA - amountB
 * @property {string|null} [dateA]
 * @property {string|null} [dateB]
 * @property {Record<string, string>|null} [rawA]
 * @property {Record<string, string>|null} [rawB]
 */

/**
 * @typedef {Object} ReconSummary
 * @property {number} total
 * @property {number} matched
 * @property {number} mismatched
 * @property {number} unmatchedA
 * @property {number} unmatchedB
 * @property {number} duplicates
 * @property {number} matchRate - matched / total * 100
 * @property {number} totalBreakValue - sum of |amountDiff| on mismatched rows
 * @property {number} durationMs
 */

/**
 * POST /reports — request body
 * @typedef {Object} SaveReportDto
 * @property {string} fileAName
 * @property {string} fileBName
 * @property {ReconSummary} summary
 * @property {ReconRow[]} rows - stored in report_rows table
 * @property {ReconConfig} config - tolerances used
 */
