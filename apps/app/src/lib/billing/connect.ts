import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import Stripe from "stripe";

import { unsafeDb } from "@/db";
import {
  appointments,
  clinics,
  depositPayments,
  stripeConnectStates,
  type StripeConnectReturnTo,
} from "@/db/schema";
import { recordSecurityEvent, type ActorContext } from "@/lib/audit";
import {
  flagForFrontDesk,
  recordDepositLapsed,
  recordDepositPaid,
  switchDepositsOff,
} from "@/lib/billing/deposits";
import { enqueueNotice, type ConnectSource } from "@/lib/billing/notices";
import { getStripe } from "@/lib/billing/stripe-client";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { applySwitchResets, emailResets } from "@/lib/portal/switch-resets";
import type { SwitchReset } from "@/lib/portal/switch-rules";
import { PublicUrlError, publicOriginProblem, publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * Stripe Connect, Standard accounts (build decision BD28, R23): how a
 * clinic's own Stripe account is attached, so a deposit link is a direct
 * charge on that account and the money never passes through us.
 *
 * Standard is the lowest-liability shape: the clinic keeps its own Stripe
 * login and its own funds, and the platform holds an account id it can act
 * on with its own secret key. Nothing here stores a token.
 *
 * ## The OAuth state is a single-use row
 *
 * A link is minted as 32 random bytes; only their SHA-256 is stored, in
 * `stripe_connect_states`, with a 15-minute life, where it was started from
 * (the portal's Settings, the setup wizard, or an operator's link) and, for
 * the portal, the user who started it. The callback consumes the row with a
 * conditional UPDATE before it does anything else, the code exchange
 * included, so a state works once: a replayed or leaked link finds nothing.
 * The old stateless HMAC state (reusable for an hour, keyed with the
 * provisioning secret apps/web shares) is gone, and nothing else is accepted.
 *
 * A portal state is bound: the callback refuses it unless the browser that
 * comes back is signed in as the same user, still holds a grant on the clinic
 * and still has a live passkey step-up. An operator's link is a bearer link
 * by nature (it is sent to the clinic), so it is held to one live link per
 * clinic and refused once the clinic is connected.
 *
 * ## Never someone else's account
 *
 * The callback never overwrites a different stored account: it refuses with
 * `already_connected` and revokes the stray connection, but only when no
 * other clinic uses that account, because revoking is account-wide and a
 * group's locations may share one. Connecting the same account again is a
 * no-op success. The token's `livemode` must match our key's.
 *
 * Redirects go to the portal (`/c/<slug>/settings` or `/setup`) or to a
 * neutral page for operator links, built with publicUrl() from the clinic's
 * own slug. Never `/admin`: that is our console, and a clinic must never be
 * sent there.
 */

/** How long a minted link is good for (BD28). */
export const CONNECT_STATE_TTL_MS = 15 * 60 * 1000;

const AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/** Stripe's OAuth token endpoint; called with one plain POST (see exchangeCode). */
export const OAUTH_TOKEN_URL = "https://connect.stripe.com/oauth/token";
const EXCHANGE_TIMEOUT_MS = 20_000;

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,255}$/;
/** 32 random bytes in base64url are 43 characters; anything far off that is not ours. */
const STATE_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const CONNECT_ACTOR: ActorContext = { type: "service", serviceName: "stripe-connect" };
/** Who finished an operator's link: the clinic, unauthenticated by design. */
const OPS_LINK_ACTOR: ActorContext = { type: "service", serviceName: "stripe-connect (ops link)" };
const WEBHOOK_ACTOR: ActorContext = { type: "service", serviceName: "stripe-connect-webhook" };

/** Both halves of the platform's Connect configuration are present. */
export function connectConfigured(): boolean {
  return Boolean(env.stripeConnectClientId() && env.stripeSecretKey());
}

/** The callback URL Stripe sends the browser back to; registered on the platform. */
export function connectRedirectUri(): string {
  return publicUrl("/api/connect/stripe");
}

/**
 * The mode of the platform key: live or test, or null when there is no key
 * or it is not a secret or restricted key. Events and tokens whose
 * `livemode` disagrees are not ours to act on: a production Connect endpoint
 * also receives test-mode events, and a Standard account has the same
 * `acct_` id in both modes.
 */
export function stripeKeyMode(): "live" | "test" | null {
  const key = env.stripeSecretKey();
  if (!key) return null;
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return null;
}

/** SHA-256 of a Stripe account id, hex: what audit rows and dedupe keys carry instead of the id. */
export function accountRef(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function stateHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// -----------------------------------------------------------------------------
// Minting a link
// -----------------------------------------------------------------------------

export type ConnectRefusal =
  "not_configured" | "no_public_origin" | "already_connected" | "unknown_clinic";

/** A link that cannot be minted, with a closed code for the caller and words for an operator. */
export class ConnectError extends Error {
  constructor(
    readonly code: ConnectRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Mint a single-use Connect link for a clinic: `{ url, expiresAt }`, the URL
 * on Stripe's authorize page with the state in it. The state itself is never
 * stored, logged or returned on its own.
 *
 * - `settings` and `setup` are the portal's, and must name the signed-in user
 *   the callback will hold them to; `ops` is an operator's (E's
 *   `issueStripeConnectLink`) and names nobody.
 * - Refused while the clinic is connected: disconnect first. That also caps
 *   what a captured or replayed ops request can do.
 * - An operator's new link expires the clinic's earlier unused one, so at
 *   most one ops link per clinic is live, under an advisory lock so two
 *   concurrent mints cannot both survive.
 * - The public origin is checked before the row is written (lib/public-url.ts):
 *   a link nobody can be sent back from is not minted.
 *
 * One tenant transaction: the clinic read, the state row and the audit row
 * commit together.
 */
export async function mintConnectState(input: {
  clinicId: string;
  returnTo: StripeConnectReturnTo;
  userId?: string | null;
  actor?: ActorContext;
  now?: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const isPortal = input.returnTo !== "ops";
  const userId = input.userId ?? null;
  if (isPortal && !userId) {
    throw new Error("A portal Connect link must be bound to the signed-in user.");
  }
  if (!isPortal && userId) {
    throw new Error("An operator's Connect link is not bound to a portal user.");
  }
  const clientId = env.stripeConnectClientId();
  if (!clientId || !env.stripeSecretKey()) {
    throw new ConnectError(
      "not_configured",
      "Stripe Connect is not configured on this deployment.",
    );
  }
  const originProblem = publicOriginProblem();
  if (originProblem) throw new ConnectError("no_public_origin", originProblem);
  const redirectUri = connectRedirectUri();

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + CONNECT_STATE_TTL_MS);
  await withTenant(
    { clinicId: input.clinicId, actor: input.actor ?? CONNECT_ACTOR },
    async (tx) => {
      const [clinic] = await tx.db
        .select({ accountId: clinics.stripeConnectAccountId })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) throw new ConnectError("unknown_clinic", "No such clinic.");
      if (clinic.accountId) {
        throw new ConnectError(
          "already_connected",
          "This clinic already has a Stripe account connected. Disconnect it before connecting another.",
        );
      }
      if (!isPortal) {
        await tx.db.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-connect-ops:${tx.clinicId}`}, 0))`,
        );
        await tx.db
          .update(stripeConnectStates)
          .set({ expiresAt: now })
          .where(
            and(
              eq(stripeConnectStates.clinicId, tx.clinicId),
              eq(stripeConnectStates.returnTo, "ops"),
              isNull(stripeConnectStates.usedAt),
              gt(stripeConnectStates.expiresAt, now),
            ),
          );
      }
      await tx.db.insert(stripeConnectStates).values({
        stateHash: stateHash(token),
        clinicId: tx.clinicId,
        userId,
        returnTo: input.returnTo,
        createdAt: now,
        expiresAt,
      });
      tx.audit.record({
        action: "create",
        resourceType: "stripe_connect_state",
        resourceId: tx.clinicId,
        metadata: { returnTo: input.returnTo, expiresInMinutes: CONNECT_STATE_TTL_MS / 60_000 },
      });
    },
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: redirectUri,
    state: token,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, expiresAt };
}

// -----------------------------------------------------------------------------
// The callback
// -----------------------------------------------------------------------------

/** Where a consumed state sends the browser, and which clinic it is for. */
export type ConnectTarget = { clinicId: string; slug: string; returnTo: StripeConnectReturnTo };

/** Closed codes for a failed callback. Never Stripe's own error text. */
export type ConnectFailure =
  | "no_code"
  | "not_configured"
  | "code_rejected"
  | "exchange_failed"
  | "not_an_account"
  | "mode_mismatch";

export type ConnectCallbackResult =
  /** No live state: unknown, expired, already used, or its clinic is gone. */
  | { status: "invalid_state" }
  /** A portal state opened by a browser that is not its user's (burned all the same). */
  | { status: "unbound" }
  | { status: "connected"; target: ConnectTarget; accountLabel: string | null }
  | { status: "declined"; target: ConnectTarget }
  | { status: "already_connected"; target: ConnectTarget }
  | { status: "failed"; target: ConnectTarget; reason: ConnectFailure };

/** The browser that came back, for a portal state: its user and its live step-up's device. */
export type PortalBinding = { userId: string; deviceLabel: string };

export type ConnectCallbackDeps = {
  now?: Date;
  /**
   * Who the browser is, for a state bound to a portal user: the same user,
   * a grant on the clinic and a live step-up, or null. Defaults to the
   * portal's own session (lib/portal/access.ts, lib/portal/step-up.ts).
   */
  portalBinding?: (bound: {
    userId: string;
    clinicId: string;
    slug: string;
  }) => Promise<PortalBinding | null>;
};

/**
 * The callback's work, in an order chosen so nothing is spent before it is
 * checked:
 *
 *   1. consume the state (a conditional UPDATE: unused and unexpired), so a
 *      declined flow, a failed exchange and a refused browser all burn it;
 *   2. read the clinic's own slug, which is the only place it comes from;
 *   3. for a portal state, check the browser: same user, a live grant, a live
 *      step-up; anything else is `unbound`;
 *   4. a decline (`error=access_denied`) stops here, with nothing exchanged;
 *   5. exchange the code, once (exchangeCode);
 *   6. check the mode, then attach the account unless a different one is
 *      already attached;
 *   7. read the account's display name, for a caller on the server: it never
 *      goes into the redirect, whose page is public (connectReturnPath).
 */
export async function completeConnect(
  input: { state: string | null; code: string | null; error: string | null },
  deps: ConnectCallbackDeps = {},
): Promise<ConnectCallbackResult> {
  const now = deps.now ?? new Date();
  if (!input.state || !STATE_SHAPE.test(input.state)) return { status: "invalid_state" };

  const [consumed] = await unsafeDb
    .update(stripeConnectStates)
    .set({ usedAt: now })
    .where(
      and(
        eq(stripeConnectStates.stateHash, stateHash(input.state)),
        isNull(stripeConnectStates.usedAt),
        gt(stripeConnectStates.expiresAt, now),
      ),
    )
    .returning({
      clinicId: stripeConnectStates.clinicId,
      userId: stripeConnectStates.userId,
      returnTo: stripeConnectStates.returnTo,
    });
  if (!consumed) return { status: "invalid_state" };

  const clinic = await withTenant(
    { clinicId: consumed.clinicId, actor: CONNECT_ACTOR },
    async (tx) => {
      const [row] = await tx.db
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      return row ?? null;
    },
  );
  if (!clinic) return { status: "invalid_state" };
  const target: ConnectTarget = {
    clinicId: consumed.clinicId,
    slug: clinic.slug,
    returnTo: consumed.returnTo,
  };

  let binding: PortalBinding | null = null;
  if (consumed.userId) {
    binding = await (deps.portalBinding ?? currentPortalBinding)({
      userId: consumed.userId,
      clinicId: target.clinicId,
      slug: target.slug,
    });
    if (!binding) {
      log.warn("stripe connect state refused: not its user's browser", {
        clinicId: target.clinicId,
        outcome: "unbound",
      });
      return { status: "unbound" };
    }
  }

  if (input.error) return { status: "declined", target };
  if (!input.code) return { status: "failed", target, reason: "no_code" };

  const mode = stripeKeyMode();
  if (!mode || !env.stripeConnectClientId()) {
    return { status: "failed", target, reason: "not_configured" };
  }
  let token: { accountId: string; livemode: boolean | null };
  try {
    token = await exchangeCode(input.code);
  } catch (error) {
    if (error instanceof ConnectExchangeError) {
      log.error("stripe connect code exchange failed", {
        clinicId: target.clinicId,
        code: error.code,
      });
      return { status: "failed", target, reason: error.code };
    }
    throw error;
  }
  if (token.livemode !== (mode === "live")) {
    log.error("stripe connect refused: token mode differs from the key's", {
      clinicId: target.clinicId,
      code: "mode_mismatch",
    });
    return { status: "failed", target, reason: "mode_mismatch" };
  }

  const source: ConnectSource = target.returnTo === "ops" ? "ops" : "portal";
  const actor: ActorContext = binding
    ? { type: "user", userId: binding.userId, label: binding.deviceLabel }
    : OPS_LINK_ACTOR;
  const actorLabel = binding ? binding.deviceLabel : "stripe-connect (ops link)";
  const linked = await withTenant({ clinicId: target.clinicId, actor }, (tx) =>
    linkAccount(tx, {
      accountId: token.accountId,
      now,
      source,
      actorLabel,
      userId: binding?.userId ?? null,
    }),
  );

  if (linked.kind === "different") {
    const deauthorized = await revokeIfUnshared(token.accountId, null);
    await withTenant({ clinicId: target.clinicId, actor }, async (tx) => {
      tx.audit.record({
        action: "update",
        resourceType: "clinic_stripe_connect",
        resourceId: tx.clinicId,
        metadata: { outcome: "already_connected", deauthorized, source },
      });
      await recordSecurityEvent(tx.db, {
        event: "stripe_connect_refused",
        actorLabel,
        userId: binding?.userId ?? null,
        metadata: {
          clinicId: tx.clinicId,
          accountRef: accountRef(token.accountId),
          reason: "already_connected",
          deauthorized,
        },
      });
    });
    return { status: "already_connected", target };
  }

  if (linked.kind === "linked" && linked.billingClinicId) {
    // A location: its notices belong to the clinic that pays for it, in that
    // clinic's tenant, which a second, sequential transaction opens. Never a
    // nested one: the pool deadlocks.
    const billingClinicId = linked.billingClinicId;
    await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
      enqueueConnected(tx, token.accountId, now, source),
    );
  }

  return {
    status: "connected",
    target,
    accountLabel: await connectAccountLabel(token.accountId),
  };
}

type Linked =
  { kind: "linked"; billingClinicId: string | null } | { kind: "same" } | { kind: "different" };

/**
 * Attach the account to the tenant clinic, only while it holds none: one
 * conditional UPDATE, so two callbacks racing for the same clinic cannot both
 * write. When a row already holds an account, the same one is a no-op and a
 * different one is refused.
 */
async function linkAccount(
  tx: TenantTx,
  input: {
    accountId: string;
    now: Date;
    source: ConnectSource;
    actorLabel: string;
    userId: string | null;
  },
): Promise<Linked> {
  const [updated] = await tx.db
    .update(clinics)
    .set({
      stripeConnectAccountId: input.accountId,
      stripeConnectConnectedAt: input.now,
      stripeConnectDisconnectedAt: null,
      updatedAt: input.now,
    })
    .where(and(eq(clinics.id, tx.clinicId), isNull(clinics.stripeConnectAccountId)))
    .returning({ billingClinicId: clinics.billingClinicId });
  if (!updated) {
    const [row] = await tx.db
      .select({ accountId: clinics.stripeConnectAccountId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (row?.accountId === input.accountId) {
      tx.audit.record({
        action: "update",
        resourceType: "clinic_stripe_connect",
        resourceId: tx.clinicId,
        metadata: { connected: true, outcome: "unchanged", source: input.source },
      });
      return { kind: "same" };
    }
    return { kind: "different" };
  }

  tx.audit.record({
    action: "update",
    resourceType: "clinic_stripe_connect",
    resourceId: tx.clinicId,
    metadata: { connected: true, source: input.source },
  });
  await recordSecurityEvent(tx.db, {
    event: "stripe_connect_linked",
    actorLabel: input.actorLabel,
    userId: input.userId,
    metadata: {
      clinicId: tx.clinicId,
      accountRef: accountRef(input.accountId),
      source: input.source,
    },
  });
  if (updated.billingClinicId === null) {
    await enqueueConnected(tx, input.accountId, input.now, input.source);
  }
  return { kind: "linked", billingClinicId: updated.billingClinicId };
}

/** `connect_connected` (O14) on the billing clinic's tenant, deduped per connection (R22). */
async function enqueueConnected(
  tx: TenantTx,
  accountId: string,
  connectedAt: Date,
  source: ConnectSource,
): Promise<void> {
  const at = connectedAt.toISOString();
  await enqueueNotice(tx, "connect_connected", `connected:${accountRef(accountId)}:${at}`, {
    connectedAt: at,
    source,
  });
}

/**
 * The default binding check: the portal session's user, its grant on the
 * clinic and its live step-up (which this also counts as activity). Imported
 * lazily so that a module importing this one (the ops API, the webhook) does
 * not load the auth stack it never uses.
 */
async function currentPortalBinding(bound: {
  userId: string;
  clinicId: string;
  slug: string;
}): Promise<PortalBinding | null> {
  const [{ currentUserId, portalGrants }, { touchStepUp }] = await Promise.all([
    import("@/lib/portal/access"),
    import("@/lib/portal/step-up"),
  ]);
  const userId = await currentUserId();
  if (!userId || userId !== bound.userId) return null;
  const grants = await portalGrants(userId);
  if (!grants.some((g) => g.clinicId === bound.clinicId)) return null;
  const live = await touchStepUp({ userId, clinicId: bound.clinicId, clinicSlug: bound.slug });
  return live ? { userId, deviceLabel: live.deviceLabel } : null;
}

class ConnectExchangeError extends Error {
  constructor(
    readonly code: Extract<
      ConnectFailure,
      "not_configured" | "code_rejected" | "exchange_failed" | "not_an_account"
    >,
  ) {
    super(`Stripe Connect code exchange failed: ${code}`);
    this.name = "ConnectExchangeError";
  }
}

/**
 * Exchange an authorization code for the account id: ONE plain POST to
 * Stripe's token endpoint, never retried.
 *
 * Stripe documents that consuming a code twice revokes the connection. The
 * SDK retries POSTs by default, and even at `maxNetworkRetries: 0` it retries
 * a connection that closed mid-request, which may be one Stripe had already
 * processed. A bare fetch makes exactly one attempt; a failure sends the
 * clinic back to start again with a fresh code.
 *
 * Only `stripe_user_id` and `livemode` are read. The deprecated access and
 * refresh tokens the response still carries are dropped here and never
 * stored, and Stripe's error text is reduced to a closed code: it can quote
 * the code.
 */
async function exchangeCode(
  code: string,
): Promise<{ accountId: string; livemode: boolean | null }> {
  const key = env.stripeSecretKey();
  if (!key) throw new ConnectExchangeError("not_configured");
  let response: Response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_secret: key,
      }).toString(),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectExchangeError("exchange_failed");
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ConnectExchangeError(
      body?.error === "invalid_grant" ? "code_rejected" : "exchange_failed",
    );
  }
  const accountId = body?.stripe_user_id;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
    throw new ConnectExchangeError("not_an_account");
  }
  return { accountId, livemode: typeof body?.livemode === "boolean" ? body.livemode : null };
}

/**
 * The connected account's display name, for the ops panel and the portal,
 * which read it on the server (never a URL, and never an email: a template
 * has no use for it). It is what makes a wrong account visible to whoever
 * connected it. Null when Stripe does not say or cannot be reached; never
 * throws.
 */
export async function connectAccountLabel(
  accountId: string,
  stripe?: Stripe,
): Promise<string | null> {
  try {
    const client = stripe ?? getStripe();
    const account = await client.accounts.retrieve(
      accountId,
      {},
      { timeout: 10_000, maxNetworkRetries: 1 },
    );
    return safeAccountLabel(
      account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null,
    );
  } catch (error) {
    log.warn("stripe connect account name unavailable", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

/**
 * An account's display name, made safe to show back: letters, digits, spaces
 * and plain punctuation only, at most 80 characters, and nothing shaped like
 * a phone number or an address. It is read from Stripe on the server, never
 * from a URL: a page that printed a name from its query would print whatever
 * a crafted link put there, and no filter that still passes a real business
 * name stops a plain sentence ("Payment failed. Pay at …"). That is why the
 * done page shows no name at all.
 */
export function safeAccountLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw
    .replace(/[^\p{L}\p{N} &'.,()-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact || compact.length > 80) return null;
  if (/\d[\d\s().-]{5,}\d/.test(compact)) return null;
  return compact;
}

// -----------------------------------------------------------------------------
// Where the callback sends the browser
// -----------------------------------------------------------------------------

/** The neutral page an operator's link and every unknown state land on. */
export const CONNECT_DONE_PATH = "/connect/stripe/done";

/**
 * The path for a callback result, relative to the public origin. The portal
 * hears `ok`, `declined` or `failed` (its contract); the neutral page is told
 * a little more, and never which clinic, nor the account's name: that page is
 * public and would print whatever a URL said (safeAccountLabel). Never
 * `/admin`.
 */
export function connectReturnPath(result: ConnectCallbackResult): string {
  if (result.status === "invalid_state") return `${CONNECT_DONE_PATH}?result=expired`;
  if (result.status === "unbound") return `${CONNECT_DONE_PATH}?result=failed`;
  const { target } = result;
  if (target.returnTo === "ops") {
    switch (result.status) {
      case "connected":
        return `${CONNECT_DONE_PATH}?result=ok`;
      case "declined":
        return `${CONNECT_DONE_PATH}?result=declined`;
      case "already_connected":
        return `${CONNECT_DONE_PATH}?result=already_connected`;
      case "failed":
        return `${CONNECT_DONE_PATH}?result=failed`;
    }
  }
  const outcome =
    result.status === "connected" ? "ok" : result.status === "declined" ? "declined" : "failed";
  return `/c/${encodeURIComponent(target.slug)}/${target.returnTo}?connect=${outcome}`;
}

/**
 * The absolute URL for a callback result, on the public origin. When the
 * origin is misconfigured the relative path is returned instead: the browser
 * is already on this app, and a redirect that resolves is better than none.
 */
export function connectReturnUrl(result: ConnectCallbackResult): string {
  const path = connectReturnPath(result);
  try {
    return publicUrl(path);
  } catch (error) {
    if (error instanceof PublicUrlError) return path;
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Disconnecting
// -----------------------------------------------------------------------------

/** The clinics that hold an account id, by the 0043 definer (ids only, across tenants). */
export async function clinicsForStripeAccount(accountId: string): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_for_stripe_account(${accountId}) as id`,
  );
  return result.rows.map((r) => r.id);
}

/**
 * Revoke our access to an account (`oauth.deauthorize`), but only when no
 * clinic other than `except` still uses it (R23): revocation is
 * account-wide, so revoking a location's account would cut off every sibling
 * sharing it, and Stripe's deauthorization event would then disconnect them
 * too. Returns whether access is now revoked. An account Stripe says is not
 * connected to us counts as revoked.
 */
async function revokeIfUnshared(accountId: string, except: string | null): Promise<boolean> {
  const holders = await clinicsForStripeAccount(accountId);
  if (holders.some((id) => id !== except)) return false;
  return deauthorize(accountId);
}

async function deauthorize(accountId: string): Promise<boolean> {
  const clientId = env.stripeConnectClientId();
  if (!clientId) return false;
  try {
    // client_id explicitly: the SDK would read it from setClientId, which the
    // shared client never calls.
    await getStripe().oauth.deauthorize(
      { client_id: clientId, stripe_user_id: accountId },
      { timeout: 20_000, maxNetworkRetries: 1 },
    );
    return true;
  } catch (error) {
    // Stripe answers invalid_client "not connected" for an account that has
    // already revoked us: the outcome we wanted. Any other refusal (a wrong
    // client id, the network) leaves access in place and is reported.
    if (
      error instanceof Stripe.errors.StripeInvalidClientError &&
      /not connected/i.test(error.message)
    ) {
      return true;
    }
    log.error("stripe connect deauthorization failed", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/** What happened to one open deposit link while disconnecting. */
type LinkOutcome = "cancelled" | "paid" | "expired" | "unchecked";

export type DisconnectResult =
  | {
      status: "disconnected";
      /** Our access to the account was revoked (false when another clinic still uses it). */
      deauthorized: boolean;
      /** Another clinic still uses the account, so only this clinic's link was removed. */
      shared: boolean;
      cancelledLinks: number;
      paidLinks: number;
      /** Open links that could not be checked: they may have been paid. */
      uncheckedLinks: number;
    }
  | { status: "not_connected" }
  /**
   * Stripe refused to revoke access. Deposits are off and every open link was
   * dealt with, but the account stays recorded, because we still hold access
   * to it; a retry finishes the job.
   */
  | { status: "deauthorize_failed" };

/**
 * Disconnect a clinic's Stripe account (BD28, in the order R23 sets):
 *
 *   1. switch deposits off locally first, so no new link is minted while the
 *      rest runs (an in-flight link creation sees it and cancels its own);
 *   2. expire this clinic's open deposit sessions on Stripe. One that will not
 *      expire is retrieved: paid is recorded as paid before anything moves to
 *      the front desk, and one that cannot be checked at all is left open and
 *      handed to staff as "may have been paid", so a patient is never asked
 *      to pay twice for want of a look;
 *   3. revoke our access, only when no other clinic uses the account;
 *   4. clear the account and stamp the disconnection, move `pending_link`
 *      appointments to `pending_front_desk` with the L10 alert, and enqueue
 *      `connect_disconnected` (only from the path that stamped it).
 *
 * Stripe is called with no transaction open. The portal calls this behind a
 * passkey step-up and passes its device label; an operator passes their own
 * label; billing-reconcile passes "offboarding" for a group cancelled more
 * than a day ago.
 */
export async function disconnectStripeConnect(input: {
  clinicId: string;
  actorLabel: string;
  source?: Exclude<ConnectSource, "stripe">;
  actor?: ActorContext;
  now?: Date;
}): Promise<DisconnectResult> {
  const now = input.now ?? new Date();
  const source = input.source ?? "ops";
  const actorLabel = input.actorLabel.slice(0, 200);
  const actor: ActorContext = input.actor ?? {
    type: "service",
    serviceName: actorLabel || "stripe-connect",
  };

  const prepared = await withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({ accountId: clinics.stripeConnectAccountId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic?.accountId) return null;
    // Everything that needs the account goes off first, in this transaction,
    // with history and audit (switch-resets.ts): deposits, full payment, the
    // payment-link text. The clinic hears of them in the disconnect email,
    // not a second one (enqueueDisconnected). switchDepositsOff then finds
    // deposits off, and still guards a clinic the rules did not reach.
    const resets = await applySwitchResets(tx, {
      cause: "stripe_disconnected",
      actorLabel,
      now,
      auditReason: "stripe_disconnect",
      email: false,
    });
    await switchDepositsOff(tx, now);
    // A link still being created has handed nobody a URL yet: cancelling the
    // row is enough, and createDepositLink expires the session it gets back.
    await tx.db
      .update(depositPayments)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(depositPayments.clinicId, tx.clinicId),
          eq(depositPayments.stripeAccountId, clinic.accountId),
          eq(depositPayments.status, "creating"),
        ),
      );
    const open = await tx.db
      .select({ id: depositPayments.id, sessionId: depositPayments.checkoutSessionId })
      .from(depositPayments)
      .where(
        and(
          eq(depositPayments.clinicId, tx.clinicId),
          eq(depositPayments.stripeAccountId, clinic.accountId),
          eq(depositPayments.status, "open"),
        ),
      );
    // The reset's audit row already says deposits went off, with this reason.
    if (!resets.some((r) => r.switch === "deposits")) {
      tx.audit.record({
        action: "update",
        resourceType: "clinic_settings",
        resourceId: tx.clinicId,
        metadata: {
          fields: ["depositsEnabled"],
          depositsEnabled: false,
          reason: "stripe_disconnect",
        },
      });
    }
    return { accountId: clinic.accountId, open, resets };
  });
  if (!prepared) return { status: "not_connected" };

  const outcomes = new Map<string, LinkOutcome>();
  for (const link of prepared.open) {
    outcomes.set(
      link.id,
      link.sessionId ? await closeSession(prepared.accountId, link.sessionId) : "unchecked",
    );
  }

  const holders = await clinicsForStripeAccount(prepared.accountId);
  const shared = holders.some((id) => id !== input.clinicId);
  const deauthorized = shared ? false : await deauthorize(prepared.accountId);

  const finished = await withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const counts = await settleLinks(tx, outcomes, now);
    if (!shared && !deauthorized) {
      tx.audit.record({
        action: "update",
        resourceType: "clinic_stripe_connect",
        resourceId: tx.clinicId,
        metadata: { connected: true, outcome: "deauthorize_failed", source },
      });
      // No disconnect email goes, so the resets get their own.
      await emailResets(tx, resetEmail(prepared.resets, now));
      return { kind: "kept" as const, counts };
    }
    const stamped = await clearAccount(tx, {
      accountId: prepared.accountId,
      at: now,
      source,
      wasByWebhook: false,
      actorLabel,
      deauthorized,
      hasUncheckedLinks: counts.unchecked > 0,
      resets: prepared.resets,
    });
    // Another path stamped the disconnection and sends its email.
    if (!stamped) await emailResets(tx, resetEmail(prepared.resets, now));
    return { kind: "cleared" as const, counts, stamped };
  });

  if (finished.kind === "kept") {
    log.error("stripe connect left attached: Stripe refused to revoke access", {
      clinicId: input.clinicId,
      outcome: "deauthorize_failed",
    });
    return { status: "deauthorize_failed" };
  }
  if (finished.stamped?.billingClinicId) {
    await withTenant({ clinicId: finished.stamped.billingClinicId, actor }, (tx) =>
      enqueueDisconnected(
        tx,
        prepared.accountId,
        now,
        false,
        source,
        finished.counts.unchecked > 0,
        prepared.resets,
      ),
    );
  }
  return {
    status: "disconnected",
    deauthorized,
    shared,
    cancelledLinks: finished.counts.cancelled,
    paidLinks: finished.counts.paid,
    uncheckedLinks: finished.counts.unchecked,
  };
}

/**
 * Close one open deposit session on the clinic's account before we lose
 * access to it. Expiring an open session is the normal case; Stripe refuses
 * to expire one that is no longer open, so a refusal is followed by a look.
 */
async function closeSession(accountId: string, sessionId: string): Promise<LinkOutcome> {
  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch {
    // No key, no look: the link is handed to the desk as possibly paid.
    return "unchecked";
  }
  const options = { stripeAccount: accountId, timeout: 20_000, maxNetworkRetries: 1 } as const;
  try {
    await stripe.checkout.sessions.expire(sessionId, {}, options);
    return "cancelled";
  } catch {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {}, options);
      if (session.status === "complete" && session.payment_status === "paid") return "paid";
      if (session.status === "expired") return "expired";
      return "unchecked";
    } catch {
      return "unchecked";
    }
  }
}

/** Write what closeSession found, then hand every remaining `pending_link` to the desk. */
async function settleLinks(
  tx: TenantTx,
  outcomes: ReadonlyMap<string, LinkOutcome>,
  at: Date,
): Promise<{ cancelled: number; paid: number; unchecked: number }> {
  const counts = { cancelled: 0, paid: 0, unchecked: 0 };
  for (const [depositId, outcome] of outcomes) {
    if (outcome === "paid") {
      await recordDepositPaid(tx, { depositId, eventId: null, at });
      counts.paid += 1;
    } else if (outcome === "cancelled" || outcome === "expired") {
      await recordDepositLapsed(tx, {
        depositId,
        status: outcome === "cancelled" ? "cancelled" : "expired",
        from: ["open"],
        eventId: null,
        at,
      });
      counts.cancelled += 1;
    } else {
      counts.unchecked += 1;
      await handUncheckedLink(tx, depositId);
    }
  }
  return counts;
}

/**
 * A link we can no longer check (access revoked, or Stripe unreachable). The
 * row stays `open`, which is the truth: it may have been paid, and a late
 * `checkout.session.completed` still records it (connect-events.ts resolves
 * the deposit by its own id, not by the clinic's current account). The
 * appointment goes to the front desk with the L10 alert flagged `mayBePaid`,
 * which its template words as "may have been paid; check Stripe before
 * collecting", and the audit row says the link was unchecked. The webhook's
 * deauthorization hands its open links here too: neither path can look.
 */
async function handUncheckedLink(tx: TenantTx, depositId: string): Promise<void> {
  const [row] = await tx.db
    .select({ appointmentId: depositPayments.appointmentId })
    .from(depositPayments)
    .where(and(eq(depositPayments.id, depositId), eq(depositPayments.clinicId, tx.clinicId)))
    .limit(1);
  tx.audit.record({
    action: "update",
    resourceType: "deposit_payment",
    resourceId: depositId,
    metadata: { outcome: "unchecked", reason: "link_may_be_paid" },
  });
  if (row?.appointmentId) await flagForFrontDesk(tx, row.appointmentId, { mayBePaid: true });
}

/**
 * Clear the clinic's account and stamp the disconnection, conditional on the
 * account still being the one we are disconnecting, then move what is still
 * `pending_link` to the desk. Returns null when another path already cleared
 * it, which is how the notice goes out once: only the path that stamps it
 * enqueues it (R22). For a location the caller enqueues the notice on the
 * billing clinic after this commits. `hasUncheckedLinks` says whether any
 * open link could not be expired or checked, so the email never calls a
 * link that may still be paid dead.
 */
async function clearAccount(
  tx: TenantTx,
  input: {
    accountId: string;
    at: Date;
    source: ConnectSource;
    wasByWebhook: boolean;
    actorLabel: string;
    deauthorized: boolean;
    hasUncheckedLinks: boolean;
    /** The payment switches the disconnect set back, which its email names. */
    resets: readonly SwitchReset[];
  },
): Promise<{ billingClinicId: string | null } | null> {
  const [cleared] = await tx.db
    .update(clinics)
    .set({
      stripeConnectAccountId: null,
      stripeConnectDisconnectedAt: input.at,
      updatedAt: input.at,
    })
    .where(and(eq(clinics.id, tx.clinicId), eq(clinics.stripeConnectAccountId, input.accountId)))
    .returning({ billingClinicId: clinics.billingClinicId });
  if (!cleared) return null;

  // Anything still waiting on a payment link is now the desk's: with the
  // account gone, no link of ours can be paid into it again.
  const pending = await tx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(eq(appointments.clinicId, tx.clinicId), eq(appointments.depositStatus, "pending_link")),
    );
  for (const row of pending) await flagForFrontDesk(tx, row.id);

  tx.audit.record({
    action: "update",
    resourceType: "clinic_stripe_connect",
    resourceId: tx.clinicId,
    metadata: {
      connected: false,
      source: input.source,
      wasByWebhook: input.wasByWebhook,
      deauthorized: input.deauthorized,
    },
  });
  await recordSecurityEvent(tx.db, {
    event: "stripe_connect_unlinked",
    actorLabel: input.actorLabel,
    metadata: {
      clinicId: tx.clinicId,
      accountRef: accountRef(input.accountId),
      source: input.source,
      wasByWebhook: input.wasByWebhook,
      deauthorized: input.deauthorized,
    },
  });
  if (cleared.billingClinicId === null) {
    await enqueueDisconnected(
      tx,
      input.accountId,
      input.at,
      input.wasByWebhook,
      input.source,
      input.hasUncheckedLinks,
      input.resets,
    );
  }
  return { billingClinicId: cleared.billingClinicId };
}

/** `connect_disconnected` (O14) on the billing clinic's tenant (R22). */
async function enqueueDisconnected(
  tx: TenantTx,
  accountId: string,
  at: Date,
  wasByWebhook: boolean,
  source: ConnectSource,
  hasUncheckedLinks: boolean,
  resets: readonly SwitchReset[],
): Promise<void> {
  const iso = at.toISOString();
  // The email already says deposits are off; it names the others it set back.
  const resetSwitchIds = resets
    .map((r) => r.switch)
    .filter((s): s is "full_payment" | "text_payment_link" => s !== "deposits");
  await enqueueNotice(tx, "connect_disconnected", `disconnected:${accountRef(accountId)}:${iso}`, {
    disconnectedAt: iso,
    wasByWebhook,
    source,
    hasUncheckedLinks,
    ...(resetSwitchIds.length > 0 ? { resetSwitchIds } : {}),
  });
}

/** The held-back reset email's input, for when the disconnect email does not go. */
function resetEmail(resets: readonly SwitchReset[], at: Date) {
  return { cause: "stripe_disconnected" as const, resets, key: `stripe_disconnected:${at.toISOString()}`, at };
}

/**
 * Stripe says our access to an account was revoked (`account.application.
 * deauthorized`): the same cascade as a disconnect for one clinic holding
 * that account, without any Stripe call, since we can no longer make one.
 * Open links cannot be checked, so they are handed to the desk as "may have
 * been paid" rather than expired.
 *
 * A deauthorization older than the clinic's current connection is ignored:
 * a disconnect followed by a quick reconnect of the same account would
 * otherwise be torn down by the late event for the first.
 */
export async function applyDeauthorization(input: {
  clinicId: string;
  accountId: string;
  eventCreatedAt: Date;
  now?: Date;
}): Promise<"applied" | "stale" | "not_connected"> {
  const now = input.now ?? new Date();
  const result = await withTenant(
    { clinicId: input.clinicId, actor: WEBHOOK_ACTOR },
    async (tx) => {
      const [clinic] = await tx.db
        .select({
          accountId: clinics.stripeConnectAccountId,
          connectedAt: clinics.stripeConnectConnectedAt,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic || clinic.accountId !== input.accountId)
        return { kind: "not_connected" as const };
      if (clinic.connectedAt && clinic.connectedAt.getTime() > input.eventCreatedAt.getTime()) {
        return { kind: "stale" as const };
      }
      const resets = await applySwitchResets(tx, {
        cause: "stripe_disconnected",
        actorLabel: "stripe",
        now,
        auditReason: "stripe_deauthorized",
        email: false,
      });
      await switchDepositsOff(tx, now);
      await tx.db
        .update(depositPayments)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(depositPayments.clinicId, tx.clinicId),
            eq(depositPayments.stripeAccountId, input.accountId),
            eq(depositPayments.status, "creating"),
          ),
        );
      const open = await tx.db
        .select({ id: depositPayments.id })
        .from(depositPayments)
        .where(
          and(
            eq(depositPayments.clinicId, tx.clinicId),
            eq(depositPayments.stripeAccountId, input.accountId),
            eq(depositPayments.status, "open"),
          ),
        );
      for (const link of open) await handUncheckedLink(tx, link.id);
      // The reset's audit row already says deposits went off, with this reason.
      if (!resets.some((r) => r.switch === "deposits")) {
        tx.audit.record({
          action: "update",
          resourceType: "clinic_settings",
          resourceId: tx.clinicId,
          metadata: {
            fields: ["depositsEnabled"],
            depositsEnabled: false,
            reason: "stripe_deauthorized",
          },
        });
      }
      // Every open link here is unchecked: our access is already gone.
      const hasUncheckedLinks = open.length > 0;
      const stamped = await clearAccount(tx, {
        accountId: input.accountId,
        at: now,
        source: "stripe",
        wasByWebhook: true,
        actorLabel: "stripe",
        deauthorized: true,
        hasUncheckedLinks,
        resets,
      });
      if (!stamped) await emailResets(tx, resetEmail(resets, now));
      return { kind: "applied" as const, stamped, hasUncheckedLinks, resets };
    },
  );
  if (result.kind !== "applied") return result.kind;
  if (result.stamped?.billingClinicId) {
    await withTenant({ clinicId: result.stamped.billingClinicId, actor: WEBHOOK_ACTOR }, (tx) =>
      enqueueDisconnected(tx, input.accountId, now, true, "stripe", result.hasUncheckedLinks, result.resets),
    );
  }
  return "applied";
}
