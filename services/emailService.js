import { Resend } from 'resend';
import { renderEmailTemplate, escapeHtmlForEmail, htmlToText } from '../utils/emailTemplate.js';
import { formatReportReference } from '../utils/reportReference.js';

const resend = new Resend(process.env.RESEND_API_KEY);

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatCurrency(value) {
  return currencyFormatter.format(Number(value ?? 0));
}

// The tracked .env ships RESEND_API_KEY=re_xxx as a placeholder — real
// delivery is unverified until a real key is set (see backend-implementation
// -checklist.md §12.5). Rather than let every email silently fail against
// that placeholder, fall back to logging the content to the console. Test
// env sets RESEND_API_KEY to a different dummy value (tests/setupEnv.js),
// so this only engages against the real placeholder or an unset key.
function isResendConfigured() {
  const key = process.env.RESEND_API_KEY;
  return Boolean(key) && key !== 're_xxx';
}

async function sendEmail({ to, subject, html, text, attachments, replyTo }) {
  if (!isResendConfigured()) {
    console.warn(`[email:dev-fallback] RESEND_API_KEY not configured — logging email instead of sending.`);
    console.warn(`[email:dev-fallback] To: ${to}\nSubject: ${subject}\n${text}`);
    if (attachments?.length) {
      console.warn(`[email:dev-fallback] Would have attached: ${attachments.map((a) => a.filename).join(', ')}`);
    }
    return { success: true, messageId: 'dev-fallback' };
  }

  // The Resend SDK reports failures via `result.error`, not by throwing —
  // an unchecked `result.data.id` would silently report success on failure.
  const result = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
    text,
    ...(attachments?.length ? { attachments } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
  if (result.error) {
    console.error(`Error sending email to ${to}`, result.error);
    throw new Error(result.error.message ?? 'Failed to send email');
  }
  return { success: true, messageId: result.data.id };
}

function formatDate(date) {
  return date ? new Date(date).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'see link';
}

export async function sendReportEmail(report, to) {
  const reference = formatReportReference(report.sequenceYear, report.sequenceNumber) ?? report.id?.slice(0, 8).toUpperCase();
  const matchedCount = report.matchedCount ?? 0;
  const mismatchedCount = report.mismatchedCount ?? 0;
  const unmatchedCount = report.unmatchedCount ?? 0;
  const duplicateCount = report.duplicateCount ?? 0;
  const totalRows = report.totalRows ?? 0;
  const matchPercent = totalRows > 0 ? (matchedCount / totalRows) * 100 : 0;
  const unmatchedOrMismatched = unmatchedCount + mismatchedCount;

  // Same phrasing as the PDF/XLSX exports' own Executive Summary section
  // (utils/pdfReport.js, utils/xlsxReport.js) — the email, PDF, and XLSX
  // should all describe a given report's outcome identically.
  const executiveSummary =
    `Out of ${totalRows} total transaction${totalRows === 1 ? '' : 's'}, ${matchedCount} (${matchPercent.toFixed(2)}%) were successfully matched. There ` +
    `${unmatchedOrMismatched === 1 ? 'is' : 'are'} ${unmatchedOrMismatched} unmatched or mismatched ` +
    `transaction${unmatchedOrMismatched === 1 ? '' : 's'} with a total break value of ${formatCurrency(report.totalBreakValue)}.`;

  const html = await renderEmailTemplate('email-report', {
    reference: escapeHtmlForEmail(reference ?? ''),
    fileAName: escapeHtmlForEmail(report.fileAName),
    fileBName: escapeHtmlForEmail(report.fileBName),
    runDateFormatted: escapeHtmlForEmail(formatDate(report.runDate)),
    executiveSummary: escapeHtmlForEmail(executiveSummary),
    matchRate: `${matchPercent.toFixed(1)}%`,
    totalRows,
    matchedCount,
    mismatchedCount,
    unmatchedCount,
    duplicateCount,
    totalBreakValue: formatCurrency(report.totalBreakValue),
  });

  await sendEmail({
    to,
    subject: `Reconciliation report — ${report.fileAName} vs ${report.fileBName}`,
    html,
    text: htmlToText(html),
  });
}

// Combined Report's email — a stats comparison across 2+ reconciliations,
// same content shape as utils/xlsxComparisonReport.js/pdfComparisonReport.js
// (avg match rate, total break value, per-run match rate), not a merge.
// renderEmailTemplate has no loop construct, so the per-run table body is
// built here and substituted in as one pre-rendered HTML string — report
// names are user-entered, so each cell is still escaped individually before
// being assembled into that string.
export async function sendComparisonReportEmail(reports, to) {
  const sorted = [...reports].sort((a, b) => new Date(a.runDate) - new Date(b.runDate));
  const runStats = sorted.map((r) => {
    const totalRows = r.totalRows ?? 0;
    const matchedCount = r.matchedCount ?? 0;
    return {
      name: r.name || 'Untitled Reconciliation',
      runDate: r.runDate,
      matchPercent: totalRows > 0 ? (matchedCount / totalRows) * 100 : 0,
    };
  });

  const avgMatchRate = runStats.length > 0 ? runStats.reduce((sum, r) => sum + r.matchPercent, 0) / runStats.length : 0;
  const totalBreakValue = sorted.reduce((sum, r) => sum + Number(r.totalBreakValue ?? 0), 0);
  const dateRangeFormatted =
    runStats.length > 0 ? `${formatDate(runStats[0].runDate)} – ${formatDate(runStats[runStats.length - 1].runDate)}` : 'see link';

  const runsRows = runStats
    .map(
      (r) =>
        `<tr><td style="padding: 8px 0; border-bottom: 1px solid #E5E7EB;">${escapeHtmlForEmail(r.name)}</td>` +
        `<td style="padding: 8px 0; border-bottom: 1px solid #E5E7EB; text-align: right; color: #6B7280;">${escapeHtmlForEmail(formatDate(r.runDate))}</td>` +
        `<td style="padding: 8px 0; border-bottom: 1px solid #E5E7EB; text-align: right; font-weight: 600;">${r.matchPercent.toFixed(1)}%</td></tr>`,
    )
    .join('');

  const html = await renderEmailTemplate('email-comparison-report', {
    runCount: runStats.length,
    dateRangeFormatted: escapeHtmlForEmail(dateRangeFormatted),
    avgMatchRate: `${avgMatchRate.toFixed(1)}%`,
    totalBreakValue: formatCurrency(totalBreakValue),
    runsRows,
  });

  await sendEmail({
    to,
    subject: `Combined report — comparing ${runStats.length} reconciliations`,
    html,
    text: htmlToText(html),
  });
}

/**
 * Wired into Better Auth's organization plugin `sendInvitationEmail` option.
 * @param {{id: string, role: string, email: string, organization: {name: string}, invitation?: {expiresAt?: string|Date}, inviter: {user: {name: string, email: string}}}} data
 */
export async function sendOrgInvitationEmail(data) {
  const acceptLink = `${process.env.FRONTEND_URL}/accept-invite/${data.id}`;
  const html = await renderEmailTemplate('email-invitation', {
    organizationName: escapeHtmlForEmail(data.organization.name),
    inviterName: escapeHtmlForEmail(data.inviter.user.name || data.inviter.user.email),
    role: escapeHtmlForEmail(data.role),
    acceptLink,
    expiresFormatted: escapeHtmlForEmail(formatDate(data.invitation?.expiresAt)),
  });

  await sendEmail({
    to: data.email,
    subject: `You've been invited to join ${data.organization.name}`,
    html,
    text: htmlToText(html),
  });
}

/**
 * Wired into Better Auth's `emailAndPassword.sendResetPassword` option.
 * @param {{email: string}} user
 * @param {string} url
 */
export async function sendPasswordResetEmail(user, url) {
  const html = await renderEmailTemplate('email-reset-password', {
    url,
    expiresInMinutes: 60, // matches Better Auth's default resetPasswordTokenExpiresIn (3600s)
  });

  await sendEmail({
    to: user.email,
    subject: 'Reset your password',
    html,
    text: htmlToText(html),
  });
}

/**
 * Wired into the `emailOTP` plugin's `sendVerificationOTP` option.
 * @param {{email: string, otp: string, type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'}} data
 */
function formatWeekRange(weekStart, weekEnd) {
  const start = new Date(weekStart);
  const end = new Date(new Date(weekEnd).getTime() - 1); // weekEnd is exclusive
  return `${formatDate(start)} – ${formatDate(end)}`;
}

// Headline comparison line — mirrors the "no baseline yet" convention used
// by dashboard's deltaPercent (null when there's nothing to compare against)
// and StatsOverview's "No comparison yet" badge, just as a plain sentence
// since this is plain-text-friendly email copy, not a UI badge.
function buildComparisonLine(current, prior) {
  if (prior.count === 0) return 'No prior week to compare against yet.';
  const delta = current.avgMatchRate - prior.avgMatchRate;
  if (Math.abs(delta) < 0.05) return 'Match rate was about the same as last week.';
  const direction = delta > 0 ? 'better' : 'worse';
  return `${Math.abs(delta).toFixed(1)}% ${direction} match rate than last week.`;
}

// Org-wide digest (not per-user) — sent to every active admin in an org that
// has Weekly Digest enabled. `stats` is exactly reportService.js's
// getWeeklyDigestStats(organizationId) return shape.
export async function sendWeeklyDigestEmail(admin, organizationName, stats) {
  const html = await renderEmailTemplate('email-weekly-digest', {
    name: escapeHtmlForEmail(admin.name ?? 'there'),
    organizationName: escapeHtmlForEmail(organizationName),
    weekRangeFormatted: escapeHtmlForEmail(formatWeekRange(stats.weekStart, stats.weekEnd)),
    reconciliationCount: stats.current.count,
    avgMatchRate: `${stats.current.avgMatchRate.toFixed(1)}%`,
    unmatchedCount: stats.current.unmatchedTransactions,
    totalBreakValue: formatCurrency(stats.current.totalBreakValue),
    comparisonLine: escapeHtmlForEmail(buildComparisonLine(stats.current, stats.prior)),
    dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
  });

  await sendEmail({
    to: admin.email,
    subject: `Weekly digest — ${organizationName}`,
    html,
    text: htmlToText(html),
  });
}

export async function sendOtpEmail({ email, otp }) {
  const html = await renderEmailTemplate('email-otp', {
    otp,
    expiresInMinutes: 5, // matches the emailOTP plugin's default expiresIn (300s)
  });

  await sendEmail({
    to: email,
    subject: 'Your verification code',
    html,
    text: htmlToText(html),
  });
}

const SUPPORT_EMAIL = 'admin@datafin.info';

// Fixed recipient (not org-configurable) — the "Need help?" dialog in
// Header.tsx. `replyTo` is the requester's own address so the admin can just
// hit reply instead of looking up who sent it.
export async function sendSupportRequestEmail({ name, email, organizationName, message }) {
  const html = await renderEmailTemplate('email-support-request', {
    name: escapeHtmlForEmail(name),
    email: escapeHtmlForEmail(email),
    organizationName: escapeHtmlForEmail(organizationName),
    message: escapeHtmlForEmail(message),
  });

  await sendEmail({
    to: SUPPORT_EMAIL,
    subject: `Help request from ${name}`,
    html,
    text: htmlToText(html),
    replyTo: email,
  });
}
