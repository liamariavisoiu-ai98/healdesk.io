import { and, count, eq, inArray, lt, min } from "drizzle-orm";

import { transcriptEmails, TRANSCRIPT_EMAIL_STATUSES, type TranscriptEmailStatus } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import {
  canResend,
  listTranscriptDeliveries,
  TRANSCRIPT_COPY_MAX_DAYS,
  TRANSCRIPT_UNCONFIRMED_HOURS,
} from "@/lib/conversations/transcript-outbox";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { actorFor, ok, opsProblem, type Operator, type OpsOutcome } from "./api";
import { listClinics } from "./clinics";

/**
 * `listUndeliveredTranscripts` (ops automation Phase 5, lane P5a; design E3
 * §1, "Transcripts: no view across clinics"): the clinics whose transcript
 * copies have not reached them, one row each, with counts and the oldest
 * held copy's age. Never a copy, a recipient, a conversation id or SES's
 * reason.
 *
 * The states are the transcript outbox's own (lib/conversations/
 * transcript-outbox.ts), read through listTranscriptDeliveries, the
 * function the per-clinic `transcriptDeliveries` view uses, and canResend,
 * which names the states that still hold a copy:
 *
 *   - overdue: copies still held (pending, sent or bounced) queued more than
 *     TRANSCRIPT_UNCONFIRMED_HOURS ago;
 *   - bounced, expired, unconfirmed: the outbox's counts of those states.
 *
 * A copy is a receipt at the latest TRANSCRIPT_COPY_MAX_DAYS after it was
 * queued, so the counts read the copies queued in the last twice that: every
 * copy that expired in the last 30 days is in it (an unconfirmed one may have
 * ended up to 27 days earlier still; it is counted too). A clinic is listed
 * when any of the four is above zero: one with only a young held copy is
 * not. Counts only, so no access row is written (as the Home queues read the
 * same table, lib/ops/inbox/queues.ts). A clinic whose tenant read fails is
 * counted in `unreadClinics`, never read as none.
 */

export type UndeliveredTranscriptCounts = {
  overdue: number;
  bounced: number;
  expired: number;
  unconfirmed: number;
};

export type UndeliveredTranscriptClinic = {
  clinicId: string;
  clinicName: string;
  counts: UndeliveredTranscriptCounts;
  /** Whole hours since the oldest copy still held was queued; null when none is held. */
  oldestAgeHours: number | null;
};

export type UndeliveredTranscripts = {
  clinics: UndeliveredTranscriptClinic[];
  unreadClinics: number;
};

/** How far back the counts read: see the header. */
export const UNDELIVERED_WINDOW_DAYS = TRANSCRIPT_COPY_MAX_DAYS * 2;

const HOUR_MS = 60 * 60 * 1000;
const HELD: TranscriptEmailStatus[] = TRANSCRIPT_EMAIL_STATUSES.filter(canResend);

export async function listUndeliveredTranscripts(options: {
  actor: ActorContext;
  request?: RequestContext;
  now?: Date;
}): Promise<UndeliveredTranscripts> {
  const now = options.now ?? new Date();
  const overdueBefore = new Date(now.getTime() - TRANSCRIPT_UNCONFIRMED_HOURS * HOUR_MS);
  const out: UndeliveredTranscriptClinic[] = [];
  let unreadClinics = 0;
  for (const clinic of (await listClinics()).filter((c) => !c.destroyedAt)) {
    try {
      const read = await withTenant(
        { clinicId: clinic.id, actor: options.actor, request: options.request },
        async (tx) => {
          // Counts by state only: no receipt is read.
          const { counts } = await listTranscriptDeliveries(tx, UNDELIVERED_WINDOW_DAYS, 0);
          const held = and(eq(transcriptEmails.clinicId, tx.clinicId), inArray(transcriptEmails.status, HELD));
          const [overdue] = await tx.db
            .select({ n: count() })
            .from(transcriptEmails)
            .where(and(held, lt(transcriptEmails.createdAt, overdueBefore)));
          const [oldest] = await tx.db
            .select({ at: min(transcriptEmails.createdAt) })
            .from(transcriptEmails)
            .where(held);
          return { counts, overdue: Number(overdue?.n ?? 0), oldest: oldest?.at ?? null };
        },
      );
      const counts: UndeliveredTranscriptCounts = {
        overdue: read.overdue,
        bounced: read.counts.bounced,
        expired: read.counts.expired,
        unconfirmed: read.counts.unconfirmed,
      };
      if (counts.overdue + counts.bounced + counts.expired + counts.unconfirmed === 0) continue;
      const oldest = read.oldest ? new Date(read.oldest) : null;
      out.push({
        clinicId: clinic.id,
        clinicName: clinic.name,
        counts,
        oldestAgeHours: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / HOUR_MS)) : null,
      });
    } catch (error) {
      unreadClinics += 1;
      log.error("undelivered transcripts: a clinic could not be read", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  out.sort(
    (a, b) =>
      b.counts.expired - a.counts.expired ||
      (b.oldestAgeHours ?? -1) - (a.oldestAgeHours ?? -1) ||
      a.clinicId.localeCompare(b.clinicId),
  );
  return { clinics: out, unreadClinics };
}

/** The ops operation: no arguments, and any argument is refused. */
export async function opListUndeliveredTranscripts(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  if (Object.keys(args).length > 0) {
    return opsProblem("listUndeliveredTranscripts takes no arguments.", 400, "invalid_args");
  }
  try {
    return ok(await listUndeliveredTranscripts({ actor: actorFor(operator), request: operator.request }));
  } catch (error) {
    log.error("undelivered transcripts not listed", { error: describeError(error) });
    return opsProblem("The undelivered transcripts could not be read.", 500, "failed");
  }
}
