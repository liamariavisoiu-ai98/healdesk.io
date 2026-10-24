import { and, count, eq, gte, inArray, isNull, lt, lte, min, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingNotices,
  billingRequests,
  checkoutIntents,
  opsAlerts,
  reportDeliveries,
  stripeConnectEvents,
  transcriptEmails,
} from "@/db/schema";
import { belowFloorUnsigned } from "@/lib/agreements/resign";
import { MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import type { InboxContext, InboxRow, InboxSource, Tone } from "./types";

/**
 * The machine queues that need a person: the same queues the 07:00 digest
 * counts, read here directly rather than through collectDigest(). The digest
 * reads each clinic's booking requests (a patient's) under its own
 * "ops-digest" actor and writes an access row for it; Home must not write
 * rows that say the digest looked when the operator did. So this source reads
 * only queues that hold no patient: pg-boss's jobs, the email outbox and its
 * dead letters, the clinic emails Resend said bounced, were complained of or
 * were suppressed in the last day (the digest's email-health counts, from the
 * delivery ledger), the transcript outbox's states (never a copy), billing
 * requests, Stripe and Connect events, paid orders without an account,
 * accounts below the BAA floor and ops alerts that could not be emailed. No
 * audit row is written by any of it. Booking requests are left to the digest
 * email, and support replies to their own source. The machine queues section
 * of the System page (lib/ops/machine-queues-ops.ts) reads the same queues
 * through readMachineQueues and judges them by the same needsAttention.
 *
 * A queue is a Home row only when it needs a person: a dead letter, a bounce,
 * a failed job or a paid order without an account at once; anything else once its
 * oldest item has waited past the queue's patience (a transcript copy 72
 * hours, after which it is deleted unconfirmed; the rest an hour). A part that
 * cannot be read (pg-boss's schema absent, a clinic's tenant read failing)
 * makes the source partial, never a zero.
 */

/**
 * Where a queue's row opens: the read-only machine queues section of the
 * System page (the owner's decision of 24 October 2026), headed "Requires
 * your attention". One constant, so the screens lane can move the anchor
 * without touching a sentence. Background jobs open the job switches; an
 * email queue that belongs to one clinic opens that clinic's Deliveries tab.
 */
export const MACHINE_QUEUES_PAGE = "/admin/system#attention";
const JOBS_PAGE = "/admin/system/jobs";

export function deliveriesHref(clinicId: string): string {
  return `/admin/clinics/${clinicId.toLowerCase()}/deliveries`;
}

export type QueueWords = {
  words: string;
  href: string;
  tone: Tone;
  patienceMinutes: number;
  /** A queue of one clinic's emails: with a single clinic in it, the row opens that clinic's Deliveries tab. */
  perClinic?: "deliveries";
};

const ALWAYS = 0;
const HOUR = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_DAYS = 7;
/**
 * A failed background job counts for two days at most. While the worker runs
 * (supervise: true, src/workers/index.ts), pg-boss archives a failed job
 * twelve hours after its completed_on, so in practice a failure is on Home for
 * about twelve hours; the two-day window matters only while the worker is
 * down and nothing archives, so a stale failed cron run does not hold a Home
 * row for the fourteen days pg-boss would keep it.
 */
const FAILED_JOB_DAYS = 2;
/** The digest's email-health window: bounces and complaints of the last day. */
const BOUNCE_WINDOW_MS = DAY_MS;
/** Resend's later word that means an email to a clinic will not arrive (as lib/lifecycle/ledger.ts reads it). */
const UNDELIVERABLE = ["bounced", "complained", "suppressed"] as const;

export const QUEUE_WORDS: Record<string, QueueWords> = {
  outbox: { words: "Emails waiting to send", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: HOUR },
  outbox_dead: {
    words: "Emails to clinics that could not be sent and will not be tried again, in the last 7 days",
    href: MACHINE_QUEUES_PAGE,
    tone: "warn",
    patienceMinutes: ALWAYS,
    perClinic: "deliveries",
  },
  emails_undeliverable: {
    words: "Emails to clinics that bounced, were marked as spam or were blocked, in the last 24 hours",
    href: MACHINE_QUEUES_PAGE,
    tone: "warn",
    patienceMinutes: ALWAYS,
    perClinic: "deliveries",
  },
  transcript_emails: { words: "Transcript copies not delivered", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: 72 * HOUR },
  billing_requests: { words: "Billing requests not done", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: HOUR },
  billing_events_retrying: { words: "Stripe events retrying", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: HOUR },
  billing_events_parked: { words: "Stripe events parked", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: ALWAYS },
  connect_events_retrying: { words: "Stripe Connect events retrying", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: HOUR },
  connect_events_parked: { words: "Stripe Connect events parked", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: ALWAYS },
  orders_without_account: { words: "Paid orders without an account", href: MACHINE_QUEUES_PAGE, tone: "bad", patienceMinutes: ALWAYS },
  agreements_below_floor: {
    words: "Accounts answering under a superseded agreement, re-sign unsigned",
    href: "/admin/compliance/agreements",
    tone: "warn",
    patienceMinutes: ALWAYS,
  },
  ops_alerts_unsent: { words: "Ops alerts that could not be emailed", href: MACHINE_QUEUES_PAGE, tone: "warn", patienceMinutes: ALWAYS },
};

/** The fixed queues each part reads: a part that cannot be read takes these out, never as zeros. */
const PART_KINDS: Record<string, readonly string[]> = {
  "Stripe events": ["billing_events_retrying", "billing_events_parked", "connect_events_retrying", "connect_events_parked"],
  "paid orders": ["orders_without_account"],
  "ops alerts unsent": ["ops_alerts_unsent"],
  "agreements below the floor": ["agreements_below_floor"],
  clinics: ["outbox", "outbox_dead", "emails_undeliverable", "transcript_emails", "billing_requests"],
};

export function wordsFor(kind: string): QueueWords {
  const known = QUEUE_WORDS[kind];
  if (known) return known;
  if (kind.startsWith("pgboss_failed:")) {
    return { words: `Background jobs failed in ${kind.slice("pgboss_failed:".length)}`, href: JOBS_PAGE, tone: "warn", patienceMinutes: ALWAYS };
  }
  const job = kind.startsWith("pgboss:") ? kind.slice("pgboss:".length) : kind;
  return { words: `Background jobs waiting in ${job}`, href: JOBS_PAGE, tone: "warn", patienceMinutes: HOUR };
}

/**
 * Whether a queue needs a person: the one rule Home's rows and the machine
 * queues section share, so the two can never disagree. A queue with
 * something in it does at once when its patience is none (a dead letter, a
 * failed job, a paid order without an account, a bounce); anything else once
 * its oldest item has waited its patience.
 */
export function needsAttention(kind: string, count: number, oldestAgeMinutes: number | null): boolean {
  if (!(count > 0)) return false;
  const { patienceMinutes } = wordsFor(kind);
  return patienceMinutes === ALWAYS || (oldestAgeMinutes ?? 0) >= patienceMinutes;
}

export type QueueTotal = { count: number; oldest: Date | null; clinics: Set<string> };

class Tally {
  readonly queues = new Map<string, QueueTotal>();
  readonly unread: string[] = [];
  /** The fixed kinds whose part was read in full, so a zero there is a real zero. */
  readonly complete = new Set<string>();
  /** The per-clinic kinds counted with some clinic unread: their counts are "at least". */
  readonly lowerBound = new Set<string>();

  add(
    kind: string,
    n: number | string | null | undefined,
    oldest: Date | string | null | undefined,
    clinicId?: string,
  ): void {
    const total = Number(n ?? 0);
    if (!(total > 0)) return;
    const at = oldest ? new Date(oldest) : null;
    const seen = this.queues.get(kind) ?? { count: 0, oldest: null, clinics: new Set<string>() };
    seen.count += total;
    if (at && (!seen.oldest || at < seen.oldest)) seen.oldest = at;
    if (clinicId) seen.clinics.add(clinicId);
    this.queues.set(kind, seen);
  }

  async read(part: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      for (const kind of PART_KINDS[part] ?? []) this.complete.add(kind);
    } catch (error) {
      this.unread.push(part);
      log.error("ops inbox queue unreadable", { resource: part, error: describeError(error) });
    }
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

/** What readMachineQueues found: each queue with something in it, the fixed ones read in full, and the parts not read. */
export type MachineQueueRead = {
  queues: ReadonlyMap<string, QueueTotal>;
  /** Fixed queues whose part was read in full: absent from `queues`, they are empty. */
  complete: ReadonlySet<string>;
  /** Per-clinic queues read while some clinic could not be: each count is a lower bound. */
  lowerBound: ReadonlySet<string>;
  unread: readonly string[];
};

/**
 * Read every machine queue at `now`, under the caller's actor. Writes nothing
 * and records no access row (see the header). Exported for the machine queues
 * operation (lib/ops/machine-queues-ops.ts), which reads the same queues.
 */
export async function readMachineQueues(ctx: Pick<InboxContext, "now" | "actor" | "request">): Promise<MachineQueueRead> {
  const now = ctx.now;
  const deadSince = new Date(now.getTime() - DEAD_DAYS * DAY_MS);
  const failedSince = new Date(now.getTime() - FAILED_JOB_DAYS * DAY_MS);
  const bounceSince = new Date(now.getTime() - BOUNCE_WINDOW_MS);
  const tally = new Tally();

  await tally.read("pg-boss", async () => {
    // A job scheduled for later waits from when it became due, not from when it was queued.
    const waiting = await unsafeDb.execute(
      sql`select name, count(*) as n, min(greatest(created_on, start_after)) as oldest
            from pgboss.job
           where state in ('created', 'retry') and start_after <= ${now}
           group by name`,
    );
    for (const r of rowsOf(waiting)) tally.add(`pgboss:${String(r.name)}`, r.n as string, r.oldest as string);
    // Failed when it last failed (pg-boss stamps completed_on then), and only lately.
    const failed = await unsafeDb.execute(
      sql`select name, count(*) as n, min(coalesce(completed_on, created_on)) as oldest
            from pgboss.job
           where state = 'failed' and coalesce(completed_on, created_on) >= ${failedSince}
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

  // Each clinic's own queues, in its own tenant, as the caller; nothing
  // read here is a patient's, so nothing is recorded.
  let failedClinics = 0;
  await tally.read("the clinic list", async () => {
    const clinics = await unsafeDb.execute(sql`select id from app_clinics_overview() where destroyed_at is null`);
    for (const { id } of rowsOf(clinics)) {
      try {
        await withTenant({ clinicId: String(id), actor: ctx.actor, request: ctx.request }, async (tx) => {
          const c = tx.clinicId;
          // Only what is due: a notice meant to wait (quiet hours, a retry,
          // a reminder for tomorrow) is not late, and waits from when it fell due.
          const [outbox] = await tx.db
            .select({ n: count(), oldest: min(billingNotices.sendAfter) })
            .from(billingNotices)
            .where(
              and(
                eq(billingNotices.clinicId, c),
                isNull(billingNotices.sentAt),
                lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
                lte(billingNotices.sendAfter, now),
              ),
            );
          tally.add("outbox", outbox?.n, outbox?.oldest, c);
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
          tally.add("outbox_dead", dead?.n, dead?.oldest, c);
          // The digest's bounces, complaints and suppressions of the last
          // day, from the delivery ledger as Resend's webhook stamped it.
          const [undeliverable] = await tx.db
            .select({ n: count(), oldest: min(reportDeliveries.deliveryAt) })
            .from(reportDeliveries)
            .where(
              and(
                eq(reportDeliveries.clinicId, c),
                inArray(reportDeliveries.deliveryStatus, [...UNDELIVERABLE]),
                gte(reportDeliveries.deliveryAt, bounceSince),
              ),
            );
          tally.add("emails_undeliverable", undeliverable?.n, undeliverable?.oldest, c);
          const [transcripts] = await tx.db
            .select({ n: count(), oldest: min(transcriptEmails.createdAt) })
            .from(transcriptEmails)
            .where(and(eq(transcriptEmails.clinicId, c), inArray(transcriptEmails.status, ["pending", "sent", "bounced"])));
          tally.add("transcript_emails", transcripts?.n, transcripts?.oldest, c);
          const [requests] = await tx.db
            .select({ n: count(), oldest: min(billingRequests.requestedAt) })
            .from(billingRequests)
            .where(and(eq(billingRequests.clinicId, c), isNull(billingRequests.doneAt)));
          tally.add("billing_requests", requests?.n, requests?.oldest, c);
        });
      } catch (error) {
        failedClinics += 1;
        log.error("ops inbox clinic queues unreadable", { clinicId: String(id), error: describeError(error) });
      }
    }
  });
  if (failedClinics > 0) {
    tally.unread.push(`${failedClinics} clinic(s)`);
    for (const kind of PART_KINDS.clinics!) tally.lowerBound.add(kind);
  } else if (!tally.unread.includes("the clinic list")) for (const kind of PART_KINDS.clinics!) tally.complete.add(kind);

  return { queues: tally.queues, complete: tally.complete, lowerBound: tally.lowerBound, unread: tally.unread };
}

/** Whole minutes the oldest item has waited, or null when the queue does not date it. */
export function oldestAgeMinutes(q: Pick<QueueTotal, "oldest">, now: Date): number | null {
  return q.oldest ? Math.max(0, Math.round((now.getTime() - q.oldest.getTime()) / 60_000)) : null;
}

/** Where a queue opens: its page, or, for one clinic's emails, that clinic's Deliveries tab. */
export function queueHref(kind: string, q: Pick<QueueTotal, "clinics">): string {
  const words = wordsFor(kind);
  if (words.perClinic === "deliveries" && q.clinics.size === 1) return deliveriesHref([...q.clinics][0]!);
  return words.href;
}

export const queuesSource: InboxSource = {
  name: "the queues",
  async read(ctx) {
    const now = ctx.now;
    const read = await readMachineQueues(ctx);

    const rows: InboxRow[] = [];
    for (const [kind, q] of read.queues) {
      const words = wordsFor(kind);
      const minutes = oldestAgeMinutes(q, now);
      if (!needsAttention(kind, q.count, minutes)) continue;
      rows.push({
        id: `queue:${kind}`,
        kind: "queue",
        count: q.count,
        sentence: `${words.words}${
          read.lowerBound.has(kind) ? ` (at least ${q.count}: a clinic could not be read)` : ""
        }${minutes === null ? "" : `; the oldest is ${age(minutes)} old`}.`,
        clinic: null,
        button: { label: "Open", kind: "link", href: queueHref(kind, q) },
        tone: words.tone,
        dueAt: null,
      });
    }
    return {
      rows,
      partial: read.unread.length > 0 ? `Could not read: ${read.unread.join(", ")}.` : undefined,
    };
  },
};

/** "45 min", "3 h", "4 days", as the digest prints an age. */
export function age(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (24 * 60))} days`;
}
