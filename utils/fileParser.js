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

function parseCsv(buffer) {
  const { data } = Papa.parse(buffer.toString('utf-8'), { header: true, skipEmptyLines: true });
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  return { headers, rows: data };
}

function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
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
