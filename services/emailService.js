import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendReportEmail(report, to) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `Reconciliation report — ${report.fileAName} vs ${report.fileBName}`,
    text: `Matched: ${report.matchedCount}/${report.totalRows} (run ${report.runDate.toISOString()})`,
  });
}

/**
 * Wired into Better Auth's organization plugin `sendInvitationEmail` option.
 * @param {{id: string, role: string, email: string, organization: {name: string}, inviter: {user: {email: string}}}} data
 */
export async function sendOrgInvitationEmail(data) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: data.email,
    subject: `You've been invited to join ${data.organization.name}`,
    text: `${data.inviter.user.email} invited you to join ${data.organization.name} as ${data.role}. Accept: ${process.env.FRONTEND_URL}/accept-invite/${data.id}`,
  });
}
