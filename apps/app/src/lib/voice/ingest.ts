import { isAfterHours, parseOpeningHours } from "@/lib/clinic/opening-hours";
import { billableVoiceMinutes, DEFAULT_COVERAGE_MODE, resolveBookingRequirements, type BookingField, type CoverageModeId } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { agentConfigs, bookingRequests, clinics, clinicSettings, contacts, conversations } from "@/db/schema";
import { recordSecurityEvent, type ActorContext } from "@/lib/audit";
import { recordUsage } from "@/lib/billing/usage";
import { evaluateChannelsSafely, recordFirstAnswer, voiceFirstAnswerEvidence } from "@/lib/channels/events";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { queueTranscriptEmail, sendQueuedTranscriptNow } from "@/lib/conversations/transcript-outbox";
import { identifierRef } from "@/lib/identifier-ref";
import { describeError, log } from "@/lib/log";
import { cleanAlternatives, cleanCollectedFields, createBookingRequest } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import {
  evaluateForwardingCall,
  inForwardingTestWindow,
  isForwardingActivationCall,
  observeForwardingCall,
} from "@/lib/onboarding/forwarding-test";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import type { ForwardedFrom } from "./forwarded-from";
import { isHealdeskTestNumber } from "./test-numbers";

/**
 * Turning a finished call into the one row the whole product depends on.
 *
 * `VoiceCallEvent` is vendor-neutral. Its producer is the Retell custom-LLM
 * endpoint (lib/voice/retell.ts, run by src/voice/server.ts), which hands the
 * call over here when Retell closes the socket; and, for a call that socket
 * never recorded, the backstop (lib/voice/backstop.ts), from Retell's own
 * record of the call, ten minutes after its call-ended webhook.
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
   * How long the call lasted, in seconds, as the vendor measured it. The
   * voice minutes it bills are this rounded up per call
   * (billableVoiceMinutes); without it, the gap between `startedAt` and
   * `endedAt` is used, and without either the call is not billed.
   */
  durationSeconds?: number;
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
   * The lines that forwarded the call, as the carrier's Diversion and
   * History-Info headers name them (lib/voice/forwarded-from.ts). A call
   * forwarded from the clinic's own published line with the caller's number
   * kept is proof that its call forwarding works, and meets phone's
   * forwarding step with no test window (observeForwardingCall). Being
   * forwarded says nothing about whether the call is a first answer.
   * ⚠️ May hold PHI; read for this call only and never stored.
   */
  forwardedFrom?: readonly ForwardedFrom[];
  /**
   * True when the vendor says the agent placed this call. healdesk is
   * inbound-only (v1 spec: no outbound on any product), so `ingestCall()`
   * refuses such a call outright.
   */
  isCallback?: boolean;
  outcome?:
    | "booked"
    | "qualified_no_booking"
    | "price_shopper"
    | "escalated_to_human"
    | "spam"
    | "abandoned";
  /**
   * The urgent screen matched on the call (the Retell process sets it when
   * answerTurn says so). Kept beside `outcome`, which says
   * `escalated_to_human` for an urgent hit and a handover alike, so the
   * portal can tell them apart (conversations.urgent, drizzle/0078).
   */
  urgent?: boolean;
  treatmentInterest?: string;
  /**
   * The answer gate said answer when the call came in, so AYA answered it as
   * herself, not with the safe script for a refused call: the one kind of
   * call that can be phone's first answer (lib/channels/events.ts). Absent is
   * false.
   */
  answeredByAssistant?: boolean;
  /**
   * Proof the AI disclosure played before audio reached transcription. Absent
   * is a call AYA never spoke on (put through or closed without her opening
   * line): recorded, but billed no minutes and never counted as recovered.
   */
  disclosurePlayedAt?: Date;
  recordingOptOut?: boolean;
  responseLatencySeconds?: number;
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
    /**
     * The time the agent extracted. The desk confirms; this is a request.
     * Optional when `preferredWindow` carries the caller's words, as the
     * Retell process sends it (lib/voice/retell.ts): one of the two is needed.
     */
    scheduledFor?: Date;
    /** The window in the caller's own words, when the agent captured it. */
    preferredWindow?: string;
    /** Up to two other times, verbatim (§D.1). Cleaned like the primary; a dirty one is dropped. */
    alternativeWindows?: string[];
    treatment?: string;
    providerName?: string;
    /** The booking platform's id for the appointment we created. */
    externalId?: string;
    /** Which platform that id belongs to. Required alongside externalId. */
    externalSource?: string;
    depositUsd?: string;
  };
  /** `field_<id>` extractor values, keyed by catalogue id; validated against the clinic's set before anything is stored (§H.6). */
  collectedFields?: Record<string, string>;
  /**
   * The call's words, turn by turn, from the Retell process. Queued in the
   * transcript outbox in the same transaction as the conversation and emailed
   * to the clinic straight after (lib/conversations/transcript-outbox.ts);
   * never stored anywhere else. A call already ingested queues nothing.
   */
  transcriptTurns?: readonly TranscriptTurn[];
};

export class VoiceIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceIngestError";
  }
}

export type IngestResult = {
  conversationId: string;
  /**
   * Widened to what the database can hold: a duplicate webhook returns the
   * stored row, and rows backfilled by drizzle/0019 carry the retired value.
   * v1 never writes it (see RecoveryReason).
   */
  recoveryReason: StoredRecoveryReason | null;
  duplicate: boolean;
  /**
   * The booking request this call produced, where it produced one. Never an
   * appointment: a call that ends in a request leaves the appointment to the
   * desk's confirmation (lib/meta/booking-requests.ts); a call on which the
   * booking engine booked or took a request links what it logged (the first,
   * where the caller asked for more than one).
   */
  bookingRequestId: string | null;
  /** The transcript queued for the clinic, when the call carried one. */
  transcriptEmailId?: string | null;
};

/**
 * The schema enum still carries `missed_call_callback` (drizzle/0019); v1
 * places no calls, so nothing here produces it any more, and the v1 figure
 * "calls answered that would previously have rung out" counts only these three.
 * A row that already holds the old value (0019 backfilled some) is read back
 * as the wider schema type below, never produced.
 */
type RecoveryReason = "after_hours" | "line_busy" | "rang_unanswered";

/** What the database can hand back, which is one value wider than what v1 writes. */
type StoredRecoveryReason = RecoveryReason | "missed_call_callback";

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
 * ## The cases that are not recovery
 *
 * A clinic can also point its number straight at us, with no ring at the
 * practice first: All calls, a solo operator with no front desk, typically.
 * Then the AI is not answering *instead of* anybody, and counting a routine
 * midday call as recovered would inflate the headline figure to the point of
 * meaninglessness. For those clinics only calls nobody there could have taken
 * — outside opening hours — are recovery.
 *
 * After hours only is the same rule from the other side: every call is
 * forwarded while the clinic is closed, and none should be while it is open.
 * A call outside the hours is after-hours recovery; one inside them reached
 * us only because the forwarding was not switched off at opening, nobody at
 * the clinic had the chance to miss it, and it is not counted.
 *
 * Which applies is a property of the clinic's coverage mode
 * (clinic_settings.coverage_mode, the single source), not of the call.
 */
export function classifyRecovery(
  event: VoiceCallEvent,
  clinic: {
    coverageMode: CoverageModeId;
    openingHours: unknown;
    timezone: string;
  },
): RecoveryReason | null {
  // A call the agent placed is never recovery: healdesk places none, and
  // ingestCall() refuses one before it gets here.
  if (event.isCallback) return null;
  // Ordered most-specific first, because several can be true at once.
  if (event.clinicLineBusy) return "line_busy";

  const outsideHours = isOutsideOpeningHours(event, clinic);

  if (clinic.coverageMode !== "overflow_after_hours") {
    // We are the primary answerer: All calls always, After hours only while
    // the clinic is closed. Only calls nobody at the clinic could have taken
    // count — and if we do not know their hours, we cannot claim that.
    return outsideHours ? "after_hours" : null;
  }

  // Overflow and after hours: the call rang at the clinic and came to us unanswered.
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
export type VoiceBookingRequest = {
  preferredWindow: string;
  treatment: string | null;
  /** Each through the same cleaning as the primary (`windowIsClean`), deduplicated, at most two. */
  alternativeWindows: string[];
  /** Only ids in the clinic's requirement set, screened; the rest are in `refusedFields`. */
  collectedFields: Record<string, string>;
  refusedFields: { field: string; reason: string }[];
};

export function bookingRequestFrom(
  event: VoiceCallEvent,
  contactId: string | null,
  clinicTimezone: string,
  /** The clinic's requirement set (§H.6). Omitted, every `field_<id>` is refused as `not_required`. */
  requirements: readonly BookingField[] = [],
): VoiceBookingRequest | null {
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
  // Refusal 4: neither words nor a time.
  if (!said && !event.booking.scheduledFor) return null;
  const preferredWindow =
    said ||
    event.booking.scheduledFor!.toLocaleString("en-US", {
      timeZone: clinicTimezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  const { accepted, refused } = cleanCollectedFields(requirements, event.collectedFields);
  return {
    preferredWindow,
    treatment: event.booking.treatment?.trim().slice(0, 120) || null,
    alternativeWindows: cleanAlternatives(event.booking.alternativeWindows ?? [], [preferredWindow]),
    collectedFields: accepted,
    refusedFields: refused,
  };
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
 * Why a call is or is not counted against the clinic's voice minutes (R18).
 * Every ingested call is, apart from the calls the contracts' `first_answer`
 * rule also leaves out: Healdesk's own test calls (every call inside a
 * forwarding test's five-minute window, and a call from one of
 * HEALDESK_TEST_NUMBERS) and a call from one of the clinic's own numbers (its
 * published line, its direct line, the assistant's number, its escalation,
 * urgent-help and transfer numbers), compared as E.164 on both sides, since
 * the vendor's caller ID arrives in whatever shape the carrier gave it; a
 * call AYA never spoke on, with no opening line played (`disclosurePlayedAt`
 * absent): put through to the clinic's direct line or closed with the fixed
 * line by the pass-through or by a start that failed, the clinic's own
 * switch or our outage, never minutes she answered; and a call with no
 * length to bill. Otherwise the answer gate's decision at call time is not
 * asked again here: the safe script changed what the assistant offered on
 * the call, and she still answered it.
 */
export type VoiceMetering =
  | { minutes: number }
  | { skipped: "test_call" | "own_number" | "not_answered" | "no_duration" | "too_short" };

/**
 * Whether AYA spoke on the call: her opening line played (its disclosure
 * time), or the urgent screen matched and she said the fixed urgent reply,
 * which can be all she said when Retell dropped the opening line because
 * the caller spoke first. A call put through or closed before either was
 * not handled by her: it bills nothing and is not claimed (lib/reporting/
 * claims.ts reads the same two columns).
 */
export function ayaSpoke(event: Pick<VoiceCallEvent, "disclosurePlayedAt" | "urgent">): boolean {
  return Boolean(event.disclosurePlayedAt) || event.urgent === true;
}

/** Pure: what this call bills, from the facts the ingest already holds. */
export function voiceMeteringFor(
  event: Pick<VoiceCallEvent, "callerPhone" | "startedAt" | "endedAt" | "durationSeconds" | "disclosurePlayedAt">,
  facts: { isTestCall: boolean; ownNumbers: readonly (string | null | undefined)[] },
): VoiceMetering {
  // The test and own-number exclusions first: the first answer reads them
  // from here (voiceFirstAnswerEvidence).
  if (facts.isTestCall) return { skipped: "test_call" };
  const caller = event.callerPhone ? (toE164(event.callerPhone) ?? event.callerPhone.trim()) : null;
  if (caller && facts.ownNumbers.some((n) => n && (toE164(n) ?? n.trim()) === caller)) {
    return { skipped: "own_number" };
  }
  if (!ayaSpoke(event)) return { skipped: "not_answered" };
  const elapsed =
    event.endedAt && event.endedAt.getTime() >= event.startedAt.getTime()
      ? (event.endedAt.getTime() - event.startedAt.getTime()) / 1000
      : undefined;
  const seconds = event.durationSeconds ?? elapsed;
  if (seconds === undefined) return { skipped: "no_duration" };
  const minutes = billableVoiceMinutes(seconds);
  return minutes > 0 ? { minutes } : { skipped: "too_short" };
}

/**
 * Record a completed call.
 *
 * Idempotent on the platform's own call id: voice vendors retry webhooks, and a
 * call counted twice is a revenue figure inflated twice.
 *
 * A new call then counts its minutes against the billing clinic's allowance
 * (recordUsage), after the call's own transaction has committed and outside
 * it: the recorder locks the billing clinic's entitlements row in a
 * transaction of its own, and doing that from inside this one would hold two
 * pooled connections at once. A failure there is logged and leaves the call
 * recorded; it is under-billing, the safe direction, and the vendor is not
 * asked to retry.
 */
export async function ingestCall(
  event: VoiceCallEvent,
  actor: ActorContext = { type: "agent", serviceName: "voice-ingest" },
  deps: { transport?: EmailTransport } = {},
): Promise<IngestResult> {
  if (!event.externalCallId?.trim()) {
    throw new VoiceIngestError("A call id is required for idempotency.");
  }
  const externalCallId = event.externalCallId.trim();

  // Inbound-only (decision of 21 September 2026; v1 spec, "No outbound on any
  // product"). healdesk places no calls, so a call the vendor flags as placed
  // by the agent is a misconfiguration on the vendor side, not a call to
  // record: refused before any row is written, and visible as a security
  // event so the operator switches the feature off at the vendor.
  if (event.isCallback) {
    await recordSecurityEvent(unsafeDb, {
      event: "outbound_call_refused",
      actorLabel: "label" in actor ? actor.label : "serviceName" in actor ? actor.serviceName : actor.type,
      metadata: { clinicId: event.clinicId, externalCallId },
    });
    throw new VoiceIngestError(
      "Refused: healdesk is inbound-only and this call is flagged as placed by the agent. Disable outbound calling in the voice vendor.",
    );
  }

  const ingested = await withTenant({ clinicId: event.clinicId, actor }, async (tx): Promise<{ result: IngestResult; metering: VoiceMetering | null }> => {
    const [clinic] = await tx.db
      .select({
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        // Which calls reach AYA: the settings row's, the single source. A
        // clinic with no settings row is on the default, which is what 0056
        // left every clinic whose call_routing was not 'always'.
        coverageMode: clinicSettings.coverageMode,
        forwardingTestUntil: clinics.forwardingTestUntil,
        forwardingTestObserved: clinics.forwardingTestObserved,
        publishedPhoneE164: clinics.publishedPhoneE164,
        assistantNumberE164: clinics.assistantNumberE164,
        specialty: clinics.specialty,
        bookingRequirements: clinics.bookingRequirements,
      })
      .from(clinics)
      .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
      .where(eq(clinics.id, event.clinicId))
      .limit(1);

    if (!clinic) throw new VoiceIngestError("Unknown clinic.");
    const coverageMode = clinic.coverageMode ?? DEFAULT_COVERAGE_MODE;

    // The carrier's activation call is the clinic switching its forwarding
    // on, not a caller it would have missed, so it never counts as a call
    // that would have rung out (isForwardingActivationCall). Nor does a call
    // AYA never spoke on, with no opening line played: the caller was put
    // through to the clinic or heard the closing line, and she answered
    // nothing (voiceMeteringFor bills it nothing, and the claims leave it out).
    const recoveryReason = isForwardingActivationCall(clinic, event) || !ayaSpoke(event)
      ? null
      : classifyRecovery(event, {
          coverageMode,
          openingHours: clinic.openingHours,
          timezone: clinic.timezone,
        });

    const contactId = event.callerPhone
      ? await upsertCallerContact(tx.db, { clinicId: event.clinicId, phone: event.callerPhone, name: event.callerName, clinicTimezone: clinic.timezone })
      : null;

    const [row] = await tx.db
      .insert(conversations)
      .values({
        clinicId: event.clinicId,
        contactId,
        channel: "voice",
        recoveryReason,
        outcome: event.outcome ?? null,
        urgent: event.urgent ?? false,
        treatmentInterest: event.treatmentInterest ?? null,
        // Transcripts are emailed, never kept, and neither is a link to one.
        transcriptUri: null,
        disclosurePlayedAt: event.disclosurePlayedAt ?? null,
        recordingOptOut: event.recordingOptOut ?? false,
        responseLatencySeconds: event.responseLatencySeconds ?? null,
        startedAt: event.startedAt,
        endedAt: event.endedAt ?? null,
        externalCallId,
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
            eq(conversations.externalCallId, externalCallId),
          ),
        )
        .limit(1);

      // A retrying vendor must get the same answer, including the same
      // request. Looking it up rather than returning null keeps the reply
      // truthful, and re-inserting would ask the desk twice. A request the
      // booking engine logged on the call carries the call's booking key.
      const [priorRequest] = await tx.db
        .select({ id: bookingRequests.id })
        .from(bookingRequests)
        .where(and(eq(bookingRequests.clinicId, event.clinicId), or(eq(bookingRequests.conversationId, existing!.id), keyedToCall(externalCallId))))
        .orderBy(asc(bookingRequests.createdAt))
        .limit(1);

      return {
        result: {
          conversationId: existing!.id,
          recoveryReason: existing!.recoveryReason,
          duplicate: true,
          bookingRequestId: priorRequest?.id ?? null,
        },
        metering: null,
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
    // The booking engine (lib/booking/engine.ts) logged this call's
    // bookings and requests while the call was up, under the call's booking
    // keys: link each to the conversation (set-once) and create no second
    // request. The clinic was alerted when each was committed (the design
    // record's §6), so there is nothing to make sure of here.
    const onCall = await tx.db
      .select({ id: bookingRequests.id, bookedVia: bookingRequests.bookedVia })
      .from(bookingRequests)
      .where(and(eq(bookingRequests.clinicId, tx.clinicId), keyedToCall(externalCallId)))
      .orderBy(asc(bookingRequests.createdAt));
    if (onCall.length > 0) {
      bookingRequestId = onCall[0]!.id;
      for (const request of onCall) {
        await linkConversationOnce(tx, request.id, row.id);
        tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: request.id, metadata: { outcome: "conversation_linked", via: request.bookedVia } });
      }
    } else {
      const requirements = resolveBookingRequirements(clinic.specialty, clinic.bookingRequirements ?? null);
      const request = bookingRequestFrom(event, contactId, clinic.timezone, requirements);
      if (request) {
        for (const r of request.refusedFields) {
          tx.audit.record({ action: "create", resourceType: "booking_request", metadata: { outcome: "field_refused", field: r.field, reason: r.reason } });
        }
        const created = await createBookingRequest(tx, {
          channel: "voice",
          contactId: contactId!,
          conversationId: row.id,
          preferredWindow: request.preferredWindow,
          treatment: request.treatment,
          alternativeWindows: request.alternativeWindows,
          collectedFields: request.collectedFields,
        });
        bookingRequestId = created.id;
        // L7, in the transaction that writes the request and the call: a
        // pointer to the clinic's one address, sent after commit.
        await notifyBookingAlert(tx, "booking_request", { bookingRequestId: created.id, conversationId: row.id, channel: "voice" });
      }
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
        coverageMode,
        disclosurePlayed: Boolean(event.disclosurePlayedAt),
      },
    });

    // What the call bills, judged against the forwarding window as it stood
    // when the call arrived: observeForwardingCall below consumes it.
    const [settings] = await tx.db
      .select({
        directLine: clinicSettings.directLineE164,
        urgentHelp: clinicSettings.urgentHelpE164,
        transfer: clinicSettings.transferE164,
      })
      .from(clinicSettings)
      .where(eq(clinicSettings.clinicId, tx.clinicId))
      .limit(1);
    const [agent] = await tx.db
      .select({ escalationPhone: agentConfigs.escalationPhone })
      .from(agentConfigs)
      .where(eq(agentConfigs.clinicId, tx.clinicId))
      .limit(1);
    const metering = voiceMeteringFor(event, {
      isTestCall:
        evaluateForwardingCall(clinic, event, row.id).isTest ||
        inForwardingTestWindow(clinic, event.startedAt) ||
        isHealdeskTestNumber(event.callerPhone),
      ownNumbers: [
        clinic.publishedPhoneE164,
        settings?.directLine,
        clinic.assistantNumberE164,
        agent?.escalationPhone,
        settings?.urgentHelp,
        settings?.transfer,
      ],
    });

    // The forwarding test, a call forwarded from the clinic's own line, and
    // the caller-ID watch: after the row exists, in the same transaction, so
    // a call that stamps the step and the conversation it stamped it from
    // commit or roll back together.
    await observeForwardingCall(tx, clinic, event, row.id);

    // Channel events (lib/channels/events.ts), in the same transaction: the
    // forwarding test above may have confirmed phone's last step, and this
    // call may be phone's first answer, which records the plan start or the
    // step-up with it. Each runs in a savepoint that never throws, so neither
    // can cost the call its record, its transcript or its request; and a live
    // phone channel takes no lock at all.
    await evaluateChannelsSafely(tx, { only: "voice" });
    await recordFirstAnswer(tx, voiceFirstAnswerEvidence(event, metering, row.id));

    // The transcript, sealed in the outbox with the conversation it belongs
    // to: both commit or neither does.
    const transcriptEmailId = event.transcriptTurns?.length
      ? await queueTranscriptEmail(tx, {
          conversationId: row.id,
          channel: "voice",
          startedAt: event.startedAt,
          turns: event.transcriptTurns,
        })
      : null;

    return { result: { conversationId: row.id, recoveryReason, duplicate: false, bookingRequestId, transcriptEmailId }, metering };
  });

  const { result, metering } = ingested;
  // The clinic has the transcript in seconds; a failure here is the outbox's
  // to retry, every minute, and never the call's.
  if (result.transcriptEmailId) await sendQueuedTranscriptNow(event.clinicId, result.transcriptEmailId, { transport: deps.transport });
  if (metering && "minutes" in metering) {
    try {
      await recordUsage({
        locationClinicId: event.clinicId,
        meter: "voice_minutes",
        quantity: metering.minutes,
        source: "voice_call",
        sourceRef: identifierRef("call", event.clinicId, externalCallId),
        occurredAt: event.startedAt,
        actor,
      });
    } catch (error) {
      log.error("voice call not metered", { clinicId: event.clinicId, conversationId: result.conversationId, error: describeError(error) });
    }
  } else if (metering?.skipped === "no_duration") {
    // The payload carried neither a duration nor an end: nothing to bill,
    // and worth seeing, because every such call is minutes given away.
    log.warn("voice call not metered", { clinicId: event.clinicId, conversationId: result.conversationId, reason: "no_duration" });
  }
  return result;
}

/**
 * The requests the booking engine logged on this call, by their booking key
 * (the design record's §6): the Retell process keys each booking the caller
 * asked for "retell:" + call id + ":" + n. starts_with, not LIKE: a call
 * id's underscores are LIKE wildcards.
 */
function keyedToCall(externalCallId: string) {
  return sql`starts_with(${bookingRequests.vendorCallId}, ${`retell:${externalCallId}:`})`;
}

/**
 * `booking_requests.conversation_id` is set-once (0040 trigger): null → uuid
 * is permitted exactly once, so the guard here keeps a replayed webhook from
 * tripping the trigger on a row that is already linked.
 */
async function linkConversationOnce(tx: TenantTx, requestId: string, conversationId: string): Promise<void> {
  await tx.db
    .update(bookingRequests)
    .set({ conversationId })
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId), isNull(bookingRequests.conversationId)));
}

/**
 * Find or create the caller.
 *
 * Keyed on the phone number within the clinic, because that is the only stable
 * identifier a phone call supplies. Deliberately does NOT overwrite a name that
 * already exists: a name read out of the clinic's own booking system is better
 * evidence than one a caller mumbled to a voice agent. Shared with the
 * booking engine (lib/booking/book.ts), which books the same caller on the
 * same call, so one number is one contact whichever path wrote it first.
 */
export async function upsertCallerContact(
  db: Transaction,
  input: { clinicId: string; phone: string; name?: string | null; clinicTimezone: string },
): Promise<string> {
  const phone = toE164(input.phone) ?? input.phone.trim();

  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.clinicId, input.clinicId), eq(contacts.phone, phone)))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(contacts)
    .values({
      clinicId: input.clinicId,
      phone,
      fullName: input.name?.trim() || null,
      // The caller rang a local clinic: its timezone is the best evidence we
      // have of the caller's own.
      timezone: input.clinicTimezone,
      updatedAt: new Date(),
    })
    .returning({ id: contacts.id });

  return created!.id;
}
