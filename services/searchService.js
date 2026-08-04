import { prisma } from '../config/prisma.config.js';
import { getUserMembership } from './organizationService.js';

const RESULT_LIMIT = 5;

/**
 * Global search, scoped to the caller's org: reconciliation reports (by
 * reconciliation name or file name) and team members (by name/email).
 * Empty/whitespace query returns empty results without querying.
 * @param {string} userId
 * @param {string} query
 */
export async function search(userId, query) {
  const q = query?.trim();
  if (!q) return { reports: [], members: [] };

  const { organizationId } = await getUserMembership(userId);

  const [reports, members] = await Promise.all([
    prisma.report.findMany({
      where: {
        organizationId,
        status: 'completed', // drafts are private/incomplete, shouldn't surface via search
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { fileAName: { contains: q, mode: 'insensitive' } },
          { fileBName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, fileAName: true, fileBName: true, runDate: true },
      orderBy: { runDate: 'desc' },
      take: RESULT_LIMIT,
    }),
    prisma.member.findMany({
      where: {
        organizationId,
        user: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] },
      },
      select: { id: true, role: true, user: { select: { id: true, name: true, email: true } } },
      take: RESULT_LIMIT,
    }),
  ]);

  return { reports, members };
}
