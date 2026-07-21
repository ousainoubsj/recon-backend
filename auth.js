import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, emailOTP } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { prisma } from './db/index.js';
import { ROLE_PERMISSIONS } from './services/permissions.js';
import { handleUserCreated } from './services/signupHookService.js';
import { repairActiveOrganization } from './services/sessionHookService.js';
import { auditOrgAction } from './services/orgAuditHookService.js';
import { logAuditSafely } from './services/auditLogService.js';
import { sendOrgInvitationEmail, sendPasswordResetEmail, sendOtpEmail } from './services/emailService.js';

// Statement lists every resource:action our access-control roles can grant.
// Includes Better Auth's own org-management resources (organization, member,
// invitation) alongside our domain resources (report, file) so a single
// role definition can gate both.
const statement = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  report: ['create', 'read', 'delete', 'export', 'email'],
  file: ['upload'],
  auditLog: ['create', 'read'],
};
const ac = createAccessControl(statement);
const roles = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([name, perms]) => [name, ac.newRole(perms)]),
);

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    // Blocks /sign-in/email until the user completes the OTP step below.
    // Social sign-in is unaffected: Google/Apple mark emailVerified from the
    // provider's own claim, not via this flag (see oauth2/link-account.mjs).
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => sendPasswordResetEmail(user, url),
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
  trustedOrigins: [process.env.FRONTEND_URL],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh if older than 1 day
    // Disabled (not just short-lived): see repairActiveOrganization in
    // sessionHookService.js — a cached cookie would keep serving a stale
    // activeOrganizationId snapshot from before that repair ran.
    cookieCache: { enabled: false },
  },
  // Role now lives per-organization on Member.role (see the organization
  // plugin below), not globally on User.
  databaseHooks: {
    user: {
      create: {
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
      if (!ctx.path.startsWith('/organization')) return;
      const session = await auth.api.getSession({ headers: ctx.headers }).catch(() => null);
      await repairActiveOrganization(session?.session ?? null, { prisma });
    }),
    after: createAuthMiddleware((ctx) =>
      auditOrgAction(ctx, { getSession: auth.api.getSession, logAuditSafely }),
    ),
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'admin',
      organizationLimit: 1, // each user belongs to exactly one organization
      sendInvitationEmail: sendOrgInvitationEmail,
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
