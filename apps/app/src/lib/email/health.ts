import { and, gte, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { emailEvents, type EmailEventStatus } from "@/db/schema";
import { describeError, log } from "@/lib/log";

import { DIRECT_KIND_REGISTRY } from "./direct-kinds";
import { isDirectKind, KIND_SHAPE } from "./kind-rules";

/**
 * Email health beyond the ledgers, for the 07:00 ops digest (I2; Annex X5
 * "email health per kind", X8's bounce and complaint targets).
 *
 * report_deliveries holds every send about a clinic, and the ops log holds
 * I1's (and I4's). Everything else was counted nowhere: the direct kinds with
 * no ledger row, whose sends left no trace and whose bounces the webhook relay
 * only logged, and the whole of apps/web's mail, which apps/app never sends.
 * Resend pauses the account, not one app, at a 0.08% complaint rate, so a
 * digest that saw only the ledgers could read green while the account was
 * near a pause.
 *
 * email_events (0097) keeps a kind, a status and a time for each of them, and
 * nothing else: no address, no clinic.
 *
 *   - sendEmail records each send of a kind `countsAtSend` names, sent or
 *     failed, as the transport answered it;
 *   - the webhook relay records each bounce, complaint or suppression Resend
 *     reports for one of those kinds;
 *   - apps/web's webhook relays the events Resend reports for its own mail
 *     (sent, bounced, complained, suppressed), each recorded once by its
 *     webhook id. What stays invisible: an apps/web send Resend refused, which
 *     raises no event, and any event that arrived while apps/app could not be
 *     reached. The digest says so.
 */

/** Kinds whose sends the ops log already counts for the digest: I1 and I4. */
const COUNTED_IN_THE_OPS_LOG: ReadonlySet<string> = new Set(["ops_alert", "flag_alert"]);

/** A direct kind with no ledger row and no ops-log row: its sends are counted here. */
export function countsAtSend(kind: string): boolean {
  return (
    isDirectKind(kind) && !DIRECT_KIND_REGISTRY[kind].ledger && !COUNTED_IN_THE_OPS_LOG.has(kind)
  );
}

export type EmailEvent = {
  app: "app" | "web";
  kind: string;
  status: EmailEventStatus;
  at: Date;
  /** The webhook delivery's id, for a relayed event: a redelivery counts once. */
  eventId?: string | null;
};

const EVENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Record one. Never throws: a send that went must not be reported as failed
 * because its bookkeeping did. True when a row was written (false for a
 * redelivered event, or a row the database refused).
 */
export async function recordEmailEvent(event: EmailEvent): Promise<boolean> {
  if (!KIND_SHAPE.test(event.kind)) return false;
  const eventId = event.eventId && EVENT_ID.test(event.eventId) ? event.eventId : null;
  try {
    const rows = await unsafeDb
      .insert(emailEvents)
      .values({ app: event.app, kind: event.kind, status: event.status, at: event.at, eventId })
      .onConflictDoNothing()
      .returning({ id: emailEvents.id });
    return rows.length > 0;
  } catch (error) {
    log.warn("email event not recorded", { kind: event.kind, error: describeError(error) });
    return false;
  }
}

export type EmailEventCounts = {
  app: "app" | "web";
  kind: string;
  sentCount: number;
  failedCount: number;
  bouncedCount: number;
  complainedCount: number;
  suppressedCount: number;
};

/** The counts since `since`, by app and kind. For the digest; throws when the database does. */
export async function emailEventCounts(since: Date): Promise<EmailEventCounts[]> {
  const n = (status: EmailEventStatus) =>
    sql<number>`count(*) filter (where ${emailEvents.status} = ${status})`;
  const rows = await unsafeDb
    .select({
      app: emailEvents.app,
      kind: emailEvents.kind,
      sentCount: n("sent"),
      failedCount: n("failed"),
      bouncedCount: n("bounced"),
      complainedCount: n("complained"),
      suppressedCount: n("suppressed"),
    })
    .from(emailEvents)
    .where(gte(emailEvents.at, since))
    .groupBy(emailEvents.app, emailEvents.kind);
  return rows.map((row) => ({
    app: row.app === "web" ? "web" : "app",
    kind: row.kind,
    sentCount: Number(row.sentCount),
    failedCount: Number(row.failedCount),
    bouncedCount: Number(row.bouncedCount),
    complainedCount: Number(row.complainedCount),
    suppressedCount: Number(row.suppressedCount),
  }));
}

/** How long a row is kept: the digest reads one day, and nothing reads the rest. */
export const EMAIL_EVENT_RETENTION_DAYS = 30;

/** Delete what is past the retention. Never throws. */
export async function pruneEmailEvents(now: Date): Promise<void> {
  const before = new Date(now.getTime() - EMAIL_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await unsafeDb.delete(emailEvents).where(and(lt(emailEvents.at, before)));
  } catch (error) {
    log.warn("email events not pruned", { error: describeError(error) });
  }
}
