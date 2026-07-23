import PDFDocument from 'pdfkit';
import { computeCategoryStats, getBreakRows, getNonMatchedRows } from './reportSections.js';

const MAX_DETAIL_ROWS = 200; // keep the PDF a sane length for very large runs

function drawBarChart(doc, stats) {
  const startX = doc.x;
  let y = doc.y;
  const maxCount = Math.max(1, ...stats.map((s) => s.count));
  const barMaxWidth = 260;

  for (const stat of stats) {
    const width = (stat.count / maxCount) * barMaxWidth;
    doc.rect(startX, y, Math.max(width, 1), 14).fill('#4F46E5');
    doc
      .fillColor('black')
      .fontSize(9)
      .text(`${stat.category}: ${stat.count} (${stat.percent}%)`, startX + barMaxWidth + 10, y + 2);
    y += 20;
  }

  doc.x = startX;
  doc.y = y + 10;
}

/**
 * @param {object} report - a Report row with its `rows` included
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @returns {Promise<Buffer>}
 */
export function buildPdfReport(report, sections) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(report.name || 'Reconciliation Report', { align: 'center' });
    doc.moveDown(0.5);
    doc
      .fontSize(10)
      .fillColor('gray')
      .text(`${report.fileAName ?? ''} vs ${report.fileBName ?? ''}`, { align: 'center' });
    doc.text(new Date(report.runDate).toLocaleString(), { align: 'center' });
    doc.fillColor('black').moveDown();

    // Full matched-row detail is always included — none of the 5 toggles is
    // about hiding the core result, they're additive extras on top of it.
    doc.fontSize(14).text('Matched Transactions');
    doc.fontSize(10);
    doc.text(`${report.matchedCount} matched rows`);
    doc.moveDown();

    if (sections.summary) {
      doc.fontSize(14).text('Summary');
      doc.fontSize(10);
      doc.text(`Total Rows: ${report.totalRows}`);
      doc.text(`Matched: ${report.matchedCount}`);
      doc.text(`Mismatched: ${report.mismatchedCount}`);
      doc.text(`Unmatched: ${report.unmatchedCount}`);
      doc.text(`Duplicates: ${report.duplicateCount}`);
      doc.text(`Total Break Value: ${Number(report.totalBreakValue).toFixed(2)}`);
      doc.moveDown();
    }

    if (sections.matchStatistics) {
      doc.fontSize(14).text('Match Statistics');
      doc.fontSize(10);
      for (const stat of computeCategoryStats(report)) {
        doc.text(`${stat.category}: ${stat.count} (${stat.percent}%)`);
      }
      doc.moveDown();
    }

    if (sections.breakAnalysis) {
      const breakRows = getBreakRows(report);
      doc.fontSize(14).text('Break Analysis');
      doc.fontSize(10);
      doc.text(`Rows with a break: ${breakRows.length}`);
      for (const row of breakRows.slice(0, MAX_DETAIL_ROWS)) {
        doc.text(`${row.ref}: diff ${Number(row.amountDiff).toFixed(2)}`);
      }
      doc.moveDown();
    }

    if (sections.unmatchedDetails) {
      const nonMatched = getNonMatchedRows(report);
      doc.fontSize(14).text('Unmatched Details');
      doc.fontSize(10);
      for (const row of nonMatched.slice(0, MAX_DETAIL_ROWS)) {
        doc.text(`${row.ref} — ${row.status}`);
      }
      doc.moveDown();
    }

    if (sections.chartsAndGraphs) {
      doc.fontSize(14).text('Charts & Graphs');
      doc.moveDown(0.5);
      drawBarChart(doc, computeCategoryStats(report));
    }

    doc.end();
  });
}
