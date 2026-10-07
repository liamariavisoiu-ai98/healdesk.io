import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { clinics, providerConnections } from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { releaseLiveHolds } from "@/lib/booking/holds";
import { eraseCredentials, withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { notifyCalendarState } from "@/lib/notices/calendar-state";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * A location's Google Calendar connection: one `google_calendar` row in
 * provider_connections, holding the sealed refresh token and nothing else
 * secret (plan §4.8), with the breakage stamps the calendar watch reads
 * (drizzle/0057). Connecting, choosing a calendar and disconnecting arrive
 * with the connect flow (C8); this is what every path needs before then:
 * what counts as broken, and what happens when it is.
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
  const managed = (row.metadata as { managed?: unknown } | null)?.managed;
  return {
    id: row.id,
    status: row.status,
    accountRef: row.accountRef,
    credentialVersion: row.iv,
    managed: typeof managed === "boolean" ? managed : null,
    lastError: row.lastError,
    brokenAt: row.brokenAt,
    brokenAlertedAt: row.brokenAlertedAt,
  };
}

/**
 * A Google grant taken away in this transaction, for revoking at Google once
 * the transaction has committed (plan §2.6, §4.12, §4.13:
 * revokeGoogleGrantIfUnused, which arrives with the connect flow, C8).
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

export type ErasedGoogleCalendar = {
  connectionId: string;
  accountRef: string | null;
  releasedHolds: number;
  /** The grant to revoke at Google after commit; null when the bag held no token we could read. */
  grant: GoogleGrant | null;
};

/**
 * The transactional half of taking a location's Google Calendar away (plan
 * §4.12): read the token into memory (an audited decrypt, `purpose` naming
 * why, the reason by default), erase it (re-sealed as `{}`, the row revoked,
 * `last_error` the reason) and release the location's holds, all in the
 * caller's transaction. Null when there is no connection left to erase.
 *
 * After the caller commits, it revokes `grant` at Google through
 * revokeGoogleGrantIfUnused (C8), which does so only when no other location
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
 * in a transaction of its own (the watch, C10) raises `calendar_broken`
 * itself once that transaction has committed, when `firstBreak` is true, and
 * revokes `grant` then too.
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

  const [claimed] = await tx.db
    .update(providerConnections)
    .set({ brokenAlertedAt: sql`now()` })
    .where(
      and(
        where,
        isNotNull(providerConnections.brokenAt),
        isNull(providerConnections.brokenAlertedAt),
      ),
    )
    .returning({ brokenAt: providerConnections.brokenAt });
  const firstBreak = claimed !== undefined;
  if (claimed?.brokenAt) {
    // One key per episode: a reconnect clears broken_at (C8), and the next
    // breakage is a new episode with a new key.
    await notifyCalendarState(tx.db, tx.clinicId, "stopped", {
      dedupeKey: `calendar-stopped:${row.id}:${claimed.brokenAt.getTime()}`,
    });
    const [clinic] = await tx.db
      .select({ organizationId: clinics.organizationId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    await recordSecurityEvent(tx.db, {
      event: "calendar_broken",
      actorLabel: input.actorLabel ?? "google-calendar",
      organizationId: clinic?.organizationId ?? null,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent ?? null,
      metadata: { clinicId: tx.clinicId, connectionId: row.id, code: input.code },
    });
  }

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
 * committed, until revokeGoogleGrantIfUnused exists (C8) and this does it
 * itself.
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
