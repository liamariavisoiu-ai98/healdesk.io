// PHASE TWO: attribution (POS/EMR read-back, sync, reconciliation and the
// monthly revenue report). Not part of v1: kept, but fenced out of v1 flows,
// screens, emails and copy (HEALDESK_PHASE_TWO_ATTRIBUTION, lib/env.ts).
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";

import type { Transaction } from "@/db";
import {
  appointments,
  conversations,
  providerConnections,
  reconciliationExceptions,
  transactions,
} from "@/db/schema";
import type { Period } from "@/lib/attribution/period";

import {
  exceptionTotal,
  matchedTotal,
  reconcile,
  type AppointmentRecord,
  type Exception,
  type Match,
  type SaleRecord,
} from "./reconcile";

/**
 * Running the matcher against real rows, and persisting what it decided.
 *
 * The split from reconcile.ts is deliberate: the rules live in a pure function
 * that can be tested against a deposit-then-no-show in a millisecond, and this
 * file is the boring part that loads rows and writes results. When a clinic
 * disputes a figure, the argument is about the rules, and the rules are
 * readable in one file with no SQL in the way.
 */

/**
 * How far outside the reporting period to look for appointments.
 *
 * A deposit collected in March can belong to a May visit, so a March report
 * that only loaded March appointments would call that deposit unmatched and
 * raise an exception for money that is perfectly well explained.
 */
const APPOINTMENT_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const APPOINTMENT_LOOKBEHIND_MS = 2 * 24 * 60 * 60 * 1000;

export type PeriodReconciliation = {
  matches: Match[];
  exceptions: Exception[];
  /** All matched revenue in the period, whoever booked it. */
  totalMatchedUsd: string;
  /** Matched revenue against bookings the agent recovered. The headline. */
  recoveredMatchedUsd: string;
  unmatchedCount: number;
  unmatchedUsd: string;
  /** Which systems the money came from, for the report's basis line. */
  sources: string[];
  /** Earliest date any connected source can reach, when one is limited. */
  coverageStartedAt: Date | null;
};

export async function reconcilePeriod(
  tx: Transaction,
  clinicId: string,
  period: Period,
  options: { now?: Date; persist?: boolean } = {},
): Promise<PeriodReconciliation> {
  const now = options.now ?? new Date();

  const appointmentRows = await tx
    .select({
      id: appointments.id,
      contactId: appointments.contactId,
      scheduledFor: appointments.scheduledFor,
      checkedInAt: appointments.checkedInAt,
      status: appointments.status,
      conversationId: appointments.conversationId,
      // Any recovery reason counts, not just the callback case. Must stay in
      // step with RECOVERED in lib/attribution/report.ts — if these two ever
      // disagree, the reconciled revenue stops matching the recovered-booking
      // count it is reported beside.
      recovered: isNotNull(conversations.recoveryReason),
    })
    .from(appointments)
    .leftJoin(conversations, eq(appointments.conversationId, conversations.id))
    .where(
      and(
        eq(appointments.clinicId, clinicId),
        gte(
          appointments.scheduledFor,
          new Date(period.start.getTime() - APPOINTMENT_LOOKBEHIND_MS),
        ),
        lt(
          appointments.scheduledFor,
          new Date(period.end.getTime() + APPOINTMENT_LOOKAHEAD_MS),
        ),
      ),
    );

  const saleRows = await tx
    .select({
      id: transactions.id,
      contactId: transactions.contactId,
      appointmentId: transactions.appointmentId,
      amountUsd: transactions.amountUsd,
      collectedAt: transactions.collectedAt,
      source: transactions.externalSource,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.clinicId, clinicId),
        // Revenue belongs to the month the money was taken. That is what the
        // clinic's own books say, so it is what the report has to say too.
        gte(transactions.collectedAt, period.start),
        lt(transactions.collectedAt, period.end),
      ),
    );

  const appointmentRecords: AppointmentRecord[] = appointmentRows.map((row) => ({
    id: row.id,
    contactId: row.contactId,
    scheduledFor: row.scheduledFor,
    checkedInAt: row.checkedInAt,
    status: row.status,
    conversationId: row.conversationId,
  }));

  const saleRecords: SaleRecord[] = saleRows.map((row) => ({
    id: row.id,
    contactId: row.contactId,
    appointmentId: row.appointmentId,
    amountUsd: row.amountUsd,
    collectedAt: row.collectedAt,
  }));

  const { matches, exceptions } = reconcile(appointmentRecords, saleRecords, {
    asOf: now,
    exceptionWindow: { from: period.start, to: period.end },
  });

  // The headline number: money matched to appointments the agent recovered.
  // `recovered` comes from the conversation, so a walk-in booking that happened
  // to fall in the period contributes nothing — we only claim what we caused.
  const recoveredAppointments = new Set(
    appointmentRows.filter((row) => row.recovered === true).map((row) => row.id),
  );
  const recoveredMatches = matches.filter((match) =>
    recoveredAppointments.has(match.appointmentId),
  );

  const unmatched = exceptions.filter(
    (exception) =>
      exception.kind === "unmatched_sale" || exception.kind === "ambiguous_match",
  );

  const sources = [
    ...new Set(saleRows.map((row) => row.source).filter((s): s is string => !!s)),
  ].sort();

  if (options.persist !== false) {
    await persistMatches(tx, clinicId, matches);
    await persistExceptions(tx, clinicId, exceptions, now);
  }

  return {
    matches,
    exceptions,
    totalMatchedUsd: matchedTotal(matches, saleRecords),
    recoveredMatchedUsd: matchedTotal(recoveredMatches, saleRecords),
    unmatchedCount: unmatched.length,
    unmatchedUsd: exceptionTotal(unmatched),
    sources,
    coverageStartedAt: await coverageStart(tx, clinicId),
  };
}

/**
 * Write the links the matcher found back onto the transaction rows.
 *
 * Only fills empty links. A match is an inference, and overwriting a link the
 * platform itself supplied with one we guessed at is exactly backwards.
 */
async function persistMatches(
  tx: Transaction,
  clinicId: string,
  matches: Match[],
): Promise<void> {
  const confident = matches.filter((match) => match.confidence !== "medium");
  if (confident.length === 0) return;

  // One statement, not one per match: a busy clinic produces hundreds, and
  // hundreds of round trips inside a tenant transaction is how a nightly job
  // starts timing out three months after it was written.
  const cases = sql.join(
    confident.map(
      (match) =>
        sql`when ${transactions.id} = ${match.saleId}::uuid then ${match.appointmentId}::uuid`,
    ),
    sql` `,
  );

  await tx
    .update(transactions)
    .set({ appointmentId: sql`case ${cases} else ${transactions.appointmentId} end` })
    .where(
      and(
        eq(transactions.clinicId, clinicId),
        isNull(transactions.appointmentId),
        inArray(
          transactions.id,
          confident.map((match) => match.saleId),
        ),
      ),
    );
}

/**
 * Upsert exceptions, then close the ones that have gone away.
 *
 * `lastSeenAt` matters more than it looks: an exception that stops recurring is
 * resolved, and an operator needs to be able to tell "we fixed this" from "this
 * is still happening and nobody has looked". Closing them automatically is the
 * difference between a queue people work and a list people ignore.
 */
async function persistExceptions(
  tx: Transaction,
  clinicId: string,
  exceptions: Exception[],
  now: Date,
): Promise<void> {
  if (exceptions.length > 0) {
    await tx
      .insert(reconciliationExceptions)
      .values(
        exceptions.map((exception) => ({
          clinicId,
          kind: exception.kind,
          fingerprint: exception.fingerprint,
          transactionId: exception.saleId ?? null,
          appointmentId: exception.appointmentId ?? null,
          amountAtRiskUsd: exception.amountAtRiskUsd ?? null,
          summary: exception.summary,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          reconciliationExceptions.clinicId,
          reconciliationExceptions.fingerprint,
        ],
        set: {
          summary: sql`excluded.summary`,
          amountAtRiskUsd: sql`excluded.amount_at_risk_usd`,
          lastSeenAt: now,
          // It came back, so it isn't resolved after all.
          resolvedAt: sql`null`,
          resolvedBy: sql`null`,
        },
      });
  }

  const stillOpen = exceptions.map((exception) => exception.fingerprint);

  await tx
    .update(reconciliationExceptions)
    .set({ resolvedAt: now, resolvedBy: "auto" })
    .where(
      and(
        eq(reconciliationExceptions.clinicId, clinicId),
        isNull(reconciliationExceptions.resolvedAt),
        stillOpen.length > 0
          ? notInArray(reconciliationExceptions.fingerprint, stillOpen)
          : undefined,
      ),
    );
}

/**
 * The earliest date any connected source can reach.
 *
 * Reported as a caveat rather than silently truncating the number. A clinic
 * that connected Stripe last week and asks for last month's revenue must be
 * told the figure only covers part of it — otherwise they read a real number
 * as a small one and conclude we lost them money.
 */
async function coverageStart(
  tx: Transaction,
  clinicId: string,
): Promise<Date | null> {
  const rows = await tx
    .select({ metadata: providerConnections.metadata })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, clinicId),
        eq(providerConnections.status, "active"),
      ),
    );

  const dates = rows
    .map((row) => (row.metadata as { coverageStartedAt?: string } | null)?.coverageStartedAt)
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (dates.length === 0) return null;

  // The latest start, not the earliest: coverage is only as good as the source
  // that joined most recently.
  return dates.reduce((latest, date) => (date > latest ? date : latest));
}
