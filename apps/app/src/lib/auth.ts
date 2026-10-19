import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
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
import { endStepUps, hashSessionToken } from "./factors/step-ups";
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

/**
 * The one way a clinic session starts: a sign-in link, consumed by a server
 * action (lib/sign-in/links.ts, design D4).
 *
 * Server-only, so it has no HTTP route at all: nothing on the internet can ask
 * for a session for a user id. The only caller is our own server action,
 * after it has spent a single-use link in the same request. It creates the
 * session and sets the cookie the way Better Auth's own sign-in endpoints do;
 * `nextCookies()` below carries the cookie onto the action's response.
 */
/**
 * `{ userId }` as a Standard Schema, the interface Better Auth's endpoints
 * validate bodies with, written out so the body is typed and checked without
 * adding a validation library for one field.
 */
type LinkSessionBody = { userId: string };
const linkSessionBody: {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { value: LinkSessionBody; issues?: undefined } | { issues: readonly { message: string }[] };
    readonly types?: { readonly input: LinkSessionBody; readonly output: LinkSessionBody };
  };
} = {
  "~standard": {
    version: 1,
    vendor: "healdesk",
    validate(value) {
      const userId = (value as { userId?: unknown } | null)?.userId;
      return typeof userId === "string" && userId.length > 0
        ? { value: { userId } }
        : { issues: [{ message: "A user id is required." }] };
    },
  },
};

const linkSession = {
  id: "healdesk-link-session",
  endpoints: {
    startLinkSession: createAuthEndpoint.serverOnly(
      { method: "POST", requireHeaders: true, body: linkSessionBody },
      async (ctx) => {
        const found = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!found) throw new APIError("NOT_FOUND", { message: "No such user." });
        const session = await ctx.context.internalAdapter.createSession(found.id);
        await setSessionCookie(ctx, { session, user: found });
        // The session's row id, never its token: the human route's link
        // binds itself to the session it started (lib/factors/recovery.ts),
        // reading the token's digest from the row.
        return ctx.json({ ok: true, sessionId: session.id });
      },
    ),
  },
} satisfies BetterAuthPlugin;

export const auth = betterAuth({
  secret: env.betterAuthSecret(),
  baseURL: env.betterAuthUrl(),

  database: drizzleAdapter(unsafeDb, {
    provider: "pg",
    schema: authSchema,
  }),

  emailAndPassword: {
    /**
     * Off: there is no password anywhere (plan Part D1). The clinic portal is
     * entered by single-use link only, through `startLinkSession` above, and
     * the console these settings were written for was deleted on 12 September.
     * The notes below stay because they say what must be true if passwords
     * ever come back.
     */
    enabled: false,
    /**
     * FALSE, and that is not a relaxation.
     *
     * Better Auth's email verification blocks sign-in until the address is
     * confirmed. With no `sendVerificationEmail` configured it blocked EVERY
     * sign-in, permanently — the account was created, the password was set, and
     * the user was then told their email was unverified with no way to verify it.
     *
     * More importantly it is redundant here. Better Auth creates no account:
     * provisioning writes the clinic's one user itself (`ensureOwner` in
     * lib/provisioning.ts), and the create hook below refuses any user Better
     * Auth would make without a pending invitation, of which none is written.
     * Every sign-in is a single-use link, mailed to the address or handed to
     * the browser that paid at /welcome, so using one already proves control
     * of the address or of the purchase, which is what verification would
     * establish. A second proof of the same fact buys nothing.
     *
     * If open sign-up is ever enabled, this must go back to true AND a verifier
     * must be configured in the same change.
     */
    requireEmailVerification: false,
    minPasswordLength: 12,
  },

  session: {
    /**
     * Fourteen days, absolute (plan Part D1). A session is never extended by
     * use, so a sign-in link's reach ends on a fixed day whatever happens in
     * between. Patient pages ask for the device's passkey on top, and that
     * step-up lapses after 15 minutes idle (lib/portal/step-up.ts), so the
     * long session guards settings and billing, never transcripts.
     */
    expiresIn: 60 * 60 * 24 * 14,
    disableSessionRefresh: true,
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
    session: {
      delete: {
        /**
         * A session's passkey step-ups end with it (plan Part D2: "cleared on
         * sign-out"). Every way Better Auth deletes a session runs this: sign
         * out, revoking sessions, and the clean-up of an expired one.
         *
         * After the delete, never before, and it never throws: once the row
         * is gone no request can present the token again, so a step-up left
         * behind by a failure here is already dead, while a throw before the
         * delete would leave someone unable to sign out.
         */
        async after(session) {
          try {
            await endStepUps({ sessionTokenHash: hashSessionToken(session.token) });
          } catch (error) {
            // The name only: a Drizzle error's message carries its parameters.
            log.error("could not end a deleted session's step-ups", {
              error: error instanceof Error ? error.name : "unknown error",
            });
          }
        },
      },
    },
    user: {
      /**
       * The gate on any user Better Auth itself would create: by invitation
       * only. No invitation is written in v1 (one shared sign-in per clinic),
       * so it refuses every one. The clinic's user is made by provisioning,
       * which writes it directly (`ensureOwner` in lib/provisioning.ts) and
       * never passes through these hooks.
       */
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
         * Turn an accepted invitation into actual access, should invitations
         * come back with the spec's deferred roles.
         *
         * Without this the account would exist and could sign in, with
         * membership of nothing — `resolveTenantContext` joins through
         * `clinic_memberships`, so every clinic page would say "no access".
         * Provisioning writes the owner's membership itself, beside its user.
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
    linkSession,
    // Must be last: it wraps the handler to set cookies in Next server actions.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
