import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { and, eq, gt } from "drizzle-orm";

import * as authSchema from "@/db/auth-schema";
import { unsafeDb } from "@/db";
import { invitation } from "@/db/auth-schema";

import { env } from "./env";

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
    requireEmailVerification: true,
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
    // Database-backed rather than Redis: one less vendor, and it keeps
    // apps/app runnable in a plain container.
    storage: "database",
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
