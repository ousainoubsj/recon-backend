import { Resend } from 'resend';
import { renderEmailTemplate, escapeHtmlForEmail, htmlToText } from '../utils/emailTemplate.js';

const resend = new Resend(process.env.RESEND_API_KEY);

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
  const html = await renderEmailTemplate('email-report', {
    fileAName: escapeHtmlForEmail(report.fileAName),
    fileBName: escapeHtmlForEmail(report.fileBName),
    matchedCount: report.matchedCount,
    totalRows: report.totalRows,
    runDateFormatted: escapeHtmlForEmail(formatDate(report.runDate)),
  });

  await sendEmail({
    to,
    subject: `Reconciliation report — ${report.fileAName} vs ${report.fileBName}`,
    html,
    text: htmlToText(html),
  });
}

/**
 * Fired by services/scheduledReportRunner.js after generating a scheduled
 * export — same template as sendReportEmail, but attaches the generated
 * file and can go to multiple recipients at once.
 * @param {object} report
 * @param {Buffer} buffer
 * @param {'xlsx'|'pdf'} format
 * @param {string[]} recipients
 */
export async function sendScheduledReportEmail(report, buffer, format, recipients) {
  const html = await renderEmailTemplate('email-report', {
    fileAName: escapeHtmlForEmail(report.fileAName ?? ''),
    fileBName: escapeHtmlForEmail(report.fileBName ?? ''),
    matchedCount: report.matchedCount,
    totalRows: report.totalRows,
    runDateFormatted: escapeHtmlForEmail(formatDate(report.runDate)),
  });

  await sendEmail({
    to: recipients,
    subject: `Scheduled reconciliation report — ${report.fileAName ?? ''} vs ${report.fileBName ?? ''}`,
    html,
    text: htmlToText(html),
    attachments: [{ filename: `reconciliation_report_${report.id}.${format}`, content: buffer }],
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
