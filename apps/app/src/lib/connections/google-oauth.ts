import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  GOOGLE_CALENDAR_DISCLOSURE,
  GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE,
  googleCalendarDisclosureSha256,
} from "@healdesk/catalog";
import {
  buildGoogleAuthUrl,
  deriveGoogleOAuthSecrets,
  exchangeGoogleCode,
  googleCalendarAdapter,
  grantedCalendarScopes,
  parseGoogleIdToken,
  type ConnectorError,
  type GoogleGrant as GoogleTokenGrant,
  type GoogleIdentity,
  type GoogleOAuthClient,
} from "@healdesk/connectors";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";

import { unsafeDb } from "@/db";
import {
  calendarElections,
  clinicMemberships,
  clinics,
  connectionLinks,
  googleOauthStates,
  providerConnections,
  type GoogleOauthReturnTo,
} from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { releaseLiveHolds } from "@/lib/booking/holds";
import {
  calendarTermsFor,
  type CalendarTerms,
  type CalendarTermsInEffect,
} from "@/lib/booking/terms";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { notifyCalendarState } from "@/lib/notices/calendar-state";
import { notifyOps } from "@/lib/ops/notify";
import { requirePortal } from "@/lib/portal/access";
import { publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  calendarBreakOf,
  calendarConnectProblem,
  confirmCalendarTarget,
  GoogleGrant,
  googleCalendarConnection,
  googleOAuthClient,
  readGoogleGrantWithin,
  retireOtherAccountProviders,
  revokeGoogleGrantIfUnused,
  type GoogleCalendarConnection,
} from "./google-calendar";
import { consumeCalendarLinkWithin, issueConnectionLinkWithin } from "./links";
import { saveConnection } from "./store";

/**
 * Signing in with Google to connect a location's calendar (plan §4.3 to
 * §4.11, as the addendum changed them): the start, from a calendar link's
 * page or from the portal (`startGoogleConnect`, the funnel's contract), and
 * the callback.
 *
 * The round trip through Google is held together by four things, none of
 * which is ever stored in the clear: a single-use state (its SHA-256 is the
 * google_oauth_states row), the browser that started it (the SHA-256 of a
 * cookie, `hd_gcal`, HttpOnly, on the callback's path only), PKCE and the
 * nonce (each an HMAC of the state under a key derived from
 * BETTER_AUTH_SECRET, so neither is stored at all). The data-use notice the
 * practice ticked, its version and hash and when, ride on the state row.
 *
 * What is kept from Google is the refresh token, sealed, and three facts
 * from the ID token: the account reference (sha256 of the subject, never
 * the subject), whether it is a Workspace account (`hd`) and its email,
 * for the clinic's own eyes. Nothing is kept until every check has passed:
 * the scopes, the account rule, the terms, the connect-time verify() and
 * the notice's version. Every failure after the code exchange discards the
 * grant and revokes it at Google when no location holds the account live,
 * except a lost link burn and `account_in_use`, whose account may be live.
 */

// -----------------------------------------------------------------------------
// Fixed facts
// -----------------------------------------------------------------------------

export const GOOGLE_CALLBACK_PATH = "/api/calendar/google/callback";
export const GOOGLE_STATE_COOKIE = "hd_gcal";
/** The cookie goes back only to the start and callback routes. */
export const GOOGLE_STATE_COOKIE_PATH = "/api/calendar/google";
/** A state lives fifteen minutes (google_oauth_states_expiry_check); the cookie no longer. */
export const GOOGLE_STATE_TTL_SECONDS = 900;

/** Every way a sign-in can end, as `?outcome=` on the link page and `?calendar=` in the portal. */
export const GOOGLE_CONNECT_OUTCOMES = [
  "connected",
  "declined",
  "admin_blocked",
  "failed",
  "scopes",
  "no_refresh",
  "probe",
  "mismatch",
  "different_account",
  "election_needed",
  "account_in_use",
  "already_connected",
  "terms",
  "disclosure",
  "unavailable",
] as const;
export type GoogleConnectOutcome = (typeof GOOGLE_CONNECT_OUTCOMES)[number];

export function isGoogleConnectOutcome(value: unknown): value is GoogleConnectOutcome {
  return (GOOGLE_CONNECT_OUTCOMES as readonly unknown[]).includes(value);
}

/** The redirect URI Google sends the browser back to, from the public origin. */
export function googleRedirectUri(): string {
  return publicUrl(GOOGLE_CALLBACK_PATH);
}

/** HKDF of BETTER_AUTH_SECRET: the key the nonce and the PKCE verifier are HMACs under (plan §4.4). */
function oauthKey(): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", env.betterAuthSecret(), "healdesk", "google-oauth-v1", 32),
  );
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "calendar-link" };

function portalActor(userId: string): ActorContext {
  return { type: "user", userId, label: "clinic portal" };
}

// -----------------------------------------------------------------------------
// Starting a sign-in
// -----------------------------------------------------------------------------

export type GoogleConnectRefusal =
  /** Not configured, cannot seal, or no public origin: nobody is sent to Google. */
  | "unavailable"
  /** The location's terms do not allow writing to a calendar (`none`, `not_used`). */
  | "terms"
  /** The location's terms are not recorded yet: an election comes first. */
  | "needs_election"
  /** The notice was not ticked, or was ticked on another version. */
  | "disclosure"
  /** The portal's `returnTo` is not exactly /c/<slug>/setup or /c/<slug>/settings for this clinic. */
  | "return_to"
  /** The portal user holds no active membership of the clinic. */
  | "not_member";

export class GoogleConnectError extends Error {
  constructor(
    readonly code: GoogleConnectRefusal,
    message: string,
  ) {
    super(message);
    this.name = "GoogleConnectError";
  }
}

export type GoogleSignInVia =
  | { kind: "calendar_link"; linkId: string; token: string }
  | { kind: "portal"; userId: string; returnTo: Extract<GoogleOauthReturnTo, "portal" | "wizard"> };

/**
 * Mint a sign-in: refuse unless Google may be asked at all, the notice was
 * ticked on the current version and the location's terms allow writing; then
 * store the state row (with the notice's version, hash and the time it was
 * accepted), audit the acceptance, and hand back Google's consent URL and
 * the cookie value that binds the round trip to this browser. The caller
 * sets the cookie (the route's Set-Cookie, or the server action's cookies()).
 *
 * A plain recipients link on a location already connected may start a
 * sign-in: the callback lets it reconnect the same account and nothing else.
 */
export async function beginGoogleSignIn(input: {
  clinicId: string;
  via: GoogleSignInVia;
  disclosureVersion: string | null | undefined;
  actor: ActorContext;
  request?: RequestContext;
}): Promise<{ authUrl: string; cookieValue: string }> {
  const problem = await calendarConnectProblem();
  const client = googleOAuthClient();
  if (problem || !client) {
    log.warn("calendar sign-in refused: unavailable", {
      clinicId: input.clinicId,
      reason: problem ?? "no client",
    });
    throw new GoogleConnectError("unavailable", "Calendar connection isn't available yet.");
  }
  if (input.disclosureVersion !== GOOGLE_CALENDAR_DISCLOSURE.version) {
    throw new GoogleConnectError(
      "disclosure",
      "Tick the box under the notice to allow healdesk to use the calendar.",
    );
  }

  const state = randomBytes(32).toString("base64url");
  const bind = randomBytes(32).toString("base64url");
  const via = input.via;

  await withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      if (await leaving(tx)) {
        throw new GoogleConnectError("terms", "This location is leaving healdesk.");
      }
      const terms = await calendarTermsFor(tx);
      if (terms.kind === "needs_election") {
        throw new GoogleConnectError(
          "needs_election",
          "This location's calendar terms have to be recorded first.",
        );
      }
      if (!terms.allowsWrite) {
        throw new GoogleConnectError(
          "terms",
          "This location's calendar terms don't let healdesk use a calendar.",
        );
      }
      await tx.db.insert(googleOauthStates).values({
        stateHash: sha256(state),
        targetClinicId: tx.clinicId,
        initiatedVia: via.kind,
        linkId: via.kind === "calendar_link" ? via.linkId : null,
        userId: via.kind === "portal" ? via.userId : null,
        returnTo: via.kind === "calendar_link" ? "calendar_link" : via.returnTo,
        browserBindingHash: sha256(bind),
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        disclosureSha256: Buffer.from(googleCalendarDisclosureSha256(), "hex"),
        disclosureAcceptedAt: sql`now()`,
        // One clock for both ends of the fifteen minutes.
        expiresAt: sql`now() + make_interval(secs => ${GOOGLE_STATE_TTL_SECONDS})`,
      });
      tx.audit.record({
        action: "create",
        resourceType: "calendar_disclosure_acceptance",
        resourceId: tx.clinicId,
        metadata: {
          event: "calendar_disclosure_accepted",
          version: GOOGLE_CALENDAR_DISCLOSURE.version,
          via: via.kind,
        },
      });
    },
  );

  const { nonce, codeVerifier } = deriveGoogleOAuthSecrets(oauthKey(), state);
  const authUrl = buildGoogleAuthUrl({
    clientId: client.clientId,
    redirectUri: googleRedirectUri(),
    state,
    nonce,
    codeVerifier,
  });
  return {
    authUrl,
    cookieValue: `${bind}.${via.kind === "calendar_link" ? via.token : ""}`,
  };
}

/** The Set-Cookie header for a sign-in's browser binding. */
export function stateCookieHeader(value: string): string {
  return [
    `${GOOGLE_STATE_COOKIE}=${value}`,
    `Path=${GOOGLE_STATE_COOKIE_PATH}`,
    `Max-Age=${GOOGLE_STATE_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(env.isProduction() ? ["Secure"] : []),
  ].join("; ");
}

/** The Set-Cookie header that ends it: every callback response sends this. */
export function clearStateCookieHeader(): string {
  return [
    `${GOOGLE_STATE_COOKIE}=`,
    `Path=${GOOGLE_STATE_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(env.isProduction() ? ["Secure"] : []),
  ].join("; ");
}

/** The cookie's value from a Cookie header, or null. */
export function readStateCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === GOOGLE_STATE_COOKIE) return part.slice(at + 1).trim();
  }
  return null;
}

const PORTAL_RETURN = /^\/c\/([a-z0-9][a-z0-9-]{0,199})\/(setup|settings)$/;

/**
 * The portal's start (the funnel's contract of 6 October 2026), for a server
 * action on app.healdesk.io: `{ authUrl }`, with the browser-binding cookie
 * set on the response. `returnTo` is exactly `/c/<slug>/setup` or
 * `/c/<slug>/settings` for this clinic's own slug, and the callback comes
 * back to it with `?calendar=<outcome>`; nothing else is accepted, so it is
 * never an open redirect.
 *
 * The state row names the portal user, who is the callback's actor. The
 * caller may pass the user it already resolved with requirePortal(slug);
 * otherwise this asks requirePortal itself, and either way it checks that
 * the user holds an active membership of this clinic. Refusals are
 * GoogleConnectError with a closed `code`; `needs_election` means the
 * location's terms must be recorded first (setup step 3 shows "Bookings
 * arrive as requests your team confirms." until then).
 */
export async function startGoogleConnect(input: {
  clinicId: string;
  returnTo: string;
  disclosureVersion: string;
  userId?: string;
}): Promise<{ authUrl: string }> {
  const match = typeof input.returnTo === "string" ? PORTAL_RETURN.exec(input.returnTo) : null;
  if (!match) throw new GoogleConnectError("return_to", "That is not a page to return to.");
  const [, slug, page] = match;
  const userId = input.userId ?? (await requirePortal(slug!)).userId;
  const actor = portalActor(userId);
  // The clinic row and its memberships are the tenant's own, so both are
  // read inside it: a clinic id that is not this slug's finds nothing.
  const found = await withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({ slug: clinics.slug })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic || clinic.slug !== slug) return "return_to" as const;
    return (await activeMembership(tx, userId)) ? null : ("not_member" as const);
  });
  if (found === "return_to") {
    throw new GoogleConnectError("return_to", "That is not a page to return to.");
  }
  if (found === "not_member") {
    throw new GoogleConnectError("not_member", "That sign-in is not this clinic's.");
  }

  const { authUrl, cookieValue } = await beginGoogleSignIn({
    clinicId: input.clinicId,
    via: { kind: "portal", userId, returnTo: page === "setup" ? "wizard" : "portal" },
    disclosureVersion: input.disclosureVersion,
    actor,
  });
  (await cookies()).set(GOOGLE_STATE_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    path: GOOGLE_STATE_COOKIE_PATH,
    maxAge: GOOGLE_STATE_TTL_SECONDS,
    secure: env.isProduction(),
  });
  return { authUrl };
}

/** The location is offboarding or its data destroyed: no calendar is connected to it again. */
async function leaving(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ started: clinics.offboardingStartedAt, destroyed: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return !row || row.started !== null || row.destroyed !== null;
}

async function activeMembership(tx: TenantTx, userId: string): Promise<{ role: string } | null> {
  const [row] = await tx.db
    .select({ role: clinicMemberships.role })
    .from(clinicMemberships)
    .where(
      and(
        eq(clinicMemberships.clinicId, tx.clinicId),
        eq(clinicMemberships.userId, userId),
        isNull(clinicMemberships.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// -----------------------------------------------------------------------------
// The callback
// -----------------------------------------------------------------------------

export type GoogleCallbackInput = {
  state: string | null;
  code: string | null;
  error: string | null;
  /** The `hd_gcal` cookie's value. */
  cookie: string | null;
  request?: RequestContext;
};

export type GoogleCallbackResult = {
  /** `expired` when the state or the browser did not check out: nothing is known of the clinic. */
  outcome: GoogleConnectOutcome | "expired";
  /** A path on this app; the route makes it absolute. */
  redirectPath: string;
};

type ConsumedState = {
  clinicId: string;
  initiatedVia: "calendar_link" | "portal";
  linkId: string | null;
  userId: string | null;
  returnTo: GoogleOauthReturnTo;
  bindingHash: Buffer;
  disclosureVersion: string;
};

/** Outcomes that leave the calendar link usable, so the browser goes back to its page. */
const LINK_STILL_LIVE: ReadonlySet<GoogleConnectOutcome> = new Set([
  "declined",
  "admin_blocked",
  "failed",
  "scopes",
  "no_refresh",
  "probe",
  "mismatch",
  "different_account",
  "election_needed",
  "account_in_use",
  "terms",
  "disclosure",
  "unavailable",
]);

/** A refusal decided inside the final transaction, which rolled back with it. */
class SignInRefused extends Error {
  constructor(readonly outcome: GoogleConnectOutcome) {
    super(`calendar sign-in refused: ${outcome}`);
    this.name = "SignInRefused";
  }
}

/**
 * The callback's work (plan §4.5), in an order chosen so nothing is kept
 * before everything is checked:
 *
 *   1. consume the state (single use, unexpired) and check the browser's
 *      binding; either failing ends here as `expired`;
 *   2. Google's own error: `declined`, `admin_blocked`, or `failed`;
 *   3. exchange the code (with the PKCE verifier); from here every failure
 *      discards the grant and revokes it when unused;
 *   4. the ID token (issuer, audience, expiry, nonce, subject), the three
 *      calendar scopes (`scopes`) and a refresh token (`no_refresh`);
 *   5. the account rule: a different account than the live one needs the
 *      owner's change link (or the owner in the portal), and a different
 *      kind or Workspace domain needs the owner's calendar election first,
 *      after which the same sign-in goes through;
 *   6. the terms: they must allow writing, and the account kind must be the
 *      one they name (`mismatch`; a covered location needs a Workspace
 *      account, HRC-04);
 *   7. verify(): free/busy and the owner role on the calendar booked into
 *      (`primary` for a new account; a reconnect keeps its chosen calendar,
 *      and falls back to primary only when Google definitively refuses it);
 *   8. the notice's version is still compatible (`disclosure`);
 *   9. one tenant transaction: burn the link, read the replaced account's
 *      token, save the connection (`account_in_use` if another location
 *      holds the account live), mark it healthy, release holds, audit, tell
 *      the clinic of a reconnect after setup, and mint the link page's
 *      continuation link;
 *  10. after commit, revoke the replaced account's grant when unused.
 */
export async function completeGoogleSignIn(
  input: GoogleCallbackInput,
): Promise<GoogleCallbackResult> {
  const expired: GoogleCallbackResult = {
    outcome: "expired",
    redirectPath: "/calendar/done?outcome=expired",
  };
  const cookie = parseCookieValue(input.cookie);
  if (!input.state || !TOKEN_SHAPE.test(input.state) || !cookie) return expired;

  const consumed = await consumeState(input.state, input.request?.ipAddress ?? null);
  if (!consumed) return expired;
  const presented = sha256(cookie.bind);
  if (
    presented.length !== consumed.bindingHash.length ||
    !timingSafeEqual(presented, consumed.bindingHash)
  ) {
    return expired;
  }

  const clinicId = consumed.clinicId;
  const actor = consumed.userId ? portalActor(consumed.userId) : LINK_ACTOR;
  const request = input.request;
  const destination = await destinationFor(consumed, cookie.linkToken, actor);
  const finish = (outcome: GoogleConnectOutcome): GoogleCallbackResult => ({
    outcome,
    redirectPath: destination(outcome),
  });
  const refuse = async (outcome: GoogleConnectOutcome): Promise<GoogleCallbackResult> => {
    await recordRefusal(clinicId, actor, request, consumed, outcome);
    return finish(outcome);
  };

  // 2. Google's own answer.
  if (input.error) {
    return refuse(
      input.error === "access_denied"
        ? "declined"
        : input.error === "admin_policy_enforced"
          ? "admin_blocked"
          : "failed",
    );
  }
  if (!input.code) return refuse("failed");
  const client = googleOAuthClient();
  if (!client) return refuse("unavailable");

  // 3. The exchange.
  const { nonce, codeVerifier } = deriveGoogleOAuthSecrets(oauthKey(), input.state);
  const exchanged = await exchangeGoogleCode({
    client,
    code: input.code,
    redirectUri: googleRedirectUri(),
    codeVerifier,
  });
  if (!exchanged.ok) {
    if (exchanged.error.reason === "oauth_client") {
      await notifyOps("google_oauth_client_rejected", { clinicId });
    }
    log.warn("calendar sign-in: the code exchange failed", {
      clinicId,
      code: exchanged.error.code,
      reason: exchanged.error.reason ?? null,
    });
    return refuse("failed");
  }
  const grant = exchanged.value;
  let identity: GoogleIdentity | null = null;
  const discard = async (outcome: GoogleConnectOutcome): Promise<GoogleCallbackResult> => {
    await revokeGoogleGrantIfUnused(grantToRevoke(grant, identity), { clinicId, reason: outcome });
    return refuse(outcome);
  };

  try {
    // 4. Who, and what they granted.
    const parsed = grant.idToken
      ? parseGoogleIdToken(grant.idToken, { clientId: client.clientId, nonce })
      : null;
    if (!parsed?.ok) {
      log.warn("calendar sign-in: no usable ID token", {
        clinicId,
        reason: parsed && !parsed.ok ? (parsed.error.reason ?? parsed.error.code) : "missing",
      });
      return discard("failed");
    }
    identity = parsed.value;
    if (!grantedCalendarScopes(grant.scopes).complete) return discard("scopes");
    if (!grant.refreshToken) return discard("no_refresh");
    const refreshToken = grant.refreshToken;
    const account = identity;

    // 5 and 6, on what the location holds now.
    const facts = await withTenant({ clinicId, actor, request }, (tx) => signInFacts(tx, consumed));
    const ruled = judge(facts, account);
    if (ruled) return discard(ruled);
    const terms = facts.terms as CalendarTermsInEffect;

    // 7. The calendar booked into, checked with Google outside any transaction.
    const sameAccount = facts.live !== null && facts.live.accountRef === account.accountRef;
    const kept = sameAccount ? facts.live!.calendarId : "primary";
    const target = await verifyTarget({
      client,
      clinicId,
      refreshToken,
      candidates: kept !== "primary" ? [kept, "primary"] : ["primary"],
      account: terms.account,
      managed: account.managed,
    });
    if (!target) return discard("probe");

    // 8. The notice the practice ticked is one a connection may stand on.
    if (!GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE.includes(consumed.disclosureVersion)) {
      return discard("disclosure");
    }

    // 9. Keep it.
    let saved: SavedSignIn;
    try {
      saved = await withTenant({ clinicId, actor, request }, (tx) =>
        keepSignIn(tx, {
          consumed,
          linkToken: cookie.linkToken,
          account,
          refreshToken,
          scopes: grant.scopes,
          target,
          actor,
          request,
        }),
      );
    } catch (error) {
      if (error instanceof SignInRefused) {
        if (error.outcome === "already_connected") return refuse("already_connected");
        return discard(error.outcome);
      }
      if (isAccountLive(error)) return refuse("account_in_use");
      throw error;
    }

    // 10. The account it replaced, if any, is revoked when nothing else holds it.
    if (saved.replacedGrant) {
      await revokeGoogleGrantIfUnused(saved.replacedGrant, { clinicId, reason: "calendar_change" });
    }
    if (saved.continuationToken) {
      return {
        outcome: "connected",
        redirectPath: `/calendar/${saved.continuationToken}?outcome=connected`,
      };
    }
    return finish("connected");
  } catch (error) {
    log.error("calendar sign-in failed after the code exchange", {
      clinicId,
      error: describeError(error),
    });
    return discard("failed");
  }
}

function parseCookieValue(raw: string | null): { bind: string; linkToken: string | null } | null {
  if (!raw) return null;
  const at = raw.indexOf(".");
  if (at < 0) return null;
  const bind = raw.slice(0, at);
  const token = raw.slice(at + 1);
  if (!TOKEN_SHAPE.test(bind)) return null;
  if (token !== "" && !TOKEN_SHAPE.test(token)) return null;
  return { bind, linkToken: token === "" ? null : token };
}

/** The single-use consume: used_at set once, by a conditional UPDATE (plan §4.4). */
async function consumeState(state: string, ip: string | null): Promise<ConsumedState | null> {
  const first = ip?.split(",")[0]?.trim();
  const consumedIp = first && isIP(first) !== 0 ? first : null;
  const [row] = await unsafeDb
    .update(googleOauthStates)
    .set({ usedAt: sql`now()`, consumedIp })
    .where(
      and(
        eq(googleOauthStates.stateHash, sha256(state)),
        isNull(googleOauthStates.usedAt),
        gt(googleOauthStates.expiresAt, sql`now()`),
      ),
    )
    .returning({
      clinicId: googleOauthStates.targetClinicId,
      initiatedVia: googleOauthStates.initiatedVia,
      linkId: googleOauthStates.linkId,
      userId: googleOauthStates.userId,
      returnTo: googleOauthStates.returnTo,
      bindingHash: googleOauthStates.browserBindingHash,
      disclosureVersion: googleOauthStates.disclosureVersion,
    });
  return row ?? null;
}

/**
 * Where each outcome sends the browser: the link page (while its link is
 * still good) or the neutral done page, for a link's sign-in; the portal
 * page it started from, with `?calendar=<outcome>`, for the portal's. The
 * portal path is built from the clinic's own slug, never from the request.
 */
async function destinationFor(
  consumed: ConsumedState,
  linkToken: string | null,
  actor: ActorContext,
): Promise<(outcome: GoogleConnectOutcome) => string> {
  if (consumed.initiatedVia === "portal") {
    const slug = await withTenant({ clinicId: consumed.clinicId, actor }, async (tx) => {
      const [row] = await tx.db
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      return row?.slug ?? null;
    });
    const page = consumed.returnTo === "wizard" ? "setup" : "settings";
    return (outcome) =>
      slug ? `/c/${slug}/${page}?calendar=${outcome}` : `/calendar/done?outcome=${outcome}`;
  }
  return (outcome) =>
    linkToken && LINK_STILL_LIVE.has(outcome)
      ? `/calendar/${linkToken}?outcome=${outcome}`
      : `/calendar/done?outcome=${outcome}`;
}

/** The grant from the exchange, for revoking: the refresh token when there is one. */
function grantToRevoke(grant: GoogleTokenGrant, identity: GoogleIdentity | null): GoogleGrant {
  return new GoogleGrant(grant.refreshToken ?? grant.accessToken, identity?.accountRef ?? null);
}

async function recordRefusal(
  clinicId: string,
  actor: ActorContext,
  request: RequestContext | undefined,
  consumed: ConsumedState,
  outcome: GoogleConnectOutcome,
): Promise<void> {
  try {
    await withTenant({ clinicId, actor, request }, async (tx) => {
      tx.audit.record({
        action: "update",
        resourceType: "google_oauth_state",
        resourceId: tx.clinicId,
        metadata: { event: "calendar_connect_refused", outcome, via: consumed.initiatedVia },
      });
    });
  } catch (error) {
    log.error("calendar sign-in refusal not recorded", {
      clinicId,
      outcome,
      error: describeError(error),
    });
  }
}

type SignInFacts = {
  /** Offboarding or destroyed. */
  leaving: boolean;
  terms: CalendarTerms;
  /** The location's connection when it is live (not revoked). */
  live: GoogleCalendarConnection | null;
  /** The sign-in may replace the live account with another. */
  allowsAccountChange: boolean;
  /**
   * The practice owner has recorded a calendar election since the live
   * connection was made: an account of another kind or Workspace domain may
   * then replace it (plan §4.5 step 6).
   */
  ownerElectedSinceConnect: boolean;
};

/** metadata.termsSequence: the location's newest election when the connection was made. */
function termsSequenceOf(connection: GoogleCalendarConnection): number {
  const value = connection.metadata.termsSequence;
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/**
 * The location's newest calendar election (its `agreement` row included),
 * by sequence, which the guard numbers 1, 2, 3… per location: stored on the
 * connection when it is made, so a later election is told from an earlier
 * one without comparing two clocks.
 */
async function newestTermsSequence(tx: TenantTx): Promise<number | null> {
  const [row] = await tx.db
    .select({ sequence: calendarElections.sequence })
    .from(calendarElections)
    .where(eq(calendarElections.clinicId, tx.clinicId))
    .orderBy(desc(calendarElections.sequence))
    .limit(1);
  return row?.sequence ?? null;
}

async function ownerElectedSince(
  tx: TenantTx,
  live: GoogleCalendarConnection | null,
): Promise<boolean> {
  if (!live) return false;
  const [row] = await tx.db
    .select({ id: calendarElections.id })
    .from(calendarElections)
    .where(
      and(
        eq(calendarElections.clinicId, tx.clinicId),
        eq(calendarElections.ownerConfirmed, true),
        gt(calendarElections.sequence, termsSequenceOf(live)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function signInFacts(tx: TenantTx, consumed: ConsumedState): Promise<SignInFacts> {
  const row = await googleCalendarConnection(tx);
  const live = row && row.status !== "revoked" ? row : null;
  let allowsAccountChange = false;
  if (consumed.initiatedVia === "portal" && consumed.userId) {
    // The portal's account change is the owner's (plan §4.12); in v1 the
    // clinic's one sign-in is its owner.
    allowsAccountChange = (await activeMembership(tx, consumed.userId))?.role === "owner";
  } else if (consumed.linkId) {
    const [link] = await tx.db
      .select({ allowsAccountChange: connectionLinks.allowsAccountChange })
      .from(connectionLinks)
      .where(
        and(eq(connectionLinks.id, consumed.linkId), eq(connectionLinks.clinicId, tx.clinicId)),
      )
      .limit(1);
    allowsAccountChange = link?.allowsAccountChange === true;
  }
  return {
    leaving: await leaving(tx),
    terms: await calendarTermsFor(tx),
    live,
    allowsAccountChange,
    ownerElectedSinceConnect: await ownerElectedSince(tx, live),
  };
}

/** The account rule and the reconciliation against the terms (plan §4.5 step 6, §4.11). */
function judge(facts: SignInFacts, account: GoogleIdentity): GoogleConnectOutcome | null {
  const live = facts.live;
  if (live && live.accountRef !== account.accountRef) {
    if (!facts.allowsAccountChange) return "different_account";
    // Another kind of account, or another Workspace organisation, answers
    // "which Google account holds the calendar" differently from the
    // connection the location has, so the owner elects for it first: on the
    // change link the page shows the election form, which counts as the
    // owner's. The sign-in after that election goes through, under the
    // terms it recorded (checked next).
    if (
      (live.managed !== account.managed || live.hostedDomain !== account.hostedDomain) &&
      !facts.ownerElectedSinceConnect
    ) {
      return "election_needed";
    }
  }
  if (facts.leaving || !facts.terms.allowsWrite) return "terms";
  const terms = facts.terms as CalendarTermsInEffect;
  // A Workspace account (Google's `hd`) for the two Workspace kinds, a
  // personal one for `personal`: covered terms on a consumer account are
  // refused here, before anything is kept (HRC-04).
  if (account.managed !== (terms.account !== "personal")) return "mismatch";
  return null;
}

type VerifiedTarget = { calendarId: string; timeZone: string | null; accessRole: string | null };

/**
 * The calendar the connection books into, checked with Google: each
 * candidate in turn must pass the HRC-04 rule for these terms
 * (confirmCalendarTarget) and the connect-time verify(). A reconnect's
 * candidates are its chosen calendar, then the main one; it moves to the
 * main calendar only when Google definitively refuses the chosen one (not on
 * the account's list, gone, forbidden, or not the account's to own), and
 * keepSignIn audits that move. An answer Google could not give (the list
 * unreadable, a timeout, a refusal of the grant itself) ends the sign-in
 * here, so a location's bookings never move to a calendar nobody chose
 * because Google was busy. Null when no candidate passes.
 */
async function verifyTarget(input: {
  client: GoogleOAuthClient;
  clinicId: string;
  refreshToken: string;
  candidates: string[];
  account: CalendarTermsInEffect["account"];
  managed: boolean;
}): Promise<VerifiedTarget | null> {
  for (const calendarId of input.candidates) {
    const context = {
      clinicId: input.clinicId,
      connectionId: "connecting",
      credentials: { refresh_token: input.refreshToken },
      metadata: { calendarId },
      oauthClient: input.client,
    };
    const allowed = await confirmCalendarTarget({
      context,
      calendarId,
      account: input.account,
      writes: true,
      managed: input.managed,
    });
    if (!allowed.allowed) {
      log.warn("calendar sign-in: the calendar was not confirmed", {
        clinicId: input.clinicId,
        reason: allowed.reason,
      });
      if (allowed.reason === "outside_organisation" || allowed.reason === "not_owned") continue;
      return null;
    }
    const verified = await googleCalendarAdapter.verify(context);
    if (verified.ok) {
      return {
        calendarId,
        timeZone: verified.value.calendar?.timeZone ?? null,
        accessRole: verified.value.calendar?.accessRole ?? null,
      };
    }
    log.warn("calendar sign-in: verify refused the calendar", {
      clinicId: input.clinicId,
      code: verified.error.code,
      reason: verified.error.reason ?? null,
    });
    if (!refusesThisCalendar(verified.error)) return null;
  }
  return null;
}

/** Google's definitive no about one calendar (404, 403, not its owner), not about the grant or the moment. */
function refusesThisCalendar(error: ConnectorError): boolean {
  const broken = calendarBreakOf(error);
  return (
    broken === "calendar_not_found" ||
    broken === "insufficient_permissions" ||
    error.reason === "not_calendar_owner"
  );
}

type SavedSignIn = {
  connectionId: string;
  replacedGrant: GoogleGrant | null;
  continuationToken: string | null;
};

async function keepSignIn(
  tx: TenantTx,
  input: {
    consumed: ConsumedState;
    linkToken: string | null;
    account: GoogleIdentity;
    refreshToken: string;
    scopes: string[];
    target: VerifiedTarget;
    actor: ActorContext;
    request: RequestContext | undefined;
  },
): Promise<SavedSignIn> {
  const { consumed, account } = input;

  // The link's burn, inside this transaction, and only the link the sign-in
  // started from. A lost burn means another tab won: nothing here is kept.
  let link: {
    audience: "recipients" | "owner";
    sentTo: string[] | null;
    allowsAccountChange: boolean;
  } | null = null;
  if (consumed.initiatedVia === "calendar_link") {
    const burned = input.linkToken
      ? await consumeCalendarLinkWithin(tx, input.linkToken, input.request?.ipAddress ?? null)
      : null;
    if (!burned) throw new SignInRefused("already_connected");
    if (burned !== consumed.linkId) throw new SignInRefused("failed");
    const [row] = await tx.db
      .select({
        audience: connectionLinks.audience,
        sentTo: connectionLinks.sentTo,
        allowsAccountChange: connectionLinks.allowsAccountChange,
      })
      .from(connectionLinks)
      .where(eq(connectionLinks.id, burned))
      .limit(1);
    link = row ?? null;
  }

  // The rules again, on the row as it is locked now.
  const before = await googleCalendarConnection(tx, { forUpdate: true });
  const facts = await signInFacts(tx, consumed);
  const ruled = judge(
    { ...facts, live: before && before.status !== "revoked" ? before : null },
    account,
  );
  if (ruled) throw new SignInRefused(ruled);

  const replacing =
    before !== null && before.status !== "revoked" && before.accountRef !== account.accountRef;
  const replacedGrant = replacing
    ? await readGoogleGrantWithin(tx, before!, "calendar_change")
    : null;
  // Another account than the one the location last held, live or not: the
  // named providers' calendars were that account's.
  const accountChanged = before !== null && before.accountRef !== account.accountRef;
  const ownOrganization = facts.terms.kind === "covered";

  const now = new Date();
  const connectionId = await saveConnection(tx.db, {
    clinicId: tx.clinicId,
    provider: "google_calendar",
    credentials: { refresh_token: input.refreshToken },
    metadata: {
      calendarId: input.target.calendarId,
      ...(account.email ? { accountEmail: account.email } : {}),
      managed: account.managed,
      ...(account.hostedDomain ? { hostedDomain: account.hostedDomain } : {}),
      calendarTimeZone: input.target.timeZone,
      accessRole: input.target.accessRole,
      calendarCheckedAt: now.toISOString(),
      calendarScope: ownOrganization ? "own_organization" : "owned",
      scopes: input.scopes,
      connectedAt: now.toISOString(),
      connectedVia: consumed.initiatedVia,
      disclosureVersion: consumed.disclosureVersion,
      // An owner's election after this one lets another kind of account or
      // Workspace domain replace this connection (judge).
      termsSequence: await newestTermsSequence(tx),
    },
    accountRef: account.accountRef,
  });
  const [healthy] = await tx.db
    .update(providerConnections)
    .set({
      status: "active",
      lastVerifiedAt: now,
      lastError: null,
      brokenAt: null,
      brokenAlertedAt: null,
      transientFailures: 0,
      updatedAt: now,
    })
    .where(
      and(eq(providerConnections.id, connectionId), eq(providerConnections.clinicId, tx.clinicId)),
    )
    .returning({ iv: providerConnections.iv });
  const releasedHolds = await releaseLiveHolds(tx, "calendar_changed");
  const retiredProviders = accountChanged ? await retireOtherAccountProviders(tx) : 0;

  tx.audit.record({
    action: before ? "update" : "create",
    resourceType: "provider_connection",
    resourceId: connectionId,
    metadata: {
      event: "calendar_connected",
      managed: account.managed,
      via: consumed.initiatedVia,
      changedAccount: replacing,
      calendarPrimary: input.target.calendarId === "primary",
      releasedHolds,
      retiredProviders,
    },
  });
  // The calendar booked into moved (a reconnect whose chosen calendar Google
  // refused, or a new account after another's choice): the same audit as a
  // choice in the picker, with no name and no id.
  if (before !== null && before.calendarId !== input.target.calendarId) {
    tx.audit.record({
      action: "update",
      resourceType: "provider_connection",
      resourceId: connectionId,
      metadata: {
        event: "calendar_target_changed",
        primary: input.target.calendarId === "primary",
        changed: true,
        via: "sign_in",
        ownOrganization,
      },
    });
  }
  const [clinic] = await tx.db
    .select({ organizationId: clinics.organizationId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await recordSecurityEvent(tx.db, {
    event: "calendar_connected",
    actorLabel: input.actor.type === "user" ? input.actor.label : "calendar-link",
    userId: input.actor.type === "user" ? input.actor.userId : null,
    organizationId: clinic?.organizationId ?? null,
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
    metadata: {
      clinicId: tx.clinicId,
      connectionId,
      managed: account.managed,
      changedAccount: replacing,
      via: consumed.initiatedVia,
    },
  });

  // A connect during setup tells nobody; a reconnect after it tells the
  // clinic (email O13 from the funnel's M3, queued in this transaction).
  if (before !== null && consumed.returnTo !== "wizard") {
    await notifyCalendarState(tx.db, tx.clinicId, "reconnected", {
      dedupeKey: `calendar-reconnected:${connectionId}:${healthy?.iv ?? now.getTime()}`,
    });
  }

  // The link page goes on from here (the calendar picker), on a link of its
  // own: a day, the same audience and account-change flag, never mailed.
  let continuationToken: string | null = null;
  if (link) {
    const next = await issueConnectionLinkWithin(
      tx,
      {
        purpose: "calendar",
        expiresInDays: 1,
        audience: link.audience,
        sentTo: link.sentTo,
        allowsAccountChange: link.allowsAccountChange,
      },
      input.actor,
    );
    continuationToken = next.token;
  }
  return { connectionId, replacedGrant, continuationToken };
}

/** The unique index that keeps one Google account live on one location (plan §4.13). */
function isAccountLive(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown };
    if (e.code === "23505" && e.constraint === "provider_connections_google_account_live_idx") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
