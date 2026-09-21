import { isAfterHours, parseOpeningHours } from "@/lib/clinic/opening-hours";
import { toE164 } from "@healdesk/connectors";
import { and, eq, isNotNull } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { bookingRequests, clinics, contacts, conversations } from "@/db/schema";
import { recordSecurityEvent, type ActorContext } from "@/lib/audit";
import { createBookingRequest, notifyDesk } from "@/lib/meta/booking-requests";
import { observeForwardingCall } from "@/lib/onboarding/forwarding-test";
import type { EmailTransport } from "@/lib/reporting/deliver";
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
  /**
   * True when the vendor says the agent placed this call. healdesk is
   * inbound-only, so `ingestCall()` refuses such a call outright.
   */
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
  /** A transcript reference. Never audio: no recording is kept (21 September 2026). */
  transcriptUri?: string;
  /**
   * What the agent actually booked, when `outcome` is "booked".
   *
   * Required for the booking to count. `outcome: "booked"` on its own is a
   * label the agent set on its way out of the call, and report.ts refuses to
   * count those — deliberately. An appointment row is the evidence, and this is
   * where the facts for it come from.
   *
   * `externalId` is present only when we wrote the booking into the clinic's
   * own system and it handed an id back. Supplying it is what lets the next
   * sync land on this same row through the (clinic, source, external id) unique
   * index instead of creating a duplicate beside it.
   */
  booking?: {
    /** The time the agent extracted. The desk confirms; this is a request. */
    scheduledFor: Date;
    /** The window in the caller's own words, when the agent captured it. */
    preferredWindow?: string;
    treatment?: string;
    providerName?: string;
    /** The booking platform's id for the appointment we created. */
    externalId?: string;
    /** Which platform that id belongs to. Required alongside externalId. */
    externalSource?: string;
    depositUsd?: string;
  };
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
  /**
   * The booking request this call produced, where it produced one. Never an
   * appointment: the agent semi-confirms only, and the appointment row is
   * created when the desk confirms a slot (lib/meta/booking-requests.ts).
   */
  bookingRequestId: string | null;
};

type RecoveryReason =
  | "after_hours"
  | "line_busy"
  | "rang_unanswered"
  | "missed_call_callback";

/**
 * Decide whether this contact was genuinely recovered.
 *
 * ## The rule
 *
 * On a conditionally forwarded line — the normal setup, and the one the product
 * is sold on — the clinic's own number rings at the clinic first and only
 * reaches us when nobody picks up or the line is engaged. So **every call we
 * answer is one their receptionist did not**, at two in the afternoon exactly
 * as much as at nine at night. All of them are recovered, and this function
 * records WHICH of those things happened rather than whether anything did.
 *
 * That is a change from an earlier version, which treated an in-hours call to a
 * free line as "the clinic would have handled this anyway" and returned null.
 * Under conditional forwarding that case cannot occur: if the clinic had
 * handled it, the call would never have reached us.
 *
 * ## The one case that is not recovery
 *
 * A clinic can also point its number straight at us, with no ring at the
 * practice first — a solo operator with no front desk, typically. Then the AI
 * is not answering *instead of* anybody, and counting a routine midday call as
 * recovered would inflate the headline figure to the point of meaninglessness.
 * For those clinics only calls nobody there could have taken — outside opening
 * hours — or callbacks we placed ourselves are recovery.
 *
 * Which of the two applies is a property of the clinic's phone configuration,
 * not of the call, which is why it is read from the clinic row.
 */
export function classifyRecovery(
  event: VoiceCallEvent,
  clinic: {
    callRouting: "conditional" | "always";
    openingHours: unknown;
    timezone: string;
  },
): RecoveryReason | null {
  // Ordered most-specific first, because several can be true at once: a
  // callback placed at 9pm is both a callback and after hours, and "we rang
  // them back" is the stronger and more defensible claim.
  if (event.isCallback) return "missed_call_callback";
  if (event.clinicLineBusy) return "line_busy";

  const outsideHours = isOutsideOpeningHours(event, clinic);

  if (clinic.callRouting === "always") {
    // We are the primary answerer. Only calls nobody at the clinic could have
    // taken count — and if we do not know their hours, we cannot claim that.
    return outsideHours ? "after_hours" : null;
  }

  // Conditional forwarding: the call rang at the clinic and came to us unanswered.
  // After-hours is the more informative reason where we can establish it, and
  // rang_unanswered is the literal truth in every other case.
  if (outsideHours) return "after_hours";
  return "rang_unanswered";
}

/**
 * Whether the call arrived outside the clinic's own opening hours.
 *
 * Returns false — not "unknown" — when no schedule is on file. That is the
 * conservative direction in both routing modes: on a conditional line it
 * downgrades the reason from `after_hours` to `rang_unanswered` while still
 * counting the recovery, and on an always-forwarded line it declines to count
 * the recovery at all rather than manufacturing one out of missing setup.
 */
function isOutsideOpeningHours(
  event: VoiceCallEvent,
  clinic: { openingHours: unknown; timezone: string },
): boolean {
  if (!clinic.openingHours) return false;

  try {
    const hours = parseOpeningHours(clinic.openingHours);
    // isAfterHours returns null for "cannot tell" — an unparseable timezone, or
    // a schedule with nothing for that day. Treated as false for the same
    // reason as a missing schedule: not knowing is not evidence.
    return isAfterHours(hours, event.startedAt, clinic.timezone) === true;
  } catch {
    // A malformed schedule is a configuration bug, not evidence about the call.
    return false;
  }
}

/**
 * Did this recovered call actually produce a booking?
 *
 * Deliberately a separate question from recovery, and separately named, because
 * conflating them gets both numbers wrong at once: it understates how many
 * calls the agent caught, and overstates how well it closes them.
 *
 * The monthly report needs all three figures and they are strictly nested —
 * calls answered ⊇ calls recovered ⊇ recovered bookings — so a reader can see
 * the funnel rather than one number with no denominator.
 *
 * Note it takes the recovery reason rather than recomputing it. A booking on a
 * call we did NOT recover is a real and unremarkable thing (an always-forwarded
 * clinic booking a midday appointment), and it must not be counted here — that
 * is business the clinic would have had anyway.
 */
/**
 * Should this call produce an appointment row, and with what?
 *
 * Pure and exported so the interesting cases are tested in milliseconds without
 * a database, exactly as the reconciler's matcher is. The three refusals below
 * are the whole point: every one of them is a case where writing a row would
 * put a booking into the clinic's monthly figure that we cannot stand behind.
 */
export function bookingRequestFrom(
  event: VoiceCallEvent,
  contactId: string | null,
  clinicTimezone: string,
): { preferredWindow: string; treatment: string | null } | null {
  // Refusal 1: the call did not book. An agent that qualified someone without
  // booking them has done useful work, and it is not a booking.
  if (event.outcome !== "booked") return null;

  // Refusal 2: it "booked", but we were told nothing about when. A request
  // with no window gives the desk nothing to confirm.
  if (!event.booking) return null;

  // Refusal 3: we do not know who. booking_requests.contact_id is NOT NULL,
  // and inventing a contact to satisfy it would put a stranger in the
  // clinic's records. A caller who withheld their number gets no request.
  if (!contactId) return null;

  // The window as the caller said it, when the agent captured it; otherwise
  // the time the agent extracted, written in the clinic's own clock so the
  // desk reads "Tue 24 Sep, 2:00 PM" and not a UTC instant.
  const said = event.booking.preferredWindow?.trim().replace(/\s+/g, " ").slice(0, 120);
  const preferredWindow =
    said ||
    event.booking.scheduledFor.toLocaleString("en-US", {
      timeZone: clinicTimezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  return { preferredWindow, treatment: event.booking.treatment?.trim().slice(0, 120) || null };
}

export function classifyBooking(
  event: VoiceCallEvent,
  recoveryReason: RecoveryReason | null,
): { recovered: boolean; booked: boolean; recoveredBooking: boolean } {
  const recovered = recoveryReason !== null;
  const booked = event.outcome === "booked";

  return { recovered, booked, recoveredBooking: recovered && booked };
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
  deps: { transport?: EmailTransport } = {},
): Promise<IngestResult> {
  if (!event.externalCallId?.trim()) {
    throw new VoiceIngestError("A call id is required for idempotency.");
  }

  // Inbound-only (21 September 2026). healdesk places no calls, so a call the
  // vendor flags as placed by the agent is a misconfiguration on the vendor
  // side, not a call to record: refused before any row is written, and
  // visible as a security event so the operator switches the feature off.
  if (event.isCallback) {
    await recordSecurityEvent(unsafeDb, {
      event: "outbound_call_refused",
      actorLabel: "label" in actor ? actor.label : "serviceName" in actor ? actor.serviceName : actor.type,
      metadata: { clinicId: event.clinicId, externalCallId: event.externalCallId.trim() },
    });
    throw new VoiceIngestError(
      "Refused: healdesk is inbound-only and this call is flagged as placed by the agent. Disable callbacks in the voice vendor.",
    );
  }

  return withTenant({ clinicId: event.clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        callRouting: clinics.callRouting,
        forwardingTestUntil: clinics.forwardingTestUntil,
        publishedPhoneE164: clinics.publishedPhoneE164,
      })
      .from(clinics)
      .where(eq(clinics.id, event.clinicId))
      .limit(1);

    if (!clinic) throw new VoiceIngestError("Unknown clinic.");


    const recoveryReason = classifyRecovery(event, {
      callRouting: clinic.callRouting,
      openingHours: clinic.openingHours,
      timezone: clinic.timezone,
    });

    const contactId = event.callerPhone
      ? await upsertCaller(tx.db, event, clinic.timezone)
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
        disclosurePlayedAt: event.disclosurePlayedAt ?? null,
        recordingOptOut: event.recordingOptOut ?? false,
        responseLatencySeconds: event.responseLatencySeconds ?? null,
        startedAt: event.startedAt,
        endedAt: event.endedAt ?? null,
        externalCallId: event.externalCallId.trim(),
      })
      .onConflictDoNothing({
        target: [conversations.clinicId, conversations.externalCallId],
        // conversations_external_call_idx is PARTIAL (WHERE external_call_id is
        // not null). Postgres will only infer a partial unique index when the
        // matching predicate accompanies the conflict target, so without this
        // the statement raises 42P10 and no call is ever ingested at all. Every
        // sibling writer in sync/upsert.ts passes it for the same reason, and
        // that file's header warns about precisely this. Note the option is
        // `where` here and `targetWhere` on onConflictDoUpdate; both are the
        // index predicate, and drizzle names them differently per builder.
        where: isNotNull(conversations.externalCallId),
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

      // A retrying vendor must get the same answer, including the same
      // request. Looking it up rather than returning null keeps the reply
      // truthful, and re-inserting would ask the desk twice.
      const [priorRequest] = await tx.db
        .select({ id: bookingRequests.id })
        .from(bookingRequests)
        .where(and(eq(bookingRequests.clinicId, event.clinicId), eq(bookingRequests.conversationId, existing!.id)))
        .limit(1);

      return {
        conversationId: existing!.id,
        recoveryReason: existing!.recoveryReason,
        duplicate: true,
        bookingRequestId: priorRequest?.id ?? null,
      };
    }

    /**
     * The causation link, written by the only layer that knows it.
     *
     * Everything downstream reads `appointments.conversation_id`: report.ts
     * inner-joins on it to count bookings, reconcile-store.ts left-joins it to
     * decide which revenue was recovered. Nothing wrote it until here, which is
     * why a perfect connector would still have reported zero.
     *
     * Three conditions, all required, none of them inferred. The call has to
     * have booked something; we have to know what was booked, because an
     * appointment row with no time is not evidence of anything; and we have to
     * know who, because contact_id is NOT NULL and inventing a contact to
     * satisfy it would be worse than recording no booking at all.
     */
    let bookingRequestId: string | null = null;
    const request = bookingRequestFrom(event, contactId, clinic.timezone);
    if (request) {
      const created = await createBookingRequest(tx, {
        channel: "voice",
        contactId: contactId!,
        conversationId: row.id,
        preferredWindow: request.preferredWindow,
        treatment: request.treatment,
      });
      bookingRequestId = created.id;
      await notifyDesk(tx, created, { channel: "voice", platform: null }, { transport: deps.transport });
    }

    tx.audit.record({
      action: "create",
      resourceType: "conversation",
      resourceId: row.id,
      metadata: {
        channel: "voice",
        // Both classifications, recorded — so a disputed monthly figure can be
        // traced to the moment the decision was made and the facts behind it.
        recoveryReason: recoveryReason ?? "none",
        ...classifyBooking(event, recoveryReason),
        callRouting: clinic.callRouting,
        disclosurePlayed: Boolean(event.disclosurePlayedAt),
      },
    });

    // The forwarding test, and the caller-ID watch: after the row exists, in
    // the same transaction, so a test call that stamps the step and the
    // conversation it stamped it from commit or roll back together.
    await observeForwardingCall(tx, clinic, event, row.id);

    return { conversationId: row.id, recoveryReason, duplicate: false, bookingRequestId };
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
  clinicTimezone: string,
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
      // The caller rang a local clinic: its timezone is the best evidence we
      // have, recorded now so the quiet-hours check can run later at all.
      timezone: clinicTimezone,
      updatedAt: new Date(),
    })
    .returning({ id: contacts.id });

  return created!.id;
}
