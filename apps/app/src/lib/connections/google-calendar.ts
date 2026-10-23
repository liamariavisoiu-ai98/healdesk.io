import { GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE, type CalendarAccount } from "@healdesk/catalog";
import {
  GOOGLE_CALENDAR_PROVIDER,
  googleCalendarAdapter,
  revokeGoogleToken,
  type ConnectorContext,
  type ConnectorError,
  type GoogleOAuthClient,
  type OwnedGoogleCalendar,
} from "@healdesk/connectors";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agentConfigs,
  clinicProviders,
  clinicProviderServices,
  clinics,
  providerConnections,
} from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { releaseLiveHolds } from "@/lib/booking/holds";
import { changeOriginOf, recordClinicChange, type ChangeOrigin } from "@/lib/clinic/change-events";
import { calendarTermsFor, type CalendarTermsInEffect } from "@/lib/booking/terms";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { eraseCredentials, withCredentials } from "@/lib/connections/store";
import { credentialSealingProblem } from "@/lib/crypto/kms";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { notifyCalendarState } from "@/lib/notices/calendar-state";
import { notifyOps } from "@/lib/ops/notify";
import { publicOriginProblem } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * A location's Google Calendar connection: one `google_calendar` row in
 * provider_connections, holding the sealed refresh token and nothing else
 * secret (plan §4.8), with the breakage stamps the calendar watch reads
 * (drizzle/0057). Here: what counts as broken and what happens when it is;
 * disconnecting, revoking at Google and the terms sweep (plan §4.12, §4.13);
 * the portal's reads and choices (the funnel's contract of 6 October 2026:
 * getCalendarConnection, listCalendars, disconnect, the calendar the
 * location books into, and its named providers); and the check every
 * chosen calendar passes, at choice and before every write (HRC-04).
 * Signing in with Google is lib/connections/google-oauth.ts; the calendar
 * links and their page are lib/connections/calendar-links.ts.
 *
 * Health is stored and the booking mode is derived (plan §9.3), so marking a
 * connection broken is the whole of "flip the location to manual booking":
 * the next question anything asks of it gets a request, not a booking, in
 * the same turn.
 */

type ConnectionStatus = (typeof providerConnections.$inferSelect)["status"];

/**
 * The token-level answers (plan §4.12, §5.6): Google says the grant itself is
 * gone or no longer covers the calendar. The stored token can never work
 * again, so it is erased, and the row is revoked, which also frees the
 * account under the one-live-connection index.
 */
export const TOKEN_BREAKS = ["invalid_grant", "admin_policy_enforced", "scope_lost"] as const;

/**
 * The calendar-level answers: a fresh token is refused on the calendar (401),
 * the calendar is forbidden to it (403, but for rate limits and a disabled
 * API), or gone (404). The token is kept, because the grant may still be
 * good and a reconnect can point it at a calendar it may use; the row is in
 * `error`.
 */
export const CALENDAR_BREAKS = [
  "access_denied",
  "insufficient_permissions",
  "calendar_not_found",
] as const;

export type CalendarBreak = (typeof TOKEN_BREAKS)[number] | (typeof CALENDAR_BREAKS)[number];

export function isTokenBreak(code: string): code is (typeof TOKEN_BREAKS)[number] {
  return (TOKEN_BREAKS as readonly string[]).includes(code);
}

export function isCalendarBreak(code: string): code is CalendarBreak {
  return isTokenBreak(code) || (CALENDAR_BREAKS as readonly string[]).includes(code);
}

/**
 * Whether an adapter's failure is definitive for the location (owner
 * decision 5), and which break it is: the reason words the Google adapter
 * gives its definitive failures (packages/connectors/src/google/http.ts and
 * oauth.ts). Everything else is null: transient answers (timeouts, 5xx, rate
 * limits) never flip a location on one miss, and our own misconfiguration
 * (`oauth_client`, `api_disabled`) is the same for every clinic and never a
 * reason to take one clinic's token away.
 */
export function calendarBreakOf(
  error: { code: string; reason?: string | null } | null | undefined,
): CalendarBreak | null {
  const reason = error?.reason;
  if (!error || !reason) return null;
  if (error.code === "unauthorised" && UNAUTHORISED_BREAKS.has(reason)) {
    return reason as CalendarBreak;
  }
  if (error.code === "misconfigured" && reason === "calendar_not_found") return reason;
  return null;
}

/** The breaks the adapter reports as `unauthorised`; a missing calendar is `misconfigured`. */
const UNAUTHORISED_BREAKS: ReadonlySet<string> = new Set([
  ...TOKEN_BREAKS,
  "access_denied",
  "insufficient_permissions",
]);

export type GoogleCalendarConnection = {
  id: string;
  status: ConnectionStatus;
  /** sha256 hex of "google:" plus the Google subject. Never the subject. */
  accountRef: string | null;
  /**
   * Which sealing of the stored token this is, as an opaque string. It
   * changes whenever the token is saved (a connect, a reconnect with the same
   * account or another) or erased, and with nothing else, a key rotation's
   * rewrap included: it is the envelope's IV, random at every seal. A caller
   * that reads the token to ask Google something reads this with it, under
   * the row lock (`forUpdate`), and hands it back with Google's answer
   * (markCalendarBroken), so that an answer about a token we no longer hold
   * changes nothing.
   */
  credentialVersion: string;
  /** metadata.managed: a Workspace account (true), a personal one (false), or unknown (null). */
  managed: boolean | null;
  /** metadata.hostedDomain: the Workspace domain from the ID token's `hd`, or null. */
  hostedDomain: string | null;
  /** metadata.calendarId: the calendar the location books into; `primary` when none is stored. */
  calendarId: string;
  /** The row's metadata as stored: the account's email lives here, for the clinic only. */
  metadata: Record<string, unknown>;
  lastError: string | null;
  brokenAt: Date | null;
  brokenAlertedAt: Date | null;
};

/** The tenant's own Google Calendar connection row, revoked or not, or null. */
export async function googleCalendarConnection(
  tx: TenantTx,
  options: { forUpdate?: boolean } = {},
): Promise<GoogleCalendarConnection | null> {
  const query = tx.db
    .select({
      id: providerConnections.id,
      status: providerConnections.status,
      accountRef: providerConnections.accountRef,
      iv: providerConnections.iv,
      metadata: providerConnections.metadata,
      lastError: providerConnections.lastError,
      brokenAt: providerConnections.brokenAt,
      brokenAlertedAt: providerConnections.brokenAlertedAt,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, tx.clinicId),
        eq(providerConnections.provider, GOOGLE_CALENDAR_PROVIDER),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) return null;
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const { managed, hostedDomain, calendarId } = metadata;
  return {
    id: row.id,
    status: row.status,
    accountRef: row.accountRef,
    credentialVersion: row.iv,
    managed: typeof managed === "boolean" ? managed : null,
    hostedDomain: typeof hostedDomain === "string" && hostedDomain ? hostedDomain : null,
    calendarId: typeof calendarId === "string" && calendarId ? calendarId : "primary",
    metadata,
    lastError: row.lastError,
    brokenAt: row.brokenAt,
    brokenAlertedAt: row.brokenAlertedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Google grant taken away in this transaction, for revoking at Google once
 * the transaction has committed (plan §2.6, §4.12, §4.13:
 * revokeGoogleGrantIfUnused, below).
 * Revoking needs the refresh token itself, not the account, and erasing
 * seals `{}` over it, so the token is read first, through an audited
 * decrypt, and kept here, in memory and nowhere else.
 *
 * It never reaches a log, an audit row or a reply. The token is a private
 * field behind a getter: JSON.stringify and a spread see only the account
 * reference, util.inspect and the test runner's diffs show no value, and
 * React refuses to send a class instance to a browser at all. Only the
 * caller that revokes reads `refreshToken`.
 */
export class GoogleGrant {
  readonly #refreshToken: string;

  constructor(
    refreshToken: string,
    /** What revokeGoogleGrantIfUnused asks "does another location still use this account?" of. */
    readonly accountRef: string | null,
  ) {
    this.#refreshToken = refreshToken;
  }

  get refreshToken(): string {
    return this.#refreshToken;
  }

  toJSON(): { accountRef: string | null } {
    return { accountRef: this.accountRef };
  }
}

/**
 * Read the row's refresh token before it is erased, as every decrypt is
 * (store.ts): audited, with what it is for. Null when the bag holds no token,
 * or cannot be opened: the erasure goes ahead either way, since a token we
 * cannot read is one we cannot use, and taking the calendar away must never
 * wait on revoking it. The grant is then left as Google holds it, and the
 * line logged says so (ids only).
 */
async function readGrantBeforeErasure(
  tx: TenantTx,
  row: Pick<GoogleCalendarConnection, "id" | "accountRef">,
  purpose: string,
): Promise<GoogleGrant | null> {
  tx.audit.record({
    action: "decrypt",
    resourceType: "credential",
    resourceId: row.id,
    metadata: { provider: GOOGLE_CALENDAR_PROVIDER, purpose },
  });
  try {
    const refreshToken = await withCredentials(
      tx.db,
      { clinicId: tx.clinicId, connectionId: row.id },
      async (credentials) => credentials.refresh_token,
    );
    return refreshToken ? new GoogleGrant(refreshToken, row.accountRef) : null;
  } catch (error) {
    log.warn("calendar grant not read before erasure; it stays at Google", {
      clinicId: tx.clinicId,
      connectionId: row.id,
      purpose,
      error: describeError(error),
    });
    return null;
  }
}

/**
 * The stored grant, read for revoking once something that replaces it has
 * committed (a change of Google account, plan §4.5 step 10): the same
 * audited decrypt as an erasure's, under the caller's `purpose`.
 */
export async function readGoogleGrantWithin(
  tx: TenantTx,
  row: Pick<GoogleCalendarConnection, "id" | "accountRef">,
  purpose: string,
): Promise<GoogleGrant | null> {
  return readGrantBeforeErasure(tx, row, purpose);
}

export type ErasedGoogleCalendar = {
  connectionId: string;
  accountRef: string | null;
  releasedHolds: number;
  /** The grant to revoke at Google after commit; null when the bag held no token we could read. */
  grant: GoogleGrant | null;
};

/**
 * The transactional half of taking a location's Google Calendar away on
 * purpose (plan §4.12: a disconnect, the terms sweep, an election): read the
 * token into memory (an audited decrypt, `purpose` naming why, the reason by
 * default), erase it (re-sealed as `{}`, the row revoked, `last_error` the
 * reason) and release the location's holds, all in the caller's
 * transaction. Null when there is no connection left to erase.
 *
 * The breakage stamps are cleared with it. A revoked row that still has
 * `broken_at` is one Google took away (markCalendarBrokenWithin), which the
 * portal and the link page tell the clinic as "access was removed in your
 * Google Account"; a connection that had broken on its calendar and was then
 * disconnected on purpose is not that.
 *
 * After the caller commits, it revokes `grant` at Google through
 * revokeGoogleGrantIfUnused, which does so only when no other location
 * holds the same account live. A rolled-back erasure revokes nothing.
 */
export async function eraseGoogleCalendarWithin(
  tx: TenantTx,
  input: { connectionId: string; reason: string; purpose?: string },
): Promise<ErasedGoogleCalendar | null> {
  const row = await googleCalendarConnection(tx, { forUpdate: true });
  if (!row || row.id !== input.connectionId || row.status === "revoked") return null;
  const grant = await readGrantBeforeErasure(tx, row, input.purpose ?? input.reason);
  await eraseCredentials(tx.db, {
    clinicId: tx.clinicId,
    connectionId: row.id,
    reason: input.reason,
  });
  await tx.db
    .update(providerConnections)
    .set({ brokenAt: null, brokenAlertedAt: null, transientFailures: 0 })
    .where(and(eq(providerConnections.id, row.id), eq(providerConnections.clinicId, tx.clinicId)));
  const releasedHolds = await releaseLiveHolds(tx, input.reason);
  return { connectionId: row.id, accountRef: row.accountRef, releasedHolds, grant };
}

export type CalendarBrokenResult =
  /** No connection, or one already taken away on purpose: nothing left to break. */
  | { status: "not_connected" }
  /**
   * The token Google answered about is no longer the one stored: the
   * location reconnected, or connected another account, after the caller
   * read it. Google's answer is about a grant we no longer hold, so nothing
   * changed.
   */
  | { status: "stale" }
  | {
      status: "broken";
      connectionId: string;
      code: CalendarBreak;
      /** The token was erased by this call. */
      erased: boolean;
      /** This call claimed the alert: the clinic and ops are told now, and only now. */
      firstBreak: boolean;
      releasedHolds: number;
      /**
       * After a `scope_lost` erasure, the grant to revoke at Google once this
       * has committed (plan §4.12). Null for every other break: an
       * `invalid_grant` token is dead already, and a calendar-level break
       * keeps its token.
       */
      grant: GoogleGrant | null;
    };

/**
 * Mark the location's Google connection broken, in the caller's transaction
 * (plan §4.12, §8.2), from the booking path or the watch, whichever sees
 * Google's definitive answer first.
 *
 * The caller names the connection and the credential version it read with
 * the token it asked Google with (googleCalendarConnection). Google's answer
 * comes back seconds after that read, outside any transaction (plan §9.2), and
 * in between the location may have reconnected: the same row id, a new token,
 * perhaps another account. An answer about the old token then changes
 * nothing (`stale`), rather than erasing a connection made a moment ago.
 *
 *   - A token-level break erases the token and revokes the row; a
 *     calendar-level one keeps the token and puts the row in `error`. Before
 *     a `scope_lost` erasure the token is read, audited, for revoking at
 *     Google after commit (`grant`).
 *   - `broken_at` is the first sighting and stays so (coalesce); `last_error`
 *     is the word that broke it. `account_ref` is kept.
 *   - The location's holds are released (`calendar_broken`).
 *   - Once per episode, the first call claims `broken_alerted_at` and, in this
 *     same transaction, tells the clinic through the funnel's
 *     notifyCalendarState("stopped") (email O13, queued in this transaction
 *     from the funnel's M3, a no-op seam until then), and records the
 *     `calendar_broken` security event. A rolled-back break tells nobody, and a
 *     second call (the watch after the booking path, say) tells nobody again.
 *     The watch's alert pass (C10) finds such a row already claimed.
 *
 * A row revoked with no `broken_at` was disconnected on purpose, by the
 * clinic or an election, and has no access left to lose: not_connected.
 *
 * Ops is told by markCalendarBroken, after commit; a caller that runs this
 * in a transaction of its own (the watch, C10, which tells ops once per run
 * about all its breakages) raises `calendar_broken` itself once that
 * transaction has committed, when `firstBreak` is true, and revokes `grant`
 * then too.
 */
export async function markCalendarBrokenWithin(
  tx: TenantTx,
  input: {
    code: CalendarBreak;
    connectionId: string;
    credentialVersion: string;
    actorLabel?: string;
    request?: RequestContext;
  },
): Promise<CalendarBrokenResult> {
  if (!isCalendarBreak(input.code)) {
    throw new Error(`Not a definitive calendar break: ${String(input.code)}.`);
  }
  const row = await googleCalendarConnection(tx, { forUpdate: true });
  if (!row || row.id !== input.connectionId) return { status: "not_connected" };
  if (row.status === "revoked" && row.brokenAt === null) return { status: "not_connected" };
  if (row.credentialVersion !== input.credentialVersion) return { status: "stale" };

  const where = and(
    eq(providerConnections.id, row.id),
    eq(providerConnections.clinicId, tx.clinicId),
  );
  let erased = false;
  let grant: GoogleGrant | null = null;
  if (row.status !== "revoked") {
    if (isTokenBreak(input.code)) {
      if (input.code === "scope_lost") {
        grant = await readGrantBeforeErasure(tx, row, "calendar_broken");
      }
      erased = await eraseCredentials(tx.db, {
        clinicId: tx.clinicId,
        connectionId: row.id,
        reason: input.code,
      });
    }
    await tx.db
      .update(providerConnections)
      .set({
        status: erased ? "revoked" : "error",
        lastError: input.code,
        brokenAt: sql`coalesce(${providerConnections.brokenAt}, now())`,
        updatedAt: new Date(),
      })
      .where(where);
  }
  const releasedHolds = await releaseLiveHolds(tx, "calendar_broken");

  const firstBreak = await claimBreakageAlertWithin(tx, {
    connectionId: row.id,
    code: input.code,
    actorLabel: input.actorLabel ?? "google-calendar",
    request: input.request,
  });

  tx.audit.record({
    action: "update",
    resourceType: "provider_connection",
    resourceId: row.id,
    metadata: {
      provider: GOOGLE_CALENDAR_PROVIDER,
      broken: input.code,
      erased,
      releasedHolds,
      firstBreak,
    },
  });
  return {
    status: "broken",
    connectionId: row.id,
    code: input.code,
    erased,
    firstBreak,
    releasedHolds,
    grant,
  };
}

/**
 * Claim the alert for the location's breakage, once per episode: set
 * `broken_alerted_at` where `broken_at` is set and nobody has claimed it,
 * and, in the caller's transaction, tell the clinic through the funnel's
 * notifyCalendarState("stopped") and record the `calendar_broken` security
 * event. True when this call claimed it; false when there is no breakage, or
 * it was claimed already. Ops is the caller's, after commit.
 *
 * markCalendarBrokenWithin claims as it breaks; the calendar watch's alert
 * pass (lib/scheduler/calendar-watch.ts, plan §9.2 step 4) claims a breakage
 * nobody claimed. Both go through here, so one episode has one notice key,
 * and the clinic is told once whichever path tells it.
 */
export async function claimBreakageAlertWithin(
  tx: TenantTx,
  input: { connectionId: string; code: string; actorLabel: string; request?: RequestContext },
): Promise<boolean> {
  const [claimed] = await tx.db
    .update(providerConnections)
    .set({ brokenAlertedAt: sql`now()` })
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, tx.clinicId),
        isNotNull(providerConnections.brokenAt),
        isNull(providerConnections.brokenAlertedAt),
      ),
    )
    .returning({ brokenAt: providerConnections.brokenAt });
  if (!claimed?.brokenAt) return false;

  // One key per episode: a reconnect clears broken_at (C8), and the next
  // breakage is a new episode with a new key.
  await notifyCalendarState(tx.db, tx.clinicId, "stopped", {
    dedupeKey: `calendar-stopped:${input.connectionId}:${claimed.brokenAt.getTime()}`,
  });
  const [clinic] = await tx.db
    .select({ organizationId: clinics.organizationId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await recordSecurityEvent(tx.db, {
    event: "calendar_broken",
    actorLabel: input.actorLabel,
    organizationId: clinic?.organizationId ?? null,
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
    metadata: { clinicId: tx.clinicId, connectionId: input.connectionId, code: input.code },
  });
  return true;
}

const BROKEN_ACTOR: ActorContext = { type: "service", serviceName: "google-calendar" };

function actorLabelOf(actor: ActorContext): string {
  switch (actor.type) {
    case "user":
    case "connector":
      return actor.label;
    case "service":
    case "agent":
      return actor.serviceName;
    case "system":
      return "system";
  }
}

/**
 * markCalendarBrokenWithin in its own committed transaction (plan §8.2), then
 * ops: one `calendar_broken` alert per episode, after commit, so a break that
 * rolled back raises nothing. notifyOps never throws.
 *
 * A `grant` in the result is the caller's to revoke now that the erasure has
 * committed, through revokeGoogleGrantIfUnused: the caller knows whether it
 * runs where Google may be called (noteGoogleFailure below does both).
 */
export async function markCalendarBroken(
  clinicId: string,
  input: {
    code: CalendarBreak;
    connectionId: string;
    credentialVersion: string;
    actor?: ActorContext;
    request?: RequestContext;
  },
): Promise<CalendarBrokenResult> {
  const actor = input.actor ?? BROKEN_ACTOR;
  const result = await withTenant({ clinicId, actor, request: input.request }, (tx) =>
    markCalendarBrokenWithin(tx, {
      code: input.code,
      connectionId: input.connectionId,
      credentialVersion: input.credentialVersion,
      actorLabel: actorLabelOf(actor),
      request: input.request,
    }),
  );
  if (result.status === "broken" && result.firstBreak) {
    await notifyOps("calendar_broken", {
      clinicId,
      connectionId: result.connectionId,
      code: result.code,
    });
  }
  return result;
}

// -----------------------------------------------------------------------------
// healdesk's client, and whether anyone may be sent to Google at all
// -----------------------------------------------------------------------------

/** healdesk's OAuth client, from apps/app's environment, or undefined when it is not set. */
export function googleOAuthClient(): GoogleOAuthClient | undefined {
  const clientId = env.googleOAuthClientId();
  const clientSecret = env.googleOAuthClientSecret();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * Null when this deployment may send a practice to Google; otherwise why
 * not, worded for an operator. Three things, each of which would turn a
 * grant into one nobody can keep: the OAuth client is set, a refresh token
 * can be sealed (in production, KMS: credentialSealingProblem), and the
 * public origin every link and the redirect URI are built from is set. Asked
 * before any link is minted and before anyone is redirected (plan §4.3).
 */
export async function calendarConnectProblem(): Promise<string | null> {
  if (!env.googleCalendarConfigured()) {
    return "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set on apps/app.";
  }
  const sealing = await credentialSealingProblem();
  if (sealing) return sealing;
  return publicOriginProblem();
}

const CALENDAR_ACTOR: ActorContext = { type: "service", serviceName: "google-calendar" };

export type CalendarCallOptions = { actor?: ActorContext; request?: RequestContext };

// -----------------------------------------------------------------------------
// Revoking at Google, keyed by the Google subject (plan §4.13)
// -----------------------------------------------------------------------------

export type GrantRevocation =
  /** Google ended the grant, or already had. */
  | "revoked"
  | "already_invalid"
  /** Another location (or this one, connected again) holds the account live: not revoked. */
  | "skipped_live"
  /** Nothing says which account the grant is for, so nobody can say it is unused. */
  | "skipped_unknown_account"
  /** The count or the revoke failed; the grant is left as Google holds it. */
  | "failed";

/**
 * Revoke a grant healdesk no longer keeps, but only when no location holds
 * the same Google account live (app_google_account_live_count, 0057).
 * Google's revoke ends every grant that Google user gave healdesk, on every
 * clinic, so a revoke while another location uses the account would take
 * that location's calendar away too; a same-account reconnect, a losing
 * callback and an `account_in_use` refusal are never revoked for that
 * reason (their account is live).
 *
 * The token travels in a form body, 4 s and one retry (revokeGoogleToken).
 * 200 and 400 are both done. If the count itself cannot be read, nothing is
 * revoked, and the attempt is logged and recorded as a security event.
 * Never throws; every outcome is a security event with ids only.
 */
export async function revokeGoogleGrantIfUnused(
  grant: GoogleGrant,
  context: { clinicId: string | null; reason: string },
): Promise<GrantRevocation> {
  const outcome = await revokeIfUnused(grant, context);
  try {
    await recordSecurityEvent(unsafeDb, {
      event: "google_grant_revoke",
      actorLabel: "google-calendar",
      metadata: { clinicId: context.clinicId, outcome, reason: context.reason },
    });
  } catch (error) {
    log.error("could not record a Google revoke", {
      clinicId: context.clinicId,
      outcome,
      error: describeError(error),
    });
  }
  return outcome;
}

async function revokeIfUnused(
  grant: GoogleGrant,
  context: { clinicId: string | null; reason: string },
): Promise<GrantRevocation> {
  if (!grant.accountRef) return "skipped_unknown_account";
  let live: number;
  try {
    const result = await unsafeDb.execute<{ live: number | string }>(
      sql`select app_google_account_live_count(${grant.accountRef}) as live`,
    );
    live = Number(result.rows[0]?.live);
    if (!Number.isInteger(live)) throw new Error("The live count came back unreadable.");
  } catch (error) {
    log.error("Google grant not revoked: its live connections could not be counted", {
      clinicId: context.clinicId,
      reason: context.reason,
      error: describeError(error),
    });
    return "failed";
  }
  if (live > 0) return "skipped_live";
  try {
    const revoked = await revokeGoogleToken(grant.refreshToken);
    if (revoked.ok) return revoked.value;
    log.warn("Google grant not revoked", {
      clinicId: context.clinicId,
      code: revoked.error.code,
      reason: revoked.error.reason ?? null,
    });
  } catch (error) {
    log.error("Google grant not revoked", {
      clinicId: context.clinicId,
      error: describeError(error),
    });
  }
  return "failed";
}

// -----------------------------------------------------------------------------
// Disconnecting (plan §4.12)
// -----------------------------------------------------------------------------

export type CalendarDisconnectReason =
  "operator" | "clinic" | "offboarding" | "terms_ended" | "election_changed";

export type DisconnectOutcome =
  | { status: "not_connected" }
  | {
      status: "disconnected";
      connectionId: string;
      releasedHolds: number;
      /** What happened at Google; `no_token` when the bag held nothing to revoke. */
      revokedAtGoogle: GrantRevocation | "no_token";
    };

/**
 * Take a location's Google Calendar away: in one tenant transaction, read
 * the token into memory (an audited decrypt, purpose `calendar_disconnect`),
 * erase it (sealed `{}` over it, the row revoked, `last_error` the reason),
 * release the location's holds and record the disconnect; after commit,
 * revoke the grant at Google unless another location holds the account
 * live. The booking mode, being derived, is manual from that moment.
 */
export async function disconnectGoogleCalendar(
  clinicId: string,
  input: { reason: CalendarDisconnectReason } & CalendarCallOptions,
): Promise<DisconnectOutcome> {
  const actor = input.actor ?? CALENDAR_ACTOR;
  const taken = await withTenant({ clinicId, actor, request: input.request }, async (tx) => {
    const row = await googleCalendarConnection(tx, { forUpdate: true });
    if (!row || row.status === "revoked") return null;
    const erased = await eraseGoogleCalendarWithin(tx, {
      connectionId: row.id,
      reason: input.reason,
      purpose: "calendar_disconnect",
    });
    if (!erased) return null;
    await recordDisconnect(tx, actor, input.request, erased, input.reason);
    return erased;
  });
  if (!taken) return { status: "not_connected" };
  const revokedAtGoogle = taken.grant
    ? await revokeGoogleGrantIfUnused(taken.grant, { clinicId, reason: input.reason })
    : "no_token";
  return {
    status: "disconnected",
    connectionId: taken.connectionId,
    releasedHolds: taken.releasedHolds,
    revokedAtGoogle,
  };
}

/**
 * The portal's Disconnect (the funnel's contract: `disconnect(clinicId)`):
 * the clinic's own, so the reason is `clinic`, and the actor is the portal
 * user the caller passes (an ActorContext only the caller can build).
 */
export function disconnect(
  clinicId: string,
  options: CalendarCallOptions = {},
): Promise<DisconnectOutcome> {
  return disconnectGoogleCalendar(clinicId, { reason: "clinic", ...options });
}

async function recordDisconnect(
  tx: TenantTx,
  actor: ActorContext,
  request: RequestContext | undefined,
  erased: ErasedGoogleCalendar,
  reason: CalendarDisconnectReason,
): Promise<void> {
  tx.audit.record({
    action: "update",
    resourceType: "provider_connection",
    resourceId: erased.connectionId,
    metadata: {
      provider: GOOGLE_CALENDAR_PROVIDER,
      disconnected: reason,
      releasedHolds: erased.releasedHolds,
    },
  });
  const [clinic] = await tx.db
    .select({ organizationId: clinics.organizationId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await recordSecurityEvent(tx.db, {
    event: "calendar_disconnected",
    actorLabel: actorLabelOf(actor),
    organizationId: clinic?.organizationId ?? null,
    ipAddress: request?.ipAddress ?? null,
    userAgent: request?.userAgent ?? null,
    metadata: { clinicId: tx.clinicId, connectionId: erased.connectionId, reason },
  });
}

// -----------------------------------------------------------------------------
// The end of the terms (plan §4.12, §9.2 step 2)
// -----------------------------------------------------------------------------

export type CalendarSweepResult = {
  checked: number;
  disconnected: number;
  failed: number;
  /**
   * The locations whose check threw, so nobody knows whether their terms
   * still cover a calendar. The watch leaves their tokens sealed (C10).
   */
  failedClinicIds: string[];
};

/**
 * Disconnect every Google Calendar connection whose location may no longer
 * have one: its terms are `none` (no agreement in effect: a terminated
 * agreement voids every location of its organisation), `needs_election` or
 * `not_used` (`terms_ended`); the account kind no longer matches the terms
 * (`election_changed`); or the location is offboarding or destroyed
 * (`offboarding`). Each disconnect is disconnectGoogleCalendar's, with no
 * request to Google before the erasure; the grant is revoked after commit
 * when unused.
 *
 * With `clinicIds`, those locations; without, every location the watch would
 * walk (app_calendar_connections). It runs after ops records a termination
 * (every location of the organisation), after offboarding starts, before
 * destruction, and on every watch run (C10). Never throws: one location's
 * failure is logged and counted, and the rest are still swept.
 */
export async function sweepCalendarTerms(
  clinicIds?: readonly string[],
  options: { actor?: ActorContext } = {},
): Promise<CalendarSweepResult> {
  const actor = options.actor ?? CALENDAR_ACTOR;
  const result: CalendarSweepResult = {
    checked: 0,
    disconnected: 0,
    failed: 0,
    failedClinicIds: [],
  };
  let targets: string[];
  try {
    targets = clinicIds ? [...new Set(clinicIds)] : await locationsWithLiveCalendars();
  } catch (error) {
    log.error("calendar terms sweep could not list its locations", { error: describeError(error) });
    return { ...result, failed: 1 };
  }
  for (const clinicId of targets) {
    try {
      const taken = await withTenant({ clinicId, actor }, async (tx) => {
        const row = await googleCalendarConnection(tx, { forUpdate: true });
        if (!row || row.status === "revoked") return null;
        const reason = await reasonTheTermsEnded(tx, row);
        if (!reason) return null;
        const erased = await eraseGoogleCalendarWithin(tx, {
          connectionId: row.id,
          reason,
          purpose: "calendar_terms_sweep",
        });
        if (!erased) return null;
        await recordDisconnect(tx, actor, undefined, erased, reason);
        return { erased, reason };
      });
      result.checked += 1;
      if (taken) {
        result.disconnected += 1;
        if (taken.erased.grant) {
          await revokeGoogleGrantIfUnused(taken.erased.grant, { clinicId, reason: taken.reason });
        }
      }
    } catch (error) {
      result.failed += 1;
      result.failedClinicIds.push(clinicId);
      log.error("calendar terms sweep failed for a location", {
        clinicId,
        error: describeError(error),
      });
    }
  }
  return result;
}

async function locationsWithLiveCalendars(): Promise<string[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; status: string }>(
    sql`select clinic_id, status from app_calendar_connections()`,
  );
  return [...new Set(result.rows.filter((r) => r.status !== "revoked").map((r) => r.clinic_id))];
}

async function reasonTheTermsEnded(
  tx: TenantTx,
  row: GoogleCalendarConnection,
): Promise<CalendarDisconnectReason | null> {
  const [clinic] = await tx.db
    .select({ leaving: clinics.offboardingStartedAt, destroyed: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || clinic.leaving || clinic.destroyed) return "offboarding";
  const terms = await calendarTermsFor(tx);
  if (terms.kind === "none" || terms.kind === "needs_election" || !terms.allowsWrite) {
    return "terms_ended";
  }
  // An unknown kind is not a match, as the election's own erasure reads it.
  if (row.managed !== (terms.account !== "personal")) return "election_changed";
  return null;
}

// -----------------------------------------------------------------------------
// Asking Google about one location, outside any transaction
// -----------------------------------------------------------------------------

type GoogleCall = {
  connection: GoogleCalendarConnection;
  /** Covered or uncovered: readForGoogleCall answers nothing else with a call. */
  terms: CalendarTermsInEffect;
  context: ConnectorContext;
};

/** Why a connection the location still holds may not be used for anything now. */
type CalendarUseRefusal = Extract<CalendarTargetRefusal, "terms" | "offboarding">;

type GoogleCallRead =
  | { status: "ok"; call: GoogleCall }
  | { status: "not_connected" }
  | { status: "unavailable" }
  | { status: "refused"; reason: CalendarUseRefusal };

/**
 * The location's live connection, its terms and the context the adapter
 * needs, read in one short tenant transaction with the token's decrypt
 * audited under `purpose`. Google is then asked outside it (plan §6: never
 * inside a transaction).
 *
 * The token is opened only for a location that may still use it: one that
 * has not left (clinicHasLeft) and whose terms let it use a calendar
 * (covered or uncovered, as writableConnection reads them). BAA 1.3.0's
 * calendar clause has healdesk stop using the token when the Services end,
 * and the terms sweep erases it then, but a location whose sweep failed
 * keeps its token sealed until the next watch run (C10), and the portal and
 * the calendar link page must not use it meanwhile. A refusal decrypts
 * nothing and asks Google nothing. The read takes no lock on the clinic:
 * Google is asked after this transaction commits, so a share lock would hold
 * up app_start_offboarding through the decrypt without closing that gap.
 */
async function readForGoogleCall(
  clinicId: string,
  purpose: string,
  options: CalendarCallOptions,
): Promise<GoogleCallRead> {
  const oauthClient = googleOAuthClient();
  return withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    async (tx): Promise<GoogleCallRead> => {
      const connection = await googleCalendarConnection(tx);
      if (!connection || connection.status === "revoked") return { status: "not_connected" };
      if (!oauthClient) return { status: "unavailable" };
      if (await clinicHasLeft(tx, { lock: false })) {
        return { status: "refused", reason: "offboarding" };
      }
      const terms = await calendarTermsFor(tx);
      if (terms.kind !== "covered" && terms.kind !== "uncovered") {
        return { status: "refused", reason: "terms" };
      }
      tx.audit.record({
        action: "decrypt",
        resourceType: "credential",
        resourceId: connection.id,
        metadata: { provider: GOOGLE_CALENDAR_PROVIDER, purpose },
      });
      const refreshToken = await withCredentials(
        tx.db,
        { clinicId, connectionId: connection.id },
        async (credentials) => credentials.refresh_token ?? "",
      );
      return {
        status: "ok",
        call: {
          connection,
          terms,
          context: {
            clinicId,
            connectionId: connection.id,
            credentials: { refresh_token: refreshToken },
            metadata: connection.metadata,
            oauthClient,
          },
        },
      };
    },
  );
}

/**
 * A definitive answer from Google, seen while asking it something for the
 * portal, breaks the connection there and then (whichever path sees it
 * first, plan §4.12), and a lost scope's grant is revoked when unused.
 * Anything else changes nothing.
 */
async function noteGoogleFailure(
  clinicId: string,
  call: GoogleCall,
  error: ConnectorError,
  options: CalendarCallOptions,
): Promise<void> {
  const code = calendarBreakOf(error);
  if (!code) return;
  try {
    const broken = await markCalendarBroken(clinicId, {
      code,
      connectionId: call.connection.id,
      credentialVersion: call.connection.credentialVersion,
      actor: options.actor,
      request: options.request,
    });
    if (broken.status === "broken" && broken.grant) {
      await revokeGoogleGrantIfUnused(broken.grant, { clinicId, reason: code });
    }
  } catch (failure) {
    log.error("calendar break not recorded", { clinicId, error: describeError(failure) });
  }
}

function failureReason(error: ConnectorError): string {
  return error.reason ?? error.code;
}

// -----------------------------------------------------------------------------
// HRC-04: a covered location stays in its own Workspace organisation
// -----------------------------------------------------------------------------

/** Why a calendar may not be booked into. */
export type CalendarTargetRefusal =
  /** The location's terms do not allow writing to a calendar at all. */
  | "terms"
  /** Covered terms need a Workspace account (the ID token's `hd`), and this is not one. */
  | "unmanaged_account"
  /** The account kind the connection holds is not the one the terms name. */
  | "account_mismatch"
  /** Covered terms: not a calendar of the connected account's own organisation. */
  | "outside_organisation"
  /** Not a calendar the connected account owns. */
  | "not_owned"
  /** Google could not be asked; refused rather than assumed (fail closed). */
  | "unverified"
  /**
   * The location has left (its offboarding has started, or its data is
   * destroyed): the Services have ended, and its connection is not used.
   */
  | "offboarding";

export type CalendarTargetCheck =
  | { allowed: true; ownOrganization: boolean }
  | {
      allowed: false;
      reason: CalendarTargetRefusal;
      /**
       * For `unverified`: what Google answered, so a writer can tell a grant
       * taken away (a break, which flips the location to manual booking)
       * from a miss worth trying again.
       */
      error?: ConnectorError;
    };

/**
 * May healdesk book into this calendar, for these terms, on this
 * connection? The check every chosen calendar passes when it is chosen (the
 * location's own, and every named provider's), and that the writers (C12's
 * desk write, C13's engine) call again before every insert. Fails closed.
 *
 *   - Only covered and uncovered terms write.
 *   - The connection's account kind must be the one the terms name: a
 *     Workspace account for the two Workspace kinds, a personal one for
 *     `personal`. For covered terms, that is the HRC-04 rule that the
 *     account belongs to a Workspace organisation at all (the ID token's
 *     `hd`, stored as metadata.managed at connect).
 *   - The primary calendar is the account's own, inside its own
 *     organisation by definition.
 *   - Any other calendar must be on the account's calendar list with
 *     Google's owner role, and for covered terms on the list asked with
 *     showOwnOrganizationOnly: a calendar another domain or a consumer
 *     shares in is refused. Asked of Google each time, so a calendar whose
 *     sharing changed since it was chosen is caught at the next write; if
 *     Google cannot be asked, the answer is no.
 *
 * `context` is the adapter context the caller already holds for the write
 * (credentials and healdesk's client); nothing here reads the database.
 */
export async function confirmCalendarTarget(input: {
  context: ConnectorContext;
  calendarId: string;
  account: CalendarAccount;
  writes: boolean;
  managed: boolean | null;
}): Promise<CalendarTargetCheck> {
  if (!input.writes) return { allowed: false, reason: "terms" };
  const covered = input.account === "workspace_baa";
  if (covered && input.managed !== true) return { allowed: false, reason: "unmanaged_account" };
  if (input.managed !== (input.account !== "personal")) {
    return { allowed: false, reason: "account_mismatch" };
  }
  if (input.calendarId === "primary") return { allowed: true, ownOrganization: covered };
  const listed = await googleCalendarAdapter.listCalendars(input.context, {
    ownOrganizationOnly: covered,
  });
  if (!listed.ok) return { allowed: false, reason: "unverified", error: listed.error };
  if (!listed.value.some((calendar) => calendar.id === input.calendarId)) {
    return { allowed: false, reason: covered ? "outside_organisation" : "not_owned" };
  }
  return { allowed: true, ownOrganization: covered };
}

// -----------------------------------------------------------------------------
// The portal's reads and choices (the funnel's contract of 6 October 2026)
// -----------------------------------------------------------------------------

export type CalendarConnectionView =
  | {
      status: "not_connected";
      /** When Google told us access was removed, if that is how it ended; null otherwise. */
      accessRemovedAt: Date | null;
    }
  | {
      status: "active" | "degraded" | "error" | "pending";
      account: {
        /** For the clinic's own portal only: never an ops projection, an audit row or a log. */
        email: string | null;
        kind: "workspace" | "personal" | null;
        domain: string | null;
      };
      /** The calendar booked into: Google's id, or `primary`. Its name is listCalendars'. */
      calendar: { id: string; primary: boolean };
      connectedAt: string | null;
      lastVerifiedAt: Date | null;
      /** Since when it has been broken (the row is in `error`); null when healthy. */
      brokenAt: Date | null;
      lastError: string | null;
      /** The data-use notice the connection was accepted under is still a compatible version. */
      disclosureCurrent: boolean;
    };

/**
 * The location's connection, as its own portal shows it (Settings →
 * Calendar, setup step 3): the status, the account and its kind, the
 * calendar booked into, when it was last checked and since when it has been
 * broken. No decrypt.
 */
export async function getCalendarConnection(
  clinicId: string,
  options: CalendarCallOptions = {},
): Promise<CalendarConnectionView> {
  return withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    async (tx) => {
      const row = await googleCalendarConnection(tx);
      if (!row || row.status === "revoked") {
        return { status: "not_connected", accessRemovedAt: row?.brokenAt ?? null };
      }
      const [timing] = await tx.db
        .select({ lastVerifiedAt: providerConnections.lastVerifiedAt })
        .from(providerConnections)
        .where(eq(providerConnections.id, row.id))
        .limit(1);
      const m = row.metadata;
      return {
        status: row.status,
        account: {
          email: typeof m.accountEmail === "string" ? m.accountEmail : null,
          kind: row.managed === null ? null : row.managed ? "workspace" : "personal",
          domain: row.hostedDomain,
        },
        calendar: { id: row.calendarId, primary: row.calendarId === "primary" },
        connectedAt: typeof m.connectedAt === "string" ? m.connectedAt : null,
        lastVerifiedAt: timing?.lastVerifiedAt ?? null,
        brokenAt: row.brokenAt,
        lastError: row.lastError,
        disclosureCurrent:
          typeof m.disclosureVersion === "string" &&
          GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE.includes(m.disclosureVersion),
      };
    },
  );
}

/** One calendar a location may book into, as its portal's picker shows it. */
export type CalendarOption = {
  /** Google's id; for the primary calendar, choose it as `primary`. */
  id: string;
  /** The name its owner gave it: the clinic's own words, shown to it and never audited or logged. */
  name: string | null;
  primary: boolean;
  timeZone: string | null;
  /** The calendar the location books into now. */
  current: boolean;
};

export type ListCalendarsOutcome =
  | {
      status: "ok";
      calendars: CalendarOption[];
      /** Covered terms: only the account's own organisation's calendars were asked for (HRC-04). */
      ownOrganizationOnly: boolean;
    }
  | { status: "not_connected" }
  | { status: "unavailable" }
  /** The location has left, or its terms use no calendar: nothing was asked of Google. */
  | { status: "refused"; reason: CalendarUseRefusal }
  | { status: "failed"; reason: string };

/**
 * The calendars the location's connected account may book into, primary
 * first: those on which it has Google's owner role, hidden ones left out,
 * and under covered terms only those of its own organisation (HRC-04).
 * A definitive answer from Google breaks the connection as any other path
 * would. Refused, with no decrypt, once the location has left or while its
 * terms use no calendar (readForGoogleCall).
 */
export async function listCalendars(
  clinicId: string,
  options: CalendarCallOptions = {},
): Promise<ListCalendarsOutcome> {
  const read = await readForGoogleCall(clinicId, "calendar_list", options);
  if (read.status !== "ok") return read;
  const { call } = read;
  const owned = await choosableCalendars(clinicId, call, options);
  if (owned.status !== "ok") return owned;
  return {
    status: "ok",
    ownOrganizationOnly: owned.ownOrganizationOnly,
    calendars: owned.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.summary,
      primary: calendar.primary,
      timeZone: calendar.timeZone,
      current:
        call.connection.calendarId === "primary"
          ? calendar.primary
          : calendar.id === call.connection.calendarId,
    })),
  };
}

async function choosableCalendars(
  clinicId: string,
  call: GoogleCall,
  options: CalendarCallOptions,
): Promise<
  | { status: "ok"; calendars: OwnedGoogleCalendar[]; ownOrganizationOnly: boolean }
  | { status: "failed"; reason: string }
> {
  const covered = call.terms.kind === "covered";
  if (covered && call.connection.managed !== true) {
    return { status: "failed", reason: "unmanaged_account" };
  }
  const listed = await googleCalendarAdapter.listCalendars(call.context, {
    ownOrganizationOnly: covered,
  });
  if (!listed.ok) {
    await noteGoogleFailure(clinicId, call, listed.error, options);
    return { status: "failed", reason: failureReason(listed.error) };
  }
  return { status: "ok", calendars: listed.value, ownOrganizationOnly: covered };
}

/** A calendar id as Google writes one and clinic_providers' CHECK takes it. */
const CALENDAR_ID = /^[^\s\p{Cc}]{1,255}$/u;

export type ChooseCalendarOutcome =
  | { status: "chosen"; primary: boolean; changed: boolean }
  | { status: "not_connected" }
  | { status: "unavailable" }
  | { status: "refused"; reason: CalendarTargetRefusal }
  | { status: "failed"; reason: string };

/**
 * Choose the calendar the location books into (addendum, "Calendar-list
 * scope"): one the account may book into by the same rule listCalendars
 * shows (owner role; under covered terms, its own organisation's, HRC-04),
 * checked again with the connect-time verify() against that calendar
 * (free/busy, and the owner role on it), then stored as metadata.calendarId
 * (`primary` for the primary calendar). A change releases the location's
 * holds, which were held against the old calendar, and is audited as
 * `calendar_target_changed`, with no calendar name or id.
 */
export async function chooseCalendar(
  clinicId: string,
  calendarId: string,
  options: CalendarCallOptions = {},
): Promise<ChooseCalendarOutcome> {
  if (typeof calendarId !== "string" || !CALENDAR_ID.test(calendarId)) {
    return { status: "refused", reason: "not_owned" };
  }
  const read = await readForGoogleCall(clinicId, "calendar_choose", options);
  if (read.status !== "ok") return read;
  const { call } = read;
  const owned = await choosableCalendars(clinicId, call, options);
  if (owned.status !== "ok") {
    return owned.reason === "unmanaged_account"
      ? { status: "refused", reason: "unmanaged_account" }
      : owned;
  }
  const entry =
    calendarId === "primary"
      ? owned.calendars.find((calendar) => calendar.primary)
      : owned.calendars.find((calendar) => calendar.id === calendarId);
  if (!entry) {
    return {
      status: "refused",
      reason: owned.ownOrganizationOnly ? "outside_organisation" : "not_owned",
    };
  }
  const chosen = entry.primary ? "primary" : entry.id;
  const verified = await googleCalendarAdapter.verify({
    ...call.context,
    metadata: { ...call.context.metadata, calendarId: chosen },
  });
  if (!verified.ok) {
    await noteGoogleFailure(clinicId, call, verified.error, options);
    return { status: "failed", reason: failureReason(verified.error) };
  }

  return withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    async (tx) => {
      const row = await googleCalendarConnection(tx, { forUpdate: true });
      if (
        !row ||
        row.status === "revoked" ||
        row.id !== call.connection.id ||
        row.credentialVersion !== call.connection.credentialVersion
      ) {
        // Reconnected or disconnected while Google was asked: nothing to choose for.
        return { status: "failed", reason: "connection_changed" } as const;
      }
      const changed = row.calendarId !== chosen;
      const now = new Date();
      // A connection broken on its calendar (refused, forbidden or gone:
      // status `error`, the token kept) is whole again once a calendar it
      // may use has just passed verify() with a fresh token.
      const recovered = row.status === "error";
      await tx.db
        .update(providerConnections)
        .set({
          metadata: {
            ...row.metadata,
            calendarId: chosen,
            calendarTimeZone: verified.value.calendar?.timeZone ?? null,
            accessRole: verified.value.calendar?.accessRole ?? null,
            calendarCheckedAt: now.toISOString(),
            calendarScope: owned.ownOrganizationOnly ? "own_organization" : "owned",
          },
          ...(recovered
            ? {
                status: "active" as const,
                lastVerifiedAt: now,
                lastError: null,
                brokenAt: null,
                brokenAlertedAt: null,
                transientFailures: 0,
              }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(providerConnections.id, row.id), eq(providerConnections.clinicId, clinicId)));
      if (recovered) {
        await notifyCalendarState(tx.db, clinicId, "reconnected", {
          dedupeKey: `calendar-reconnected:${row.id}:${now.getTime()}`,
        });
      }
      const releasedHolds = changed ? await releaseLiveHolds(tx, "calendar_changed") : 0;
      tx.audit.record({
        action: "update",
        resourceType: "provider_connection",
        resourceId: row.id,
        metadata: {
          event: "calendar_target_changed",
          primary: chosen === "primary",
          changed,
          recovered,
          ownOrganization: owned.ownOrganizationOnly,
          releasedHolds,
        },
      });
      return { status: "chosen", primary: chosen === "primary", changed } as const;
    },
  );
}

// -----------------------------------------------------------------------------
// Named providers (the spec's provider-specific booking; addendum of 6 October)
// -----------------------------------------------------------------------------

export type ProviderView = {
  id: string;
  displayName: string;
  /** Google's id, or `primary`. */
  calendarId: string;
  /** The services they offer, as service keys (the clinic's own names, lower-cased). */
  services: string[];
  /**
   * Whether their calendar is one the connected account may book into now
   * (on listCalendars' list). False asks the clinic to choose again, as for
   * a calendar that was deleted or stopped being shared; null when the list
   * could not be read.
   */
  calendarAvailable: boolean | null;
};

export type ListProviderCalendarsOutcome =
  | {
      status: "ok";
      providers: ProviderView[];
      /** What a provider's calendar may be: listCalendars' list, by its rule. */
      calendars: CalendarOption[];
      ownOrganizationOnly: boolean;
    }
  | { status: "not_connected"; providers: ProviderView[] }
  | { status: "unavailable"; providers: ProviderView[] }
  | { status: "refused"; reason: CalendarUseRefusal; providers: ProviderView[] }
  | { status: "failed"; reason: string; providers: ProviderView[] };

/**
 * The location's active named providers, each with the calendar their
 * availability lives in and the services they offer, and the calendars a
 * provider may be given: setup step 3.2 and Settings → Calendar.
 */
export async function listProviderCalendars(
  clinicId: string,
  options: CalendarCallOptions = {},
): Promise<ListProviderCalendarsOutcome> {
  const providers = await withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    (tx) => activeProviders(tx),
  );
  const calendars = await listCalendars(clinicId, options);
  if (calendars.status !== "ok") return { ...calendars, providers };
  const listed = new Set(
    calendars.calendars.map((calendar) => (calendar.primary ? "primary" : calendar.id)),
  );
  return {
    status: "ok",
    providers: providers.map((provider) => ({
      ...provider,
      calendarAvailable: listed.has(provider.calendarId),
    })),
    calendars: calendars.calendars,
    ownOrganizationOnly: calendars.ownOrganizationOnly,
  };
}

async function activeProviders(tx: TenantTx): Promise<ProviderView[]> {
  const rows = await tx.db
    .select({
      id: clinicProviders.id,
      displayName: clinicProviders.displayName,
      calendarId: clinicProviders.calendarId,
    })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)))
    // Providers saved together share created_at: by name among them, so the
    // portal lists them the same way every time.
    .orderBy(clinicProviders.createdAt, clinicProviders.displayName, clinicProviders.id);
  if (rows.length === 0) return [];
  const mapped = await tx.db
    .select({
      providerId: clinicProviderServices.providerId,
      serviceKey: clinicProviderServices.serviceKey,
    })
    .from(clinicProviderServices)
    .where(
      and(
        eq(clinicProviderServices.clinicId, tx.clinicId),
        inArray(
          clinicProviderServices.providerId,
          rows.map((row) => row.id),
        ),
      ),
    );
  return rows.map((row) => ({
    ...row,
    services: mapped
      .filter((m) => m.providerId === row.id)
      .map((m) => m.serviceKey)
      .sort(),
    calendarAvailable: null,
  }));
}

/**
 * The location now books through another Google account than the one its
 * named providers' calendars were checked against (the sign-in after a
 * change of account, or after a disconnect): every provider whose calendar
 * is one of the old account's secondary calendars is deactivated, in the
 * caller's transaction, since that id means nothing on the new account and
 * must never be written to. `primary` stays: it is the connected account's
 * own main calendar, whichever account that is. Answers how many were
 * deactivated; the clinic chooses their calendars again (saveProviders).
 */
export async function retireOtherAccountProviders(
  tx: TenantTx,
  origin: ChangeOrigin = { source: "portal", actor: "clinic_signin" },
): Promise<number> {
  const retired = await tx.db
    .update(clinicProviders)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(clinicProviders.clinicId, tx.clinicId),
        eq(clinicProviders.active, true),
        ne(clinicProviders.calendarId, "primary"),
      ),
    )
    .returning({ id: clinicProviders.id });
  // A roster change like any other, for ops (lib/clinic/change-events.ts):
  // made by the clinic's own reconnect, counted, never named.
  if (retired.length > 0) {
    const [left] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicProviders)
      .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)));
    await recordClinicChange(tx, {
      kind: "providers",
      ...origin,
      summary: { providersActive: Number(left?.n ?? 0) },
    });
  }
  return retired.length;
}

export type ProviderInput = {
  /** An existing provider's id, to keep it; absent for a new one. */
  id?: string | null;
  displayName: string;
  /** One of listProviderCalendars' calendars: Google's id, or `primary`. */
  calendarId: string;
};

export type SaveProvidersOutcome =
  | { status: "saved"; providers: { id: string; displayName: string; calendarId: string }[] }
  | {
      status: "refused";
      reason:
        | CalendarTargetRefusal
        | "invalid_name"
        | "invalid_calendar"
        | "duplicate_calendar"
        | "unknown_provider"
        | "too_many";
      /** The provider in the input the refusal is about, by position; null for the whole list. */
      index: number | null;
    }
  | { status: "not_connected" }
  | { status: "unavailable" }
  | { status: "failed"; reason: string };

/** More named providers than this at one location is not a booking setup but a typo. */
export const MAX_PROVIDERS = 50;
const DISPLAY_NAME = /^[^\p{Cc}]{1,80}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Save the location's named providers: the whole list, each with a display
 * name and one calendar of their own. Every calendar is checked against the
 * connected account as the location's own calendar is, by one calendar-list
 * request: Google's owner role, and under covered terms the account's own
 * organisation (HRC-04); and no two providers share one. The list is written
 * only while that connection, the same token, is still the location's
 * (`connection_changed` otherwise). Providers left out are deactivated, not
 * deleted, so a hold or a booking that names one keeps its row; their
 * service mappings stay with them.
 *
 * A calendar that leaves use here (no provider in the list has it, and it
 * is not the location's own) has its live holds let go in the same
 * transaction (`provider_removed`, releaseLiveHolds), so a hold placed on a
 * removed provider's calendar is never claimed and written there; a write
 * already in flight there has its request's calendar_check alert, and the
 * writer, finding its lease gone, records nothing. The writer also refuses
 * a hold whose calendar is no longer in use (writer.ts, prepareWrite).
 * Audited with counts only: no name, no calendar.
 */
export async function saveProviders(
  clinicId: string,
  providers: readonly ProviderInput[],
  options: CalendarCallOptions & { origin?: ChangeOrigin } = {},
): Promise<SaveProvidersOutcome> {
  if (!Array.isArray(providers) || providers.length > MAX_PROVIDERS) {
    return { status: "refused", reason: "too_many", index: null };
  }
  const wanted: { id: string | null; displayName: string; calendarId: string }[] = [];
  for (const [index, provider] of providers.entries()) {
    const displayName =
      typeof provider?.displayName === "string" ? provider.displayName.trim() : "";
    if (!DISPLAY_NAME.test(displayName))
      return { status: "refused", reason: "invalid_name", index };
    if (typeof provider.calendarId !== "string" || !CALENDAR_ID.test(provider.calendarId)) {
      return { status: "refused", reason: "invalid_calendar", index };
    }
    const id = provider.id ?? null;
    if (id !== null && (typeof id !== "string" || !UUID.test(id))) {
      return { status: "refused", reason: "unknown_provider", index };
    }
    wanted.push({ id, displayName, calendarId: provider.calendarId });
  }

  // The connection every calendar was checked against, which must still be
  // the location's when the list is written.
  let checkedOn: Pick<GoogleCalendarConnection, "id" | "credentialVersion"> | null = null;
  if (wanted.length > 0) {
    const read = await readForGoogleCall(clinicId, "calendar_providers", options);
    if (read.status === "refused") return { ...read, index: null };
    if (read.status !== "ok") return read;
    const { call } = read;
    checkedOn = call.connection;
    const owned = await choosableCalendars(clinicId, call, options);
    if (owned.status !== "ok") {
      return owned.reason === "unmanaged_account"
        ? { status: "refused", reason: "unmanaged_account", index: null }
        : owned;
    }
    const seen = new Set<string>();
    for (const [index, provider] of wanted.entries()) {
      const entry =
        provider.calendarId === "primary"
          ? owned.calendars.find((calendar) => calendar.primary)
          : owned.calendars.find((calendar) => calendar.id === provider.calendarId);
      if (!entry) {
        return {
          status: "refused",
          reason: owned.ownOrganizationOnly ? "outside_organisation" : "not_owned",
          index,
        };
      }
      provider.calendarId = entry.primary ? "primary" : entry.id;
      if (seen.has(provider.calendarId)) {
        return { status: "refused", reason: "duplicate_calendar", index };
      }
      seen.add(provider.calendarId);
    }
  }

  return withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    async (tx) => {
      const row = await googleCalendarConnection(tx, { forUpdate: true });
      if (
        checkedOn &&
        (!row ||
          row.status === "revoked" ||
          row.id !== checkedOn.id ||
          row.credentialVersion !== checkedOn.credentialVersion)
      ) {
        // Reconnected, or another account connected, while Google was
        // asked: the calendars were checked against a token the location no
        // longer holds, so nothing is written (as chooseCalendar).
        return { status: "failed", reason: "connection_changed" } as const;
      }
      const existing = await tx.db
        .select({ id: clinicProviders.id })
        .from(clinicProviders)
        .where(eq(clinicProviders.clinicId, tx.clinicId));
      const known = new Set(existing.map((row) => row.id));
      for (const [index, provider] of wanted.entries()) {
        if (provider.id !== null && !known.has(provider.id)) {
          return { status: "refused", reason: "unknown_provider", index } as const;
        }
      }
      // Everyone off first, so two providers swapping calendars never meet
      // the one-active-provider-per-calendar index halfway.
      const now = new Date();
      const activeBefore = await tx.db
        .select({
          id: clinicProviders.id,
          displayName: clinicProviders.displayName,
          calendarId: clinicProviders.calendarId,
        })
        .from(clinicProviders)
        .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)));
      const before = await tx.db
        .update(clinicProviders)
        .set({ active: false, updatedAt: now })
        .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)))
        .returning({ calendarId: clinicProviders.calendarId });
      const saved: { id: string; displayName: string; calendarId: string }[] = [];
      for (const provider of wanted) {
        if (provider.id !== null) {
          await tx.db
            .update(clinicProviders)
            .set({
              displayName: provider.displayName,
              calendarId: provider.calendarId,
              active: true,
              updatedAt: now,
            })
            .where(
              and(eq(clinicProviders.id, provider.id), eq(clinicProviders.clinicId, tx.clinicId)),
            );
          saved.push({ ...provider, id: provider.id });
        } else {
          const [created] = await tx.db
            .insert(clinicProviders)
            .values({
              clinicId: tx.clinicId,
              displayName: provider.displayName,
              calendarId: provider.calendarId,
            })
            .returning({ id: clinicProviders.id });
          saved.push({ ...provider, id: created!.id });
        }
      }
      // A calendar no saved provider has, and not the location's own, is out
      // of use from this commit: what is held on it is let go, as a change of
      // the location's own calendar lets go of its holds (chooseCalendar).
      const inUse = new Set(saved.map((provider) => provider.calendarId));
      if (row && row.status !== "revoked") inUse.add(row.calendarId);
      const removed = [...new Set(before.map((provider) => provider.calendarId))].filter(
        (calendarId) => !inUse.has(calendarId),
      );
      const releasedHolds = await releaseLiveHolds(tx, "provider_removed", {
        calendarIds: removed,
      });
      tx.audit.record({
        action: "update",
        resourceType: "clinic_providers",
        resourceId: tx.clinicId,
        metadata: { event: "clinic_providers_saved", count: saved.length, releasedHolds },
      });
      // For ops (lib/clinic/change-events.ts): counts only, never a name or
      // a calendar, and only when the active list is not what it was.
      const roster = (list: readonly { id: string; displayName: string; calendarId: string }[]) =>
        JSON.stringify(list.map((p) => [p.id, p.displayName, p.calendarId]).sort());
      if (roster(activeBefore) !== roster(saved)) {
        await recordClinicChange(
          tx,
          {
            kind: "providers",
            ...(options.origin ?? changeOriginOf(options.actor)),
            summary: { providersActive: saved.length, holdsReleased: releasedHolds },
          },
          now,
        );
      }
      return { status: "saved", providers: saved } as const;
    },
  );
}

export type SetProviderServicesOutcome =
  | { status: "saved"; services: string[] }
  | { status: "refused"; reason: "unknown_provider" | "unknown_service" | "too_many" };

/** The case-insensitive key a service is matched by: the clinic's own name, trimmed and lower-cased. */
export function serviceKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The services one active named provider offers: the spec's
 * service-to-provider mapping, as keys of the clinic's own service list
 * (agent_configs.services[].name). Replaces the provider's whole mapping;
 * a name the clinic's list does not hold is refused, so a mapping can
 * never name a service the assistant would not offer. Audited with the
 * provider's id and a count.
 */
export async function setProviderServices(
  clinicId: string,
  providerId: string,
  services: readonly string[],
  options: CalendarCallOptions & { origin?: ChangeOrigin } = {},
): Promise<SetProviderServicesOutcome> {
  if (typeof providerId !== "string" || !UUID.test(providerId)) {
    return { status: "refused", reason: "unknown_provider" };
  }
  if (!Array.isArray(services) || services.length > 200) {
    return { status: "refused", reason: "too_many" };
  }
  const keys = [
    ...new Set(services.map((name) => (typeof name === "string" ? serviceKeyOf(name) : ""))),
  ];
  return withTenant(
    { clinicId, actor: options.actor ?? CALENDAR_ACTOR, request: options.request },
    async (tx) => {
      const [provider] = await tx.db
        .select({ id: clinicProviders.id })
        .from(clinicProviders)
        .where(
          and(
            eq(clinicProviders.id, providerId),
            eq(clinicProviders.clinicId, tx.clinicId),
            eq(clinicProviders.active, true),
          ),
        )
        .limit(1);
      if (!provider) return { status: "refused", reason: "unknown_provider" } as const;
      const [config] = await tx.db
        .select({ services: agentConfigs.services })
        .from(agentConfigs)
        .where(eq(agentConfigs.clinicId, tx.clinicId))
        .limit(1);
      const offered = new Set(
        (config?.services ?? []).map((service) => serviceKeyOf(service.name)),
      );
      if (keys.some((key) => key.length === 0 || !offered.has(key))) {
        return { status: "refused", reason: "unknown_service" } as const;
      }
      const mappedBefore = await tx.db
        .select({ serviceKey: clinicProviderServices.serviceKey })
        .from(clinicProviderServices)
        .where(
          and(
            eq(clinicProviderServices.providerId, providerId),
            eq(clinicProviderServices.clinicId, tx.clinicId),
          ),
        );
      await tx.db
        .delete(clinicProviderServices)
        .where(
          and(
            eq(clinicProviderServices.providerId, providerId),
            eq(clinicProviderServices.clinicId, tx.clinicId),
          ),
        );
      if (keys.length > 0) {
        await tx.db
          .insert(clinicProviderServices)
          .values(keys.map((serviceKey) => ({ clinicId: tx.clinicId, providerId, serviceKey })));
      }
      tx.audit.record({
        action: "update",
        resourceType: "clinic_provider_services",
        resourceId: providerId,
        metadata: { event: "clinic_provider_services_set", count: keys.length },
      });
      // For ops: how many services this provider now offers, only when that changed.
      if (
        JSON.stringify(mappedBefore.map((m) => m.serviceKey).sort()) !== JSON.stringify([...keys].sort())
      ) {
        await recordClinicChange(tx, {
          kind: "provider_services",
          ...(options.origin ?? changeOriginOf(options.actor)),
          summary: { servicesMapped: keys.length },
        });
      }
      return { status: "saved", services: keys.sort() } as const;
    },
  );
}
