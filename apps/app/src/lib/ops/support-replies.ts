import { and, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { billingNotices, securityEvents } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { replyByPassed } from "@/lib/reply-by";
import { withTenant } from "@/lib/tenant";

/**
 * The support chat's dated promises (WP10's L25; WP5's
 * `support_reply_past_due`), and the operator's mark that one was kept.
 *
 * An escalation from the portal's support chat emails hello@ (I3) and queues
 * L25 to the clinic, "a person will reply by {day}", as an outbox row
 * (`billing_notices`, kind `support_request`, dedupe `support_request:<id>`)
 * holding the request's id, its topic and that day. Nothing records that
 * hello@ replied, because the reply is an ordinary email from our inbox.
 *
 * So the operator marks it: the ops operation markSupportReplied writes one
 * security event, `support_request_replied`, with the clinic's and the
 * request's ids, through the ops API's own audit (who, from where, when).
 * That is the whole mark. It needs no new state on this host: security_events
 * is the operator's append-only trail already, has no tenant and no patient
 * in it, and a mark cannot be taken back, which is what a reply is. The chat
 * itself still stores nothing (spec, "Support chat in the portal").
 *
 * The ops watch raises `support_reply_past_due` once per request whose day
 * has passed in New York without a mark (lib/ops/watch.ts), and the 07:00
 * digest counts the ones still owed.
 */

/** The security event that marks a request replied to. */
export const SUPPORT_REPLIED_EVENT = "support_request_replied";

/** How far back the watch, the digest and the console look. L25 promises the next business day. */
export const SUPPORT_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTOR = { type: "service", serviceName: "ops-watch" } as const;

export type SupportRequestRow = {
  clinicId: string;
  requestId: string;
  topic: string;
  /** The day L25 promised a reply by (ISO date, New York's business day). */
  replyByOn: string;
  /** When the escalation was queued. */
  askedAt: Date;
  /** When an operator marked it replied, or null. */
  repliedAt: Date | null;
  /** The day has passed and no reply is marked. */
  pastDue: boolean;
};

/** Every reply mark since `since`, keyed `clinicId:requestId`, with when it was made. */
export async function supportReplyMarks(since: Date): Promise<Map<string, Date>> {
  const rows = await unsafeDb
    .select({ metadata: securityEvents.metadata, at: securityEvents.occurredAt })
    .from(securityEvents)
    .where(
      and(eq(securityEvents.event, SUPPORT_REPLIED_EVENT), gt(securityEvents.occurredAt, since)),
    );
  const marks = new Map<string, Date>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as { clinicId?: unknown; requestId?: unknown };
    if (typeof meta.clinicId !== "string" || typeof meta.requestId !== "string") continue;
    const key = markKey(meta.clinicId, meta.requestId);
    const seen = marks.get(key);
    if (!seen || row.at < seen) marks.set(key, row.at);
  }
  return marks;
}

function markKey(clinicId: string, requestId: string): string {
  return `${clinicId}:${requestId}`;
}

/** The clinics that have not left: the only ones whose promises can still be kept. */
async function clinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where destroyed_at is null`,
  );
  return ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) => String(r.id));
}

/**
 * Every support request of the last SUPPORT_LOOKBACK_DAYS across clinics,
 * newest first, with its mark. One tenant transaction per clinic; a clinic
 * that cannot be read is logged and left out, and counted in `failures`.
 */
export async function listSupportRequests(
  now: Date = new Date(),
): Promise<{ rows: SupportRequestRow[]; failures: number }> {
  const since = new Date(now.getTime() - SUPPORT_LOOKBACK_DAYS * DAY_MS);
  const marks = await supportReplyMarks(new Date(since.getTime() - SUPPORT_LOOKBACK_DAYS * DAY_MS));
  const rows: SupportRequestRow[] = [];
  let failures = 0;
  for (const clinicId of await clinicIds()) {
    try {
      const notices = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        tx.db
          .select({ payload: billingNotices.payload, createdAt: billingNotices.createdAt })
          .from(billingNotices)
          .where(
            and(
              eq(billingNotices.clinicId, clinicId),
              eq(billingNotices.kind, "support_request"),
              gt(billingNotices.createdAt, since),
            ),
          ),
      );
      for (const notice of notices) {
        const payload = notice.payload as {
          requestId?: unknown;
          topic?: unknown;
          replyByOn?: unknown;
        };
        if (typeof payload.requestId !== "string" || typeof payload.replyByOn !== "string")
          continue;
        const repliedAt = marks.get(markKey(clinicId, payload.requestId)) ?? null;
        rows.push({
          clinicId,
          requestId: payload.requestId,
          topic: typeof payload.topic === "string" ? payload.topic : "other",
          replyByOn: payload.replyByOn,
          askedAt: notice.createdAt,
          repliedAt,
          pastDue: repliedAt === null && replyByPassed(payload.replyByOn, now),
        });
      }
    } catch (error) {
      failures += 1;
      log.error("support requests not read", { clinicId, error: describeError(error) });
    }
  }
  rows.sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime());
  return { rows, failures };
}

/**
 * Whether the clinic has a support request with this id: the L25 row the
 * escalation queued. The mark is refused for anything else, so a typo in the
 * console cannot record a reply to a request nobody made.
 */
export async function supportRequestExists(clinicId: string, requestId: string): Promise<boolean> {
  const [row] = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    tx.db
      .select({ id: billingNotices.id })
      .from(billingNotices)
      .where(
        and(
          eq(billingNotices.clinicId, clinicId),
          eq(billingNotices.kind, "support_request"),
          eq(billingNotices.dedupeKey, `support_request:${requestId}`),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** When the request was marked replied, or null. */
export async function supportRepliedAt(clinicId: string, requestId: string): Promise<Date | null> {
  const [row] = await unsafeDb
    .select({ at: securityEvents.occurredAt })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.event, SUPPORT_REPLIED_EVENT),
        sql`${securityEvents.metadata}->>'clinicId' = ${clinicId}`,
        sql`${securityEvents.metadata}->>'requestId' = ${requestId}`,
      ),
    )
    .orderBy(securityEvents.occurredAt)
    .limit(1);
  return row?.at ?? null;
}
