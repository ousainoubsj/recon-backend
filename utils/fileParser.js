import { GetObjectCommand } from '@aws-sdk/client-s3';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { r2 } from './r2Client.js';

export async function downloadFromR2(key) {
  const { Body } = await r2.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }),
  );
  const chunks = [];
  for await (const chunk of Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// A title/banner row (e.g. "Monthly Bank Statement — August 2026") typically
// has just one populated cell trailing into empty ones, while a real header
// row has most/all columns populated. Scans a bounded window from the top of
// the sheet and picks the first row clearing the threshold; if nothing does
// (e.g. a legitimately sparse header), fails safe to row 0 — today's
// behavior — rather than guessing wrong silently.
const HEADER_SCAN_ROWS = 10;
const HEADER_ROW_THRESHOLD = 0.5;
// A CSV title row is narrower than the real table (e.g. one comma-free line
// of banner text vs. N comma-separated columns below it) — XLSX rows come
// back already padded to the sheet's full column count, so this mostly
// matters for CSV, but applying it uniformly is harmless either way. Require
// a row to span most of the widest row seen in the scan window before its
// fill ratio counts as meaningful, so a single dense cell can't masquerade
// as a header.
const HEADER_ROW_WIDTH_THRESHOLD = 0.7;

function detectHeaderRowIndex(rows) {
  const scanLimit = Math.min(rows.length, HEADER_SCAN_ROWS);
  const maxCols = Math.max(0, ...rows.slice(0, scanLimit).map((row) => (row ? row.length : 0)));
  if (maxCols === 0) return 0;
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (row.length < maxCols * HEADER_ROW_WIDTH_THRESHOLD) continue;
    const nonEmpty = row.filter((cell) => String(cell ?? '').trim() !== '').length;
    if (nonEmpty / row.length > HEADER_ROW_THRESHOLD) return i;
  }
  return 0;
}

function isBlankRow(row) {
  return Object.values(row).every((value) => String(value ?? '').trim() === '');
}

// Blank headers (both '' from a genuinely empty cell) or duplicate header
// text (two columns literally named the same thing) would otherwise collide
// as object keys once rowsFromAoa builds each row — the later column
// silently overwriting the earlier one's data, with the returned headers
// list still showing both as identical, undifferentiable choices in the
// mapping UI. Blank headers get a positional placeholder first; anything
// left duplicated (including a placeholder colliding with a real header
// elsewhere) gets a " (n)" suffix, probed against everything already
// assigned so the suffix itself can't collide with a pre-existing header.
function dedupeHeaders(headerRow) {
  const base = headerRow.map((cell, i) => {
    const s = String(cell ?? '');
    return s.trim() === '' ? `Column ${i + 1}` : s;
  });
  const used = new Set();
  return base.map((name) => {
    let candidate = name;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${name} (${n})`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

// Shared by both parsers once each has reduced its sheet/CSV to raw
// string-array rows — builds the {headers, rows} shape from a chosen header
// row plus the data rows beneath it, dropping rows that are blank in
// substance (every cell empty) even if they weren't wholly absent from the
// source (e.g. a formatted-but-empty Excel row, or a `,,,`-only CSV line).
function rowsFromAoa(headerRow, dataRows) {
  const headers = dedupeHeaders(headerRow);
  const rows = dataRows
    .map((cells) => {
      const row = {};
      headers.forEach((header, i) => {
        row[header] = cells[i] != null ? String(cells[i]) : '';
      });
      return row;
    })
    .filter((row) => !isBlankRow(row));
  return { headers, rows };
}

function parseCsv(buffer) {
  const { data } = Papa.parse(buffer.toString('utf-8'), { header: false, skipEmptyLines: true });
  if (data.length === 0) return { headers: [], rows: [] };
  const headerIndex = detectHeaderRowIndex(data);
  return rowsFromAoa(data[headerIndex], data.slice(headerIndex + 1));
}

function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (aoa.length === 0) return { headers: [], rows: [] };
  const headerIndex = detectHeaderRowIndex(aoa);
  return rowsFromAoa(aoa[headerIndex], aoa.slice(headerIndex + 1));
}

// Dispatches on the file's display name (already validated at presign time —
// see controllers/files.controller.js's ALLOWED_CONTENT_TYPES), not its
// content type, since that's all the matching engine has by the time it's
// downloading bytes from R2. Both branches return the same {headers, rows}
// shape — rows as string-keyed maps, matching ReportRow.rawA/rawB directly.
export function parseTabularFile(buffer, filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return parseCsv(buffer);
  if (ext === 'xls' || ext === 'xlsx') return parseXlsx(buffer);
  throw new Error(`Unsupported file extension: ${ext}`);
}
