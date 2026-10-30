import { randomBytes } from 'node:crypto';
import { generateId } from 'better-auth';
import { prisma } from '../config/prisma.config.js';
import { AuthorisationError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { sendOrgInvitationEmail } from './emailService.js';
import { deleteR2Objects, deleteR2Prefix } from '../utils/r2Client.js';

// Platform owner/admins acting across companies (docs/SUPER_ADMIN_PLAN.md). `actor` is the session user, whose
// platformRole the route has already checked.

const INVITATION_EXPIRES_MS = 48 * 60 * 60 * 1000; // Better Auth's default invitationExpiresIn (organization/adapter.mjs)

const COMPANY_SELECT = {
  id: true,
  name: true,
  slug: true,
  logo: true,
  status: true,
  createdAt: true,
  suspendedAt: true,
  _count: { select: { members: { where: { isSupport: false } }, reports: true } },
};

const toCompany = ({ _count, ...company }) => ({ ...company, memberCount: _count.members, reportCount: _count.reports });

// Fail closed: the owner reaches every company, an admin only those assigned to them. Zero rows means none.
function companyAccess(actor) {
  return actor.platformRole === 'owner' ? {} : { platformAdmins: { some: { userId: actor.id } } };
}

async function findAccessibleCompany(actor, id, select = COMPANY_SELECT) {
  const company = await prisma.organization.findFirst({ where: { AND: [{ id }, companyAccess(actor)] }, select });
  if (!company) throw new NotFoundError('Company not found');
  return company;
}

// Written directly: createAuditLog resolves the org through getUserMembership, and a platform admin outside a
// company has none. Company actions land in that company's log; admin management and deletes have no org.
export async function recordPlatformAudit(actorId, { organizationId = null, action, entityType, entityId, metadata, ip, userAgent }) {
  try {
    await prisma.auditLog.create({
      data: { userId: actorId, organizationId, action, entityType, entityId, metadata, ip: ip ?? null, userAgent: userAgent ?? null },
    });
  } catch (err) {
    console.error('Failed to write audit log', action, entityId, err);
  }
}

async function assertNotPlatformEmail(email) {
  const staff = await prisma.user.findFirst({ where: { email, platformRole: { not: null } }, select: { id: true } });
  if (staff) throw new ConflictError('That email belongs to a platform admin');
}

// --- Sign-in and request gates ---

/** Why this user must not get a session, or null. Support memberships never block. */
export async function signInBlockReason(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      platformRole: true,
      platformStatus: true,
      members: { where: { isSupport: false }, select: { organization: { select: { status: true } } } },
    },
  });
  if (!user) return null;
  if (user.platformRole && user.platformStatus !== 'active') return 'Platform access has been revoked';
  if (user.members.some((m) => m.organization.status === 'suspended')) return "Your company's account has been suspended";
  return null;
}

/** A platform admin invited by the owner has no login yet; their first "reset" email is the onboarding email. */
export async function isAwaitingFirstPassword(userId) {
  const logins = await prisma.account.count({ where: { userId } });
  return logins === 0;
}

// --- Companies ---

export async function listCompanies(actor, { q, status, offset = 0, limit = 20 }) {
  const conditions = [companyAccess(actor)];
  if (q) conditions.push({ OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] });
  if (status) conditions.push({ status });
  const where = { AND: conditions };

  const [companies, total] = await Promise.all([
    prisma.organization.findMany({ where, select: COMPANY_SELECT, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
    prisma.organization.count({ where }),
  ]);
  return { items: companies.map(toCompany), total };
}

export async function getCompany(actor, id) {
  return toCompany(await findAccessibleCompany(actor, id));
}

/** One invitation per address: an unexpired pending one is refreshed and re-sent instead of duplicated. */
async function inviteToCompany(tx, actor, company, { email, role }) {
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRES_MS);
  const existing = await tx.invitation.findFirst({
    where: { organizationId: company.id, email, status: 'pending', expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (existing) return tx.invitation.update({ where: { id: existing.id }, data: { role, expiresAt, inviterId: actor.id } });
  return tx.invitation.create({
    data: { id: generateId(), organizationId: company.id, email, role, status: 'pending', expiresAt, inviterId: actor.id, createdAt: new Date() },
  });
}

function sendCompanyInvitation(actor, company, invitation) {
  return sendOrgInvitationEmail({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    organization: { name: company.name },
    inviter: { user: { name: actor.name, email: actor.email } },
    invitation: { expiresAt: invitation.expiresAt },
  });
}

export async function createCompany(actor, { name, firstAdminEmail }, { ip, userAgent } = {}) {
  const email = firstAdminEmail.trim().toLowerCase();
  await assertNotPlatformEmail(email);

  const { company, invitation } = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: { id: generateId(), name: name.trim(), slug: `co-${randomBytes(5).toString('hex')}`, createdAt: new Date() },
      select: COMPANY_SELECT,
    });
    // An admin who creates a company must be able to see it.
    if (actor.platformRole === 'admin') {
      await tx.platformAdminCompany.create({ data: { userId: actor.id, organizationId: created.id, assignedBy: actor.id } });
    }
    return { company: created, invitation: await inviteToCompany(tx, actor, created, { email, role: 'admin' }) };
  });

  // The company and invitation exist either way; a failed email is re-sent from "Invite user".
  await sendCompanyInvitation(actor, company, invitation).catch((err) =>
    console.error('Failed to send first-admin invitation', company.id, err),
  );
  await recordPlatformAudit(actor.id, {
    organizationId: company.id,
    action: 'platform.company.create',
    entityType: 'organization',
    entityId: company.id,
    metadata: { name: company.name, firstAdminEmail: email },
    ip,
    userAgent,
  });
  return toCompany(company);
}

export async function updateCompany(actor, id, { name }, { ip, userAgent } = {}) {
  const before = await findAccessibleCompany(actor, id, { id: true, name: true });
  const company = await prisma.organization.update({ where: { id: before.id }, data: { name: name.trim() }, select: COMPANY_SELECT });
  await recordPlatformAudit(actor.id, {
    organizationId: id,
    action: 'platform.company.rename',
    entityType: 'organization',
    entityId: id,
    metadata: { before: before.name, after: company.name },
    ip,
    userAgent,
  });
  return toCompany(company);
}

export async function setCompanyStatus(actor, id, status, { ip, userAgent } = {}) {
  const before = await findAccessibleCompany(actor, id, { id: true, status: true });
  if (before.status === status) throw new ConflictError(`Company is already ${status}`);

  const company = await prisma.$transaction(async (tx) => {
    const updated = await tx.organization.update({
      where: { id },
      data: { status, suspendedAt: status === 'suspended' ? new Date() : null },
      select: COMPANY_SELECT,
    });
    // Members are signed out everywhere; support memberships (platform admins inside it) are left alone.
    if (status === 'suspended') {
      await tx.session.deleteMany({ where: { user: { members: { some: { organizationId: id, isSupport: false } } } } });
    }
    return updated;
  });

  await recordPlatformAudit(actor.id, {
    organizationId: id,
    action: status === 'suspended' ? 'platform.company.suspend' : 'platform.company.activate',
    entityType: 'organization',
    entityId: id,
    ip,
    userAgent,
  });
  return toCompany(company);
}

export async function inviteCompanyUser(actor, id, { email: rawEmail, role }, { ip, userAgent } = {}) {
  const company = await findAccessibleCompany(actor, id, { id: true, name: true });
  const email = rawEmail.trim().toLowerCase();
  await assertNotPlatformEmail(email);

  const alreadyMember = await prisma.member.findFirst({
    where: { organizationId: id, isSupport: false, user: { email } },
    select: { id: true },
  });
  if (alreadyMember) throw new ConflictError('That person is already a member of this company');

  const invitation = await prisma.$transaction((tx) => inviteToCompany(tx, actor, company, { email, role }));
  await sendCompanyInvitation(actor, company, invitation);
  await recordPlatformAudit(actor.id, {
    organizationId: id,
    action: 'platform.company.invite',
    entityType: 'invitation',
    entityId: invitation.id,
    metadata: { email, role },
    ip,
    userAgent,
  });
}

/**
 * Removes a company with no way back: the company, every member account whose only company it is, its audit
 * trail and its R2 files. Platform admins inside it keep their accounts. Shared by the owner's delete and an org
 * admin's Settings delete; callers check who may do it and write the audit row.
 * @returns {Promise<{ memberIds: string[], reportCount: number }>}
 */
export async function purgeCompany(id) {
  const running = await prisma.report.count({ where: { organizationId: id, status: 'processing' } });
  if (running > 0) throw new ConflictError('A reconciliation is running in this company. Delete it once the run finishes.');

  // Read before the transaction: the cascade removes the rows that hold these keys.
  const members = await prisma.user.findMany({
    where: {
      members: { some: { organizationId: id, isSupport: false } },
      NOT: { members: { some: { organizationId: { not: id }, isSupport: false } } },
    },
    select: { id: true },
  });
  const memberIds = members.map((m) => m.id);
  const reports = await prisma.report.findMany({ where: { organizationId: id }, select: { id: true, fileAKey: true, fileBKey: true } });
  // Imported here: reportService pulls in the BullMQ queues, which auth.js (an importer of this module) must not.
  const { reportFileKeys } = await import('./reportService.js');
  const reportKeys = await reportFileKeys(reports, id);
  const prefixes = [...memberIds.map((userId) => `uploads/${userId}/`), `exports/${id}/`, `org-logos/${id}/`];

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { organizationId: id } });
    await tx.session.updateMany({ where: { activeOrganizationId: id }, data: { activeOrganizationId: null } });
    await tx.organization.delete({ where: { id } });
    await tx.user.deleteMany({ where: { id: { in: memberIds } } });
  });

  // After commit, best-effort like report deletes: a failure leaves orphaned files (logged), never half a company.
  try {
    await deleteR2Objects(reportKeys);
    for (const prefix of prefixes) await deleteR2Prefix(prefix);
  } catch (err) {
    console.error('Failed to delete company files from R2', id, err);
  }

  return { memberIds, reportCount: reports.length };
}

/** Owner only, suspended companies only. Recorded as a platform audit row. */
export async function deleteCompany(actor, id, { ip, userAgent } = {}) {
  // The route allows only the owner too; irreversible, so the service doesn't rely on that alone.
  if (actor.platformRole !== 'owner') throw new AuthorisationError('Only the platform owner can delete a company');
  const company = await findAccessibleCompany(actor, id, { id: true, name: true, slug: true, status: true });
  if (company.status !== 'suspended') throw new ConflictError('Suspend the company before deleting it');

  const { memberIds, reportCount } = await purgeCompany(id);
  await recordPlatformAudit(actor.id, {
    action: 'platform.company.delete',
    entityType: 'organization',
    entityId: id,
    metadata: { name: company.name, slug: company.slug, deletedUsers: memberIds.length, deletedReports: reportCount },
    ip,
    userAgent,
  });
}

// --- Entering a company ---

/**
 * The caller becomes a hidden admin member of the company and every session of theirs points at it; one company
 * at a time, so any other support membership goes. Suspended companies can be entered.
 */
export async function enterCompany(actor, id) {
  const company = await findAccessibleCompany(actor, id, { id: true, name: true });
  // Switching companies leaves the previous one, so its stranded drafts go the same way as on exit.
  const { discardSupportDrafts } = await import('./reportService.js');
  await discardSupportDrafts(actor.id);
  await prisma.$transaction(async (tx) => {
    await tx.member.deleteMany({ where: { userId: actor.id, isSupport: true } });
    await tx.member.create({
      data: { id: generateId(), organizationId: id, userId: actor.id, role: 'admin', status: 'active', isSupport: true, createdAt: new Date() },
    });
    await tx.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: id } });
  });
  return { organizationId: company.id, name: company.name };
}

/** Also called on sign-out. */
export async function exitCompany(userId) {
  const { discardSupportDrafts } = await import('./reportService.js');
  await discardSupportDrafts(userId);
  await prisma.$transaction([
    prisma.member.deleteMany({ where: { userId, isSupport: true } }),
    prisma.session.updateMany({ where: { userId }, data: { activeOrganizationId: null } }),
  ]);
}

// --- Platform admins (owner only) ---

// The owner, the caller and removed admins are never targets.
async function findManageableAdmin(actor, userId) {
  if (userId === actor.id) throw new NotFoundError('Platform admin not found');
  const admin = await prisma.user.findFirst({
    where: { id: userId, platformRole: 'admin', platformStatus: { not: 'removed' } },
    select: { id: true, name: true, email: true, platformStatus: true },
  });
  if (!admin) throw new NotFoundError('Platform admin not found');
  return admin;
}

export async function listPlatformAdmins({ q, offset = 0, limit = 20 }) {
  const conditions = [{ platformRole: { not: null } }, { platformStatus: { not: 'removed' } }];
  if (q) conditions.push({ OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] });
  const where = { AND: conditions };

  const [admins, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        platformRole: true,
        platformStatus: true,
        createdAt: true,
        _count: { select: { companyAssignments: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { items: admins.map(({ _count, ...admin }) => ({ ...admin, companyCount: _count.companyAssignments })), total };
}

export async function invitePlatformAdmin(actor, { name, email: rawEmail }, { ip, userAgent } = {}) {
  const email = rawEmail.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new ConflictError('An account with that email already exists');

  const admin = await prisma.user.create({
    data: { id: generateId(), email, name: name.trim(), emailVerified: true, platformRole: 'admin', platformStatus: 'active' },
    select: { id: true },
  });

  // Imported here: auth.js imports this module. The reset flow creates the credential account on first use, and
  // auth.js's sendResetPassword sends the onboarding email while the admin has no login yet.
  const { auth } = await import('../auth.js');
  // setup=1 makes the frontend word the reset form as first-time setup.
  await auth.api.requestPasswordReset({ body: { email, redirectTo: `${process.env.FRONTEND_URL}/?setup=1` } });

  await recordPlatformAudit(actor.id, {
    action: 'platform.admin.invite',
    entityType: 'user',
    entityId: admin.id,
    metadata: { name: name.trim(), email },
    ip,
    userAgent,
  });
}

const ADMIN_STATUS_ACTIONS = { active: 'platform.admin.activate', suspended: 'platform.admin.suspend', removed: 'platform.admin.remove' };

/** suspended | active | removed. Anything but active signs them out and ends their session inside a company. */
export async function setPlatformAdminStatus(actor, userId, status, { ip, userAgent } = {}) {
  const admin = await findManageableAdmin(actor, userId);
  if (admin.platformStatus === status) throw new ConflictError(`Admin is already ${status}`);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { platformStatus: status } });
    if (status === 'active') return;
    await tx.session.deleteMany({ where: { userId } });
    await tx.member.deleteMany({ where: { userId, isSupport: true } });
    if (status === 'removed') await tx.platformAdminCompany.deleteMany({ where: { userId } });
  });

  await recordPlatformAudit(actor.id, {
    action: ADMIN_STATUS_ACTIONS[status],
    entityType: 'user',
    entityId: userId,
    metadata: { name: admin.name, email: admin.email },
    ip,
    userAgent,
  });
}

export async function getAdminCompanies(actor, userId) {
  await findManageableAdmin(actor, userId);
  const assignments = await prisma.platformAdminCompany.findMany({ where: { userId }, select: { organizationId: true } });
  return { organizationIds: assignments.map((a) => a.organizationId) };
}

export async function setAdminCompanies(actor, userId, organizationIds, { ip, userAgent } = {}) {
  const admin = await findManageableAdmin(actor, userId);
  const ids = [...new Set(organizationIds)];
  const found = await prisma.organization.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new ValidationError('One or more companies do not exist');

  await prisma.$transaction(async (tx) => {
    await tx.platformAdminCompany.deleteMany({ where: { userId } });
    await tx.platformAdminCompany.createMany({ data: ids.map((organizationId) => ({ userId, organizationId, assignedBy: actor.id })) });
    // Losing a company ends their session inside it.
    await tx.member.deleteMany({ where: { userId, isSupport: true, organizationId: { notIn: ids } } });
    await tx.session.updateMany({
      where: { userId, activeOrganizationId: { notIn: ids } },
      data: { activeOrganizationId: null },
    });
  });

  await recordPlatformAudit(actor.id, {
    action: 'platform.admin.companies',
    entityType: 'user',
    entityId: userId,
    metadata: { name: admin.name, email: admin.email, organizationIds: ids },
    ip,
    userAgent,
  });
  return { organizationIds: ids };
}
