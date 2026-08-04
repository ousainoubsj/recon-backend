import { prisma } from '../config/prisma.config.js';
import { getUserMembership } from './organizationService.js';
import { sendSupportRequestEmail } from './emailService.js';

export async function sendHelpRequest(userId, message) {
  const [user, { organizationId }] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId }, select: { name: true, email: true } }),
    getUserMembership(userId),
  ]);
  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { name: true } });

  await sendSupportRequestEmail({
    name: user.name,
    email: user.email,
    organizationName: org?.name ?? '—',
    message,
  });
}
