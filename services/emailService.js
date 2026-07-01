import { Resend } from 'resend';
import { renderEmailTemplate, escapeHtmlForEmail, htmlToText } from '../utils/emailTemplate.js';

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail({ to, subject, html, text }) {
  // The Resend SDK reports failures via `result.error`, not by throwing —
  // an unchecked `result.data.id` would silently report success on failure.
  const result = await resend.emails.send({ from: process.env.EMAIL_FROM, to, subject, html, text });
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
 * Wired into Better Auth's organization plugin `sendInvitationEmail` option.
 * @param {{id: string, role: string, email: string, organization: {name: string}, invitation?: {expiresAt?: string|Date}, inviter: {user: {email: string}}}} data
 */
export async function sendOrgInvitationEmail(data) {
  const acceptLink = `${process.env.FRONTEND_URL}/accept-invite/${data.id}`;
  const html = await renderEmailTemplate('email-invitation', {
    organizationName: escapeHtmlForEmail(data.organization.name),
    inviterEmail: escapeHtmlForEmail(data.inviter.user.email),
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
