import { betterAuth } from "better-auth";
// better-auth 1.6 moved the adapter into its own package and only re-exports
// it from "better-auth/adapters/drizzle". npm hoists that package under
// better-auth's own node_modules, where this workspace cannot resolve it, so
// it is a direct dependency and imported from its own name.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { and, eq, gt } from "drizzle-orm";

import * as authSchema from "@/db/auth-schema";
import { unsafeDb } from "@/db";
import { invitation } from "@/db/auth-schema";

import { acceptInvitationFor } from "./access";
import { env } from "./env";
import { describeError, log } from "@/lib/log";

/**
 * Authentication for the healdesk console.
 *
 * Self-hosted deliberately: the auth tables live in the same BAA-covered
 * Postgres as everything else, so no auth vendor enters the PHI path and there
 * is no third BAA to negotiate. Every hosted alternative gates BAAs behind
 * unpublished enterprise pricing.
 *
 * This is `unsafeDb` on purpose — the identity plane has no clinic to scope by,
 * and Better Auth must read `user` and `session` before a tenant is even known.
 * It is the one legitimate caller besides migrations. See src/db/index.ts.
 *
 * ## Sign-up is closed
 *
 * A public registration form on a system holding patient records is a defect,
 * not a feature. Accounts exist only by invitation, enforced in a database hook
 * so it cannot be bypassed by hitting the endpoint directly.
 */

export const auth = betterAuth({
  secret: env.betterAuthSecret(),
  baseURL: env.betterAuthUrl(),

  database: drizzleAdapter(unsafeDb, {
    provider: "pg",
    schema: authSchema,
  }),

  emailAndPassword: {
    enabled: true,
    /**
     * FALSE, and that is not a relaxation.
     *
     * Better Auth's email verification blocks sign-in until the address is
     * confirmed. With no `sendVerificationEmail` configured it blocked EVERY
     * sign-in, permanently — the account was created, the password was set, and
     * the user was then told their email was unverified with no way to verify it.
     *
     * More importantly it was redundant here. Accounts cannot be created except
     * by following an invitation link sent to a specific address, and the create
     * hook below refuses any sign-up without a matching pending invitation. So
     * receiving that link already proves control of the address — which is the
     * only thing verification establishes. Requiring a second proof of the same
     * fact bought nothing and broke the product.
     *
     * If open sign-up is ever enabled, this must go back to true AND a verifier
     * must be configured in the same change.
     */
    requireEmailVerification: false,
    minPasswordLength: 12,
  },

  session: {
    expiresIn: 60 * 60 * 8, // 8 hours — a console holding PHI, not a consumer app
    updateAge: 60 * 60, // refresh at most hourly
  },

  advanced: {
    cookiePrefix: "hd",
    useSecureCookies: env.isProduction(),
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },

  rateLimit: {
    enabled: true,
    /**
     * In-process memory, not "database" (design D5, 5 October 2026).
     *
     * "database" needs a `rateLimit` model that auth-schema.ts never had and
     * no migration ever created, so EVERY request to /api/auth/* threw before
     * it reached its handler — invisible only because nothing clinic-facing
     * used the HTTP endpoints yet. Memory keeps the "no Redis, plain
     * container" property the database choice was made for. Its limit is that
     * counters are per process and reset on deploy, which is acceptable for
     * Better Auth's own throttle: the clinic sign-in form applies its own rate
     * limit before it issues a link, and sign-in is by single-use link only.
     * tests/auth-handler.test.ts drives the real handler so this cannot
     * silently regress.
     */
    storage: "memory",
  },

  databaseHooks: {
    user: {
      create: {
        async before(user) {
          const email = user.email?.toLowerCase();
          if (!email) throw new Error("Email is required.");

          const [pending] = await unsafeDb
            .select({ id: invitation.id })
            .from(invitation)
            .where(
              and(
                eq(invitation.email, email),
                eq(invitation.status, "pending"),
                gt(invitation.expiresAt, new Date()),
              ),
            )
            .limit(1);

          if (!pending) {
            // Deliberately vague to the caller — do not confirm whether an
            // invitation exists for an address.
            throw new Error("Registration is by invitation only.");
          }

          return { data: user };
        },

        /**
         * Turn the accepted invitation into actual access.
         *
         * Without this the account existed and could sign in, and then had
         * membership of nothing — `resolveTenantContext` joins through
         * `clinic_memberships`, so every clinic page returned "no access" and
         * the console was empty. The user had completed signup successfully and
         * arrived at a product that behaved as though they had not.
         *
         * Runs after the user row exists, because the membership references it.
         * Failures here are logged rather than thrown: the account is already
         * created by this point, and throwing would leave a signed-up user with
         * no account and no way to retry the invitation, which is worse than a
         * missing membership an operator can re-grant.
         */
        async after(user) {
          const email = user.email?.toLowerCase();
          if (!email) return;

          try {
            await acceptInvitationFor(email, user.id);
          } catch (error) {
            log.error("failed to grant access after signup", {
              error: describeError(error),
            });
          }
        },
      },
    },
  },

  plugins: [
    organization({
      // Organizations are created during the purchase flow, not by users
      // signing themselves up into arbitrary tenants.
      allowUserToCreateOrganization: false,
      // Deleting an org must never become a path to deleting PHI. The FK from
      // clinics is ON DELETE RESTRICT; this removes the route entirely.
      disableOrganizationDeletion: true,
      creatorRole: "owner",
    }),
    // Must be last: it wraps the handler to set cookies in Next server actions.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
