// recon-backend/types/file.js (mirrored manually in recon-frontend/lib/types/file.ts)
//
// Plain JS has no types at compile time — these are JSDoc typedefs purely
// for editor intellisense (hover/autocomplete), not enforced at runtime.

/**
 * @typedef {Object} FileRow
 * @property {string} ref - reference number — primary match key
 * @property {number} amount - parsed float, always positive
 * @property {string} [date] - ISO-8601 YYYY-MM-DD, optional
 * @property {string} [currency] - ISO-4217 three-letter code, optional
 * @property {Record<string, string>} raw - original row for display
 */

/**
 * @typedef {Object} ColumnMap
 * @property {string} ref - e.g. "Invoice No"
 * @property {string} amount - e.g. "Amount (USD)"
 * @property {string} [date]
 * @property {string} [currency]
 */
