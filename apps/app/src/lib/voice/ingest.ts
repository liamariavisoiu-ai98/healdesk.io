import { isAfterHours, parseOpeningHours } from "@/lib/clinic/opening-hours";
import { toE164 } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinics, contacts, conversations } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withTenant } from "@/lib/tenant";

/**
 * Turning a finished call into the one row the whole product depends on.
 *
 * Until this existed, nothing anywhere wrote a `conversations` row. Every
 * downstream system — the attribution engine, the reconciliation matcher, the
 * monthly report, the entire sales pitch — was correct, tested, and fed by
 * nothing, so a real clinic's report computed $0.00 no matter what happened on
 * its phone line.
 *
 * ## The only judgement this file makes
 *
 * `recovery_reason`. It is the difference between "we answered a call" and "we
 * recovered revenue you would otherwise have lost", and it is the number a
 * clinic judges us on — so it is decided HERE, at ingestion, from facts
 * observable at the moment the call arrived, and never inferred later.
 *
 * The rule, from the schema comment: a value goes in only if the clinic
 * genuinely would NOT have handled the contact. A call answered during opening
 * hours on a free line is not recovery even if it booked. Counting it would
 * inflate exactly the figure we are asking to be trusted on.
 *
 * That is why this needs the clinic's opening hours, and why it reads them from
 * the clinic row rather than accepting them from the vendor payload. The vendor
 * does not know when the front desk is open, and a payload that claimed to
 * would be a number we could not defend.
 *
 * ## Why the vendor's own "missed call" flag is not trusted
 *
 * Voice platforms report call disposition, not counterfactuals. They know the
 * agent answered; they do not know whether a human would have. So the payload
 * supplies observable facts — when it rang, whether the clinic's line was busy,
 * whether it rang out first — and this function decides what they mean.
 */

export type VoiceCallEvent = {
  /** The platform's own id, for idempotency. */
  externalCallId: string;
  clinicId: string;
  /** ⚠️ PHI. E.164 where parseable. */
  callerPhone?: string;
  callerName?: string;
  startedAt: Date;
  endedAt?: Date;
  /**
   * What the telephony layer observed. Facts, not conclusions.
   *
   * `rangAtClinicFirst` means the clinic's own line rang before the call
   * reached us — i.e. conditional forwarding on no-answer. `clinicLineBusy`
   * means forwarding fired on busy. Both are things the carrier knows.
   */
  rangAtClinicFirst?: boolean;
  clinicLineBusy?: boolean;
  /** True when WE placed the call back to a number that rang out earlier. */
  isCallback?: boolean;
  outcome?:
    | "booked"
    | "qualified_no_booking"
    | "price_shopper"
    | "escalated_to_human"
    | "spam"
    | "abandoned";
  treatmentInterest?: string;
  /** Proof the AI disclosure played before audio reached transcription. */
  disclosurePlayedAt?: Date;
  recordingOptOut?: boolean;
  responseLatencySeconds?: number;
  transcriptUri?: string;
  recordingUri?: string;
};

export class VoiceIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceIngestError";
  }
}

export type IngestResult = {
  conversationId: string;
  recoveryReason: RecoveryReason | null;
  duplicate: boolean;
};

type RecoveryReason =
  | "after_hours"
  | "line_busy"
  | "rang_unanswered"
  | "missed_call_callback";

/**
 * Decide whether this contact was genuinely recovered.
 *
 * Ordered most-specific first, because more than one can be true: a callback
 * placed at 9pm is both a callback and after hours, and "we called them back"
 * is the stronger and more defensible claim of the two.
 *
 * Returns null — meaning "not recovered" — whenever none of the four facts
 * hold. Null is the honest default, and the majority answer for a clinic whose
 * front desk is working.
 */
export function classifyRecovery(
  event: VoiceCallEvent,
  openingHours: unknown,
  timezone: string,
): RecoveryReason | null {
  if (event.isCallback) return "missed_call_callback";
  if (event.clinicLineBusy) return "line_busy";
  if (event.rangAtClinicFirst) return "rang_unanswered";

  // Last, and only if the clinic told us when it is open. An unset schedule
  // means we cannot know, and guessing "closed" would manufacture recovery out
  // of missing configuration — which is the exact failure this ordering exists
  // to prevent.
  if (openingHours) {
    try {
      const hours = parseOpeningHours(openingHours);
      if (isAfterHours(hours, event.startedAt, timezone)) return "after_hours";
    } catch {
      // A malformed schedule is a configuration bug, not evidence of recovery.
      return null;
    }
  }

  return null;
}

/**
 * Record a completed call.
 *
 * Idempotent on the platform's own call id: voice vendors retry webhooks, and a
 * call counted twice is a revenue figure inflated twice.
 */
export async function ingestCall(
  event: VoiceCallEvent,
  actor: ActorContext = { type: "agent", serviceName: "voice-ingest" },
): Promise<IngestResult> {
  if (!event.externalCallId?.trim()) {
    throw new VoiceIngestError("A call id is required for idempotency.");
  }

  return withTenant({ clinicId: event.clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
      })
      .from(clinics)
      .where(eq(clinics.id, event.clinicId))
      .limit(1);

    if (!clinic) throw new VoiceIngestError("Unknown clinic.");

    const recoveryReason = classifyRecovery(
      event,
      clinic.openingHours,
      clinic.timezone,
    );

    const contactId = event.callerPhone
      ? await upsertCaller(tx.db, event)
      : null;

    const [row] = await tx.db
      .insert(conversations)
      .values({
        clinicId: event.clinicId,
        contactId,
        channel: "voice",
        recoveryReason,
        outcome: event.outcome ?? null,
        treatmentInterest: event.treatmentInterest ?? null,
        transcriptUri: event.transcriptUri ?? null,
        recordingUri: event.recordingUri ?? null,
        disclosurePlayedAt: event.disclosurePlayedAt ?? null,
        recordingOptOut: event.recordingOptOut ?? false,
        responseLatencySeconds: event.responseLatencySeconds ?? null,
        startedAt: event.startedAt,
        endedAt: event.endedAt ?? null,
        externalCallId: event.externalCallId.trim(),
      })
      .onConflictDoNothing({
        target: [conversations.clinicId, conversations.externalCallId],
      })
      .returning({ id: conversations.id });

    if (!row) {
      // Already ingested. Look it up so the caller gets the same id back and a
      // retrying vendor sees success rather than an error it will retry again.
      const [existing] = await tx.db
        .select({
          id: conversations.id,
          recoveryReason: conversations.recoveryReason,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.clinicId, event.clinicId),
            eq(conversations.externalCallId, event.externalCallId.trim()),
          ),
        )
        .limit(1);

      return {
        conversationId: existing!.id,
        recoveryReason: existing!.recoveryReason,
        duplicate: true,
      };
    }

    tx.audit.record({
      action: "create",
      resourceType: "conversation",
      resourceId: row.id,
      metadata: {
        channel: "voice",
        // The classification, recorded — so a disputed monthly figure can be
        // traced to the moment the decision was made and the facts behind it.
        recoveryReason: recoveryReason ?? "none",
        disclosurePlayed: Boolean(event.disclosurePlayedAt),
      },
    });

    return { conversationId: row.id, recoveryReason, duplicate: false };
  });
}

/**
 * Find or create the caller.
 *
 * Keyed on the phone number within the clinic, because that is the only stable
 * identifier a phone call supplies. Deliberately does NOT overwrite a name that
 * already exists: a name read out of the clinic's own booking system is better
 * evidence than one a caller mumbled to a voice agent.
 */
async function upsertCaller(
  db: Transaction,
  event: VoiceCallEvent,
): Promise<string> {
  const phone = toE164(event.callerPhone) ?? event.callerPhone!.trim();

  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(eq(contacts.clinicId, event.clinicId), eq(contacts.phone, phone)),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(contacts)
    .values({
      clinicId: event.clinicId,
      phone,
      fullName: event.callerName?.trim() || null,
      updatedAt: new Date(),
    })
    .returning({ id: contacts.id });

  return created!.id;
}
