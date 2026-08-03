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

async function sendEmail({ to, subject, html, text, attachments }) {
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
