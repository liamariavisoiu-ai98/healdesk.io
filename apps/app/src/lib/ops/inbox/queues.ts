import { and, count, eq, gte, inArray, isNull, lt, min, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingNotices,
  billingRequests,
  checkoutIntents,
  opsAlerts,
  stripeConnectEvents,
  transcriptEmails,
} from "@/db/schema";
import { belowFloorUnsigned } from "@/lib/agreements/resign";
import { MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import type { InboxRow, InboxSource, Tone } from "./types";

/**
 * The machine queues that need a person: the same queues the 07:00 digest
 * counts, read here directly rather than through collectDigest(). The digest
 * reads each clinic's booking requests (a patient's) under its own
 * "ops-digest" actor and writes an access row for it; Home must not write
 * rows that say the digest looked when the operator did. So this source reads
 * only queues that hold no patient: pg-boss's jobs, the email outbox, the
 * transcript outbox's states (never a copy), billing requests, Stripe and
 * Connect events, paid orders without an account, accounts below the BAA
 * floor and ops alerts that could not be emailed. No audit row is written by
 * any of it. Booking requests are left to the digest email, and support
 * replies to their own source.
 *
 * A queue is a Home row only when it needs a person: a dead letter, a failed
 * job or a paid order without an account at once; anything else once its
 * oldest item has waited past the queue's patience (a transcript copy 72
 * hours, after which it is deleted unconfirmed; the rest an hour). A part that
 * cannot be read (pg-boss's schema absent, a clinic's tenant read failing)
 * makes the source partial, never a zero.
 */

type QueueWords = { words: string; href: string; tone: Tone; patienceMinutes: number };

const ALWAYS = 0;
const HOUR = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_DAYS = 7;

export const QUEUE_WORDS: Record<string, QueueWords> = {
  outbox: { words: "Emails waiting to send", href: "/admin/ops", tone: "warn", patienceMinutes: HOUR },
  outbox_dead: { words: "Emails that gave up after every attempt", href: "/admin/ops", tone: "warn", patienceMinutes: ALWAYS },
  transcript_emails: { words: "Transcript copies not delivered", href: "/admin/ops", tone: "warn", patienceMinutes: 72 * HOUR },
  billing_requests: { words: "Billing requests not done", href: "/admin/ops", tone: "warn", patienceMinutes: HOUR },
  billing_events_retrying: { words: "Stripe events retrying", href: "/admin/ops", tone: "warn", patienceMinutes: HOUR },
  billing_events_parked: { words: "Stripe events parked", href: "/admin/ops", tone: "warn", patienceMinutes: ALWAYS },
  connect_events_retrying: { words: "Stripe Connect events retrying", href: "/admin/ops", tone: "warn", patienceMinutes: HOUR },
  connect_events_parked: { words: "Stripe Connect events parked", href: "/admin/ops", tone: "warn", patienceMinutes: ALWAYS },
  orders_without_account: { words: "Paid orders without an account", href: "/admin/ops", tone: "bad", patienceMinutes: ALWAYS },
  agreements_below_floor: {
    words: "Accounts answering under a superseded agreement, re-sign unsigned",
    href: "/admin/agreements",
    tone: "warn",
    patienceMinutes: ALWAYS,
  },
  ops_alerts_unsent: { words: "Ops alerts that could not be emailed", href: "/admin/ops", tone: "warn", patienceMinutes: ALWAYS },
};

function wordsFor(kind: string): QueueWords {
  const known = QUEUE_WORDS[kind];
  if (known) return known;
  if (kind.startsWith("pgboss_failed:")) {
    return { words: `Background jobs failed in ${kind.slice("pgboss_failed:".length)}`, href: "/admin/ops", tone: "warn", patienceMinutes: ALWAYS };
  }
  const job = kind.startsWith("pgboss:") ? kind.slice("pgboss:".length) : kind;
  return { words: `Background jobs waiting in ${job}`, href: "/admin/ops", tone: "warn", patienceMinutes: HOUR };
}

class Tally {
  readonly queues = new Map<string, { count: number; oldest: Date | null }>();
  readonly unread: string[] = [];

  add(kind: string, n: number | string | null | undefined, oldest: Date | string | null | undefined): void {
    const total = Number(n ?? 0);
    if (!(total > 0)) return;
    const at = oldest ? new Date(oldest) : null;
    const seen = this.queues.get(kind) ?? { count: 0, oldest: null };
    seen.count += total;
    if (at && (!seen.oldest || at < seen.oldest)) seen.oldest = at;
    this.queues.set(kind, seen);
  }

  async read(part: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.unread.push(part);
      log.error("ops inbox queue unreadable", { resource: part, error: describeError(error) });
    }
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

export const queuesSource: InboxSource = {
  name: "the queues",
  async read(ctx) {
    const now = ctx.now;
    const deadSince = new Date(now.getTime() - DEAD_DAYS * DAY_MS);
    const tally = new Tally();

    await tally.read("pg-boss", async () => {
      const waiting = await unsafeDb.execute(
        sql`select name, count(*) as n, min(created_on) as oldest
              from pgboss.job
             where state in ('created', 'retry') and start_after <= ${now}
             group by name`,
      );
      for (const r of rowsOf(waiting)) tally.add(`pgboss:${String(r.name)}`, r.n as string, r.oldest as string);
      const failed = await unsafeDb.execute(
        sql`select name, count(*) as n, min(created_on) as oldest
              from pgboss.job
             where state = 'failed' and created_on >= ${deadSince}
             group by name`,
      );
      for (const r of rowsOf(failed)) tally.add(`pgboss_failed:${String(r.name)}`, r.n as string, r.oldest as string);
    });

    await tally.read("Stripe events", async () => {
      for (const [kind, outcome] of [
        ["billing_events_retrying", "failed"],
        ["billing_events_parked", "dead_letter"],
      ] as const) {
        const [r] = await unsafeDb
          .select({ n: count(), oldest: min(billingEvents.receivedAt) })
          .from(billingEvents)
          .where(eq(billingEvents.outcome, outcome));
        tally.add(kind, r?.n, r?.oldest);
      }
      for (const [kind, outcome] of [
        ["connect_events_retrying", "failed"],
        ["connect_events_parked", "dead_letter"],
      ] as const) {
        const [r] = await unsafeDb
          .select({ n: count(), oldest: min(stripeConnectEvents.receivedAt) })
          .from(stripeConnectEvents)
          .where(eq(stripeConnectEvents.outcome, outcome));
        tally.add(kind, r?.n, r?.oldest);
      }
    });

    await tally.read("paid orders", async () => {
      const [r] = await unsafeDb
        .select({ n: count(), oldest: min(checkoutIntents.paidSeenAt) })
        .from(checkoutIntents)
        .where(and(sql`${checkoutIntents.paidSeenAt} is not null`, isNull(checkoutIntents.consumedAt)));
      tally.add("orders_without_account", r?.n, r?.oldest);
    });

    await tally.read("ops alerts unsent", async () => {
      const [r] = await unsafeDb
        .select({ n: count(), oldest: min(opsAlerts.raisedAt) })
        .from(opsAlerts)
        .where(
          and(
            ne(opsAlerts.event, "ops_digest"),
            isNull(opsAlerts.sentAt),
            sql`${opsAlerts.lastError} is not null`,
            gte(opsAlerts.raisedAt, deadSince),
          ),
        );
      tally.add("ops_alerts_unsent", r?.n, r?.oldest);
    });

    await tally.read("agreements below the floor", async () => {
      const { count: n, oldest } = await belowFloorUnsigned();
      tally.add("agreements_below_floor", n, oldest);
    });

    // Each clinic's own queues, in its own tenant, as the operator; nothing
    // read here is a patient's, so nothing is recorded.
    const clinics = await unsafeDb.execute(sql`select id from app_clinics_overview() where destroyed_at is null`);
    let failedClinics = 0;
    for (const { id } of rowsOf(clinics)) {
      try {
        await withTenant({ clinicId: String(id), actor: ctx.actor, request: ctx.request }, async (tx) => {
          const c = tx.clinicId;
          const [outbox] = await tx.db
            .select({ n: count(), oldest: min(billingNotices.createdAt) })
            .from(billingNotices)
            .where(and(eq(billingNotices.clinicId, c), isNull(billingNotices.sentAt), lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS)));
          tally.add("outbox", outbox?.n, outbox?.oldest);
          const [dead] = await tx.db
            .select({ n: count(), oldest: min(billingNotices.createdAt) })
            .from(billingNotices)
            .where(
              and(
                eq(billingNotices.clinicId, c),
                isNull(billingNotices.sentAt),
                gte(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
                gte(billingNotices.createdAt, deadSince),
              ),
            );
          tally.add("outbox_dead", dead?.n, dead?.oldest);
          const [transcripts] = await tx.db
            .select({ n: count(), oldest: min(transcriptEmails.createdAt) })
            .from(transcriptEmails)
            .where(and(eq(transcriptEmails.clinicId, c), inArray(transcriptEmails.status, ["pending", "sent", "bounced"])));
          tally.add("transcript_emails", transcripts?.n, transcripts?.oldest);
          const [requests] = await tx.db
            .select({ n: count(), oldest: min(billingRequests.requestedAt) })
            .from(billingRequests)
            .where(and(eq(billingRequests.clinicId, c), isNull(billingRequests.doneAt)));
          tally.add("billing_requests", requests?.n, requests?.oldest);
        });
      } catch (error) {
        failedClinics += 1;
        log.error("ops inbox clinic queues unreadable", { clinicId: String(id), error: describeError(error) });
      }
    }
    if (failedClinics > 0) tally.unread.push(`${failedClinics} clinic(s)`);

    const rows: InboxRow[] = [];
    for (const [kind, q] of tally.queues) {
      const words = wordsFor(kind);
      const minutes = q.oldest ? Math.max(0, Math.round((now.getTime() - q.oldest.getTime()) / 60_000)) : null;
      if (words.patienceMinutes > ALWAYS && (minutes ?? 0) < words.patienceMinutes) continue;
      rows.push({
        id: `queue:${kind}`,
        kind: "queue",
        count: q.count,
        sentence: minutes === null ? `${words.words}.` : `${words.words}; the oldest is ${age(minutes)} old.`,
        clinic: null,
        button: { label: "Open", kind: "link", href: words.href },
        tone: words.tone,
        dueAt: null,
      });
    }
    return {
      rows,
      partial: tally.unread.length > 0 ? `Could not read: ${tally.unread.join(", ")}.` : undefined,
    };
  },
};

/** "45 min", "3 h", "4 days", as the digest prints an age. */
export function age(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (24 * 60))} days`;
}
