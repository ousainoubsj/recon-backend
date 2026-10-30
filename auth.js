import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, emailOTP } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { prisma } from './config/prisma.config.js';
import { ROLE_PERMISSIONS } from './services/permissions.js';
import { handleUserCreated, releaseEmptyPersonalOrganization, usableInvitationEmail } from './services/signupHookService.js';
import { repairActiveOrganization } from './services/sessionHookService.js';
import { auditOrgAction } from './services/orgAuditHookService.js';
import { logAuditSafely } from './services/auditLogService.js';
import { createNotification } from './services/notificationService.js';
import { sendOrgInvitationEmail, sendPasswordResetEmail, sendOtpEmail, sendPlatformAdminInviteEmail } from './services/emailService.js';
import { exitCompany, isAwaitingFirstPassword, signInBlockReason } from './services/platformService.js';

// Statement lists every resource:action our access-control roles can grant.
// Includes Better Auth's own org-management resources (organization, member,
// invitation) alongside our domain resources (report, file) so a single
// role definition can gate both.
const statement = {
  organization: ['read', 'update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  report: ['create', 'read', 'delete', 'export', 'email'],
  file: ['upload'],
  auditLog: ['read', 'readOwn'],
};
const ac = createAccessControl(statement);
const roles = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([name, perms]) => [name, ac.newRole(perms)]),
);

// Role changes and removals run through teamService so the change and its audit row share one
// transaction; Better Auth's own endpoints would bypass that.
// /organization/leave has no UI and would remove a membership with neither an audit row nor our locked
// last-admin check.
const OWNED_MEMBER_PATHS = new Set(['/organization/update-member-role', '/organization/remove-member', '/organization/leave']);
// Deleting goes through DELETE /api/settings/organization, which also removes member accounts, audit rows and files.
const OWNED_DELETE_PATH = '/organization/delete';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    // Blocks /sign-in/email until the user completes the OTP step below.
    // Social sign-in is unaffected: Google/Apple mark emailVerified from the
    // provider's own claim, not via this flag (see oauth2/link-account.mjs).
    requireEmailVerification: true,
    // A platform admin the owner just invited has no login yet: their first reset link is the onboarding email.
    sendResetPassword: async ({ user, url }) =>
      user.platformRole && (await isAwaitingFirstPassword(user.id))
        ? sendPlatformAdminInviteEmail(user, url)
        : sendPasswordResetEmail(user, url),
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    apple: {
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET,
    },
  },
  trustedOrigins: [process.env.FRONTEND_URL, process.env.BETTER_AUTH_URL],
  // Without this, an OAuth error that isn't caught by a call-site
  // errorCallbackURL falls back to {BETTER_AUTH_URL}/error, which redirects
  // to this backend's own root and 404s there instead of reaching the user.
  onAPIError: {
    errorURL: `${process.env.FRONTEND_URL}/`,
  },
  // Frontend (recon-cil.com) and backend (api.recon-cil.com) are different
  // hostnames in production, so a host-only session cookie set by the
  // backend is invisible to requests hitting the frontend's own server
  // (e.g. proxy.ts's optimistic session check) even though it's still sent
  // fine on direct API calls. Scoping it to the shared parent domain fixes
  // that. Unset in dev — localhost has no subdomain to share, and cookies
  // there are already visible across ports regardless.
  advanced: process.env.COOKIE_DOMAIN
    ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: process.env.COOKIE_DOMAIN,
        },
      }
    : undefined,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh if older than 1 day
    // Disabled (not just short-lived): see repairActiveOrganization in
    // sessionHookService.js — a cached cookie would keep serving a stale
    // activeOrganizationId snapshot from before that repair ran.
    cookieCache: { enabled: false },
  },
  // Platform operator fields (docs/SUPER_ADMIN_PLAN.md), exposed on the session user; never settable by clients.
  user: {
    additionalFields: {
      platformRole: { type: 'string', required: false, input: false },
      platformStatus: { type: 'string', required: false, input: false },
    },
  },
  // Role now lives per-organization on Member.role (see the organization
  // plugin below), not globally on User.
  databaseHooks: {
    session: {
      create: {
        // Suspended/removed platform admins and members of a suspended company get no new session.
        before: async (session) => {
          const reason = await signInBlockReason(session.userId);
          if (reason) throw new APIError('FORBIDDEN', { message: reason });
        },
      },
    },
    user: {
      create: {
        // A Google sign-up started from an invite link carries the invitation id through the OAuth state.
        // Signing up with a different Google account would create an unrelated account and org, so refuse
        // it; the callback redirects to the frontend with ?error=invitation_email_mismatch.
        before: async (user) => {
          const invitationId = (await getOAuthState().catch(() => null))?.invitationId;
          if (typeof invitationId !== 'string') return;
          const invitedEmail = await usableInvitationEmail(invitationId, { prisma });
          if (invitedEmail && invitedEmail.toLowerCase() !== user.email.toLowerCase()) {
            throw new APIError('FORBIDDEN', { message: 'invitation email mismatch' });
          }
        },
        after: (user) =>
          handleUserCreated(user, { prisma, createOrganization: auth.api.createOrganization }),
      },
    },
  },
  hooks: {
    // The org-creation call in handleUserCreated above isn't awaited by the
    // sign-up flow before it proceeds to create the session, so a user's
    // very first session can be created before their org exists — leaving
    // activeOrganizationId permanently null (see sessionHookService.js).
    // Repairing it here, on every request to an org endpoint, self-heals
    // regardless of that race.
    before: createAuthMiddleware(async (ctx) => {
      // A platform admin signing out leaves the company they were inside. Read now: after sign-out the session is gone.
      if (ctx.path === '/sign-out') {
        const session = await auth.api.getSession({ headers: ctx.headers }).catch(() => null);
        if (session?.user.platformRole) await exitCompany(session.user.id);
        return;
      }
      if (!ctx.path.startsWith('/organization')) return;
      if (OWNED_MEMBER_PATHS.has(ctx.path)) {
        throw new APIError('FORBIDDEN', { message: 'Membership changes go through /api/team/members' });
      }
      if (ctx.path === OWNED_DELETE_PATH) {
        throw new APIError('FORBIDDEN', { message: 'Delete the organization from Settings' });
      }
      const session = await auth.api.getSession({ headers: ctx.headers }).catch(() => null);
      await repairActiveOrganization(session?.session ?? null, { prisma });
    }),
    after: createAuthMiddleware((ctx) =>
      auditOrgAction(ctx, { getSession: auth.api.getSession, logAuditSafely, createNotification, prisma }),
    ),
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'admin',
      organizationLimit: 1, // each user belongs to exactly one organization
      sendInvitationEmail: sendOrgInvitationEmail,
      // isSupport marks a platform admin's hidden membership; exposed so useActiveMember can show the support banner.
      schema: {
        member: { additionalFields: { isSupport: { type: 'boolean', required: false, input: false, defaultValue: false } } },
      },
      organizationHooks: {
        // organizationLimit only limits creating orgs; without this an existing user could join a second
        // one, and getUserMembership would then pick either org at random. An empty auto-created org is given up.
        beforeAcceptInvitation: async ({ user, invitation }) => {
          if (!(await releaseEmptyPersonalOrganization(user, invitation, { prisma }))) {
            throw new APIError('FORBIDDEN', {
              message: 'This account already belongs to an organization. Ask the admin to invite a different email address.',
            });
          }
        },
      },
    }),
    emailOTP({
      // Redirects Better Auth's built-in "send verification on signup"
      // (triggered by requireEmailVerification above) to our OTP sender,
      // instead of the classic link-based verification email.
      overrideDefaultEmailVerification: true,
      // /email-otp/verify-email returns a session token on success — needed
      // since requireEmailVerification made sign-up skip auto-sign-in.
      autoSignInAfterVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => sendOtpEmail({ email, otp, type }),
    }),
  ],
});
