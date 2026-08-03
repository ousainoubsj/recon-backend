import { prisma } from '../config/prisma.config.js';
import { getWeeklyDigestStats } from './reportService.js';
import { sendWeeklyDigestEmail } from './emailService.js';
import { createNotification } from './notificationService.js';

// Org-wide, admin-only — not a per-user opt-in. Every active admin in an org
// that has weeklyDigestEnabled on gets both an email and an in-app
// notification (a database row only; there's no notification panel UI in
// this app yet — matches how member.role_changed/invitation.accepted/etc.
// already behave). Orgs with zero completed reports in the past week are
// skipped entirely, deliberately, to avoid an empty "0 reconciliations"
// digest every week for inactive orgs.
export async function sendWeeklyDigests() {
  const orgs = await prisma.organization.findMany({
    where: { weeklyDigestEnabled: true },
    select: { id: true, name: true },
  });

  for (const org of orgs) {
    const stats = await getWeeklyDigestStats(org.id);
    if (stats.current.count === 0) continue;

    const admins = await prisma.member.findMany({
      where: { organizationId: org.id, role: 'admin', status: 'active' },
      select: { user: { select: { id: true, email: true, name: true } } },
    });

    for (const { user } of admins) {
      try {
        await sendWeeklyDigestEmail(user, org.name, stats);
        await createNotification(user.id, {
          type: 'organization.weekly_digest_sent',
          message: `Weekly digest for ${org.name}: ${stats.current.count} reconciliation${stats.current.count === 1 ? '' : 's'}, ${stats.current.avgMatchRate.toFixed(1)}% match rate`,
          entityType: 'organization',
          entityId: org.id,
        });
      } catch (err) {
        console.error('Failed to send weekly digest', user.id, org.id, err);
      }
    }
  }
}
