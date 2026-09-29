import { and, count, eq, gte, isNull, or, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { consentRecords, contactAttempts, suppressions } from "@/db/schema";
import { env } from "@/lib/env";

/**
 * The gate every outbound call and text must pass.
 *
 * FCC Declaratory Ruling 24-17 (Feb 2024) confirmed that an AI-generated voice
 * is an "artificial voice" under TCPA §227(b)(1). That prong is INDEPENDENT of
 * autodialer status, so *Facebook v. Duguid* buys us nothing: every outbound
 * call our agent places needs consent, however the number was dialled.
 *
 * Statutory damages are $500–1,500 per call, uncapped, with a ready-made class.
 * So this is written to fail closed, and to explain itself — a refusal that
 * says only "not allowed" is one an engineer will be tempted to route around.
 *
 * Nothing here is vendor-specific. Whichever voice platform is chosen, these
 * rules are the same, which is why this could be built before that decision.
 */

export type ContactChannel = "voice" | "sms";

export type ContactPurpose =
  /** Appointment reminders, confirmations, pre-visit instructions. */
  | "reminder"
  /** Calling back a number that rang out. */
  | "missed_call_callback"
  /** Winning back a lapsed patient. Almost certainly marketing. */
  | "reactivation"
  /** Responding inside an active conversation the patient started. */
  | "transactional"
  /**
   * The consented callback about a booking request the person made (design
   * of 23 September 2026, §F). Transactional in nature — the person asked,
   * in so many words, to be rung back about their own request — so it is
   * patient-initiated for the frequency caps here; the dialer applies its
   * own two-per-request and four-per-number caps on top (§F.4, §F.5).
   * `outbound_calls.purpose` is the sub-purpose.
   */
  | "callback";

export type ContactDecision =
  | { allowed: true; basis: string }
  | { allowed: false; reason: string; code: ContactRefusalCode };

/**
 * The product-wide outbound switch.
 *
 * The decision of 21 September 2026 made healdesk inbound-only, and this was
 * a constant `false` that refused every request before reading a row. The
 * decision of 23 September 2026 supersedes half of it: healdesk still sends
 * no texts, no reminders and no reactivation, but it may place ONE kind of
 * call — a callback about a booking request the person made, after they
 * agreed to it in so many words on their own call or message. So the switch
 * is now an environment variable, `HEALDESK_OUTBOUND_CALLBACKS_ENABLED`,
 * read at use and never cached, and it is only the first of the gates: the
 * clinic's own switch (`clinicEnabled` below), a consent row the table
 * shape insists on, the calling window and the caps all still apply. Unset,
 * this refuses every request exactly as the constant did, so an environment
 * that has not been switched on places nothing.
 */
export function outboundContactEnabled(): boolean {
  return env.outboundCallbacksEnabled();
}

export type ContactRefusalCode =
  | "outbound_disabled"
  | "suppressed"
  | "no_consent"
  | "needs_written_consent"
  | "daily_cap"
  | "weekly_cap"
  | "quiet_hours";

/**
 * The 2015 healthcare exemption's numeric conditions.
 *
 * These are CONDITIONS OF THE EXEMPTION, not best practice. Exceed them and the
 * exemption simply does not apply — the call then needed prior express consent
 * it may not have had, retroactively.
 */
export const DAILY_CAP = 1;
export const WEEKLY_CAP = 3;

/**
 * Local-time window for outbound contact. The federal floor is 8am–9pm; the
 * decision of 23 September 2026 (§F.1) stops an hour earlier, at 8pm, and
 * never calls on a Sunday. Both are in the RECIPIENT's local time.
 */
export const QUIET_HOURS_START = 20;
export const QUIET_HOURS_END = 8;

/**
 * A callback is not dialled in the last thirty minutes before quiet hours
 * (§F.5 step 2). The vendor queues outbound calls — its reply carries an
 * `eta`, so "placed" is not "ringing" — and a call handed over at 19:55 may
 * ring at 20:05. The margin absorbs the queue; the window the person hears
 * from is 08:00–19:30.
 */
export const CALLBACK_DIAL_MARGIN_MINUTES = 30;

/**
 * Conditions of the TCPA healthcare exemption (47 CFR 64.1200(a)(9)) that the
 * caps above implement half of. The other half is on the CALLER, and every
 * outbound integration must satisfy it; they are constants here so the code
 * that places a call can assert against them rather than remember them.
 *
 *   - The message must state the name and contact number of the healthcare
 *     provider at the outset (64.1200(b)); lib/compliance/disclosure.ts
 *     builds that opener.
 *   - A voice reminder may not exceed sixty seconds, excluding opt-out
 *     instructions. An SMS reminder may not exceed one hundred sixty
 *     characters.
 *   - Every message must offer an opt-out mechanism honoured immediately
 *     (isStopRequest + suppress below).
 *   - No telemarketing, solicitation or advertising content, and no billing
 *     content — which is why "reactivation" is classed PROMOTIONAL and needs
 *     prior express WRITTEN consent instead of the exemption.
 */
export const HEALTHCARE_EXEMPTION = {
  maxVoiceReminderSeconds: 60,
  maxSmsReminderChars: 160,
  mustIdentifyProviderAtOutset: true,
  mustOfferOptOut: true,
} as const;

/**
 * The recipient's local hour, or null when it cannot be known.
 *
 * Null is a REFUSAL upstream, not a default: the quiet-hours check used to
 * be skipped when the caller did not pass an hour, which meant the one
 * control in this file that could fail open did. A timezone that cannot be
 * resolved is treated exactly like a missing opening-hours schedule in
 * lib/clinic/opening-hours.ts — as "we do not know", never as "it's fine".
 */
export function localHourIn(timezone: string | null | undefined, at: Date): number | null {
  const clock = localClockIn(timezone, at);
  return clock ? clock.hour : null;
}

/**
 * The recipient's local wall clock — hour, minute and weekday (0 = Sunday)
 * — or null when the timezone is missing or not one Intl knows.
 */
export function localClockIn(timezone: string | null | undefined, at: Date): { hour: number; minute: number; weekday: number } | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    const weekday = WEEKDAYS.indexOf((get("weekday") ?? "").toLowerCase());
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || weekday < 0) return null;
    return { hour: hour % 24, minute, weekday };
  } catch {
    return null;
  }
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const SUNDAY = 0;

/**
 * Purposes that are promotional, and therefore need prior express WRITTEN
 * consent rather than plain express consent.
 *
 * Reactivation is on this list deliberately. "We miss you, book again" is
 * marketing however warmly it is phrased, and it may also be HIPAA marketing
 * under §164.501 requiring a separate authorisation. ⚖️ counsel.
 */
const PROMOTIONAL: ReadonlySet<ContactPurpose> = new Set(["reactivation"]);

/**
 * Purposes exempt from the frequency caps because the patient initiated the
 * exchange — replying to someone's own message is not an unsolicited call.
 */
const PATIENT_INITIATED: ReadonlySet<ContactPurpose> = new Set([
  "transactional",
  "callback",
]);

export async function canContact(
  tx: Transaction,
  input: {
    clinicId: string;
    phone: string;
    channel: ContactChannel;
    purpose: ContactPurpose;
    /**
     * IANA timezone of the recipient. Required, and nullable on purpose:
     * `null` means "unknown", and unknown is refused all day rather than
     * permitted at 3am. Read it from `contacts.timezone`, which ingestion
     * fills from the clinic's own timezone.
     */
    recipientTimezone: string | null;
    /**
     * The clinic's own outbound switch (`clinics.outbound_callbacks_enabled`),
     * read by the caller inside its tenant transaction. Required, not
     * defaulted: the environment switch and this one are two keys, and
     * neither turns alone (§F.1).
     */
    clinicEnabled: boolean;
    now?: Date;
    /**
     * Evaluate the consent, cap and quiet-hours rules without authorising a
     * contact. For tests of those rules only; a caller that intends to send
     * never sets it, and both switches above still answer first.
     */
    policyOnly?: boolean;
  },
): Promise<ContactDecision> {
  const now = input.now ?? new Date();

  if (!input.policyOnly) {
    if (!outboundContactEnabled()) {
      return {
        allowed: false,
        code: "outbound_disabled",
        reason: "Outbound contact is switched off for this environment (HEALDESK_OUTBOUND_CALLBACKS_ENABLED is not \"true\").",
      };
    }
    if (!input.clinicEnabled) {
      return {
        allowed: false,
        code: "outbound_disabled",
        reason: "Outbound contact is switched off for this clinic.",
      };
    }
  }

  // 1. Suppression. Unconditional, and checked first — it outranks everything,
  //    including a consent record signed five minutes ago.
  const [suppressed] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.clinicId, input.clinicId),
        eq(suppressions.phone, input.phone),
        // NULL channel means every channel. Someone who said "stop calling"
        // has not invited a text instead.
        or(
          isNull(suppressions.channel),
          eq(suppressions.channel, input.channel),
        ),
      ),
    )
    .limit(1);

  if (suppressed) {
    return {
      allowed: false,
      code: "suppressed",
      reason: "This number is on the do-not-contact list.",
    };
  }

  // 2. Quiet hours. Recipient's local time, not ours — an 8pm campaign in
  //    California is an 11pm call in New York. Computed HERE from the
  //    timezone so no caller can leave it out, and an unknown timezone is a
  //    refusal: the only control in this file that could fail open, closed.
  //    Never on a Sunday, and a callback stops thirty minutes early because
  //    the vendor queues it (§F.1, §F.5).
  const clock = localClockIn(input.recipientTimezone, now);
  if (clock === null) {
    return {
      allowed: false,
      code: "quiet_hours",
      reason:
        "The recipient's timezone is unknown, so the quiet-hours window cannot be checked. Record contacts.timezone before contacting this number.",
    };
  }
  if (clock.weekday === SUNDAY) {
    return {
      allowed: false,
      code: "quiet_hours",
      reason: "Never on a Sunday (recipient local time).",
    };
  }
  const margin = input.purpose === "callback" ? CALLBACK_DIAL_MARGIN_MINUTES : 0;
  const minutes = clock.hour * 60 + clock.minute;
  if (minutes >= QUIET_HOURS_START * 60 - margin || minutes < QUIET_HOURS_END * 60) {
    return {
      allowed: false,
      code: "quiet_hours",
      reason: `Outside the permitted window (${QUIET_HOURS_END}:00–${QUIET_HOURS_START}:00 recipient local time${margin ? `, less a ${margin}-minute dialling margin` : ""}).`,
    };
  }

  // 3. Consent.
  const consents = await tx
    .select({ consentType: consentRecords.consentType })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.clinicId, input.clinicId),
        eq(consentRecords.phone, input.phone),
        eq(consentRecords.channel, input.channel),
        isNull(consentRecords.revokedAt),
      ),
    );

  if (consents.length === 0) {
    return {
      allowed: false,
      code: "no_consent",
      reason: "No unrevoked consent on file for this number and channel.",
    };
  }

  if (PROMOTIONAL.has(input.purpose)) {
    const written = consents.some((c) => c.consentType === "express_written");
    if (!written) {
      return {
        allowed: false,
        code: "needs_written_consent",
        reason:
          "Promotional contact requires prior express WRITTEN consent; only express consent is on file.",
      };
    }
  }

  // 4. Frequency caps. Skipped for patient-initiated exchanges.
  if (!PATIENT_INITIATED.has(input.purpose)) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [daily] = await tx
      .select({ value: count() })
      .from(contactAttempts)
      .where(
        and(
          eq(contactAttempts.clinicId, input.clinicId),
          eq(contactAttempts.phone, input.phone),
          gte(contactAttempts.attemptedAt, dayAgo),
        ),
      );

    if ((daily?.value ?? 0) >= DAILY_CAP) {
      return {
        allowed: false,
        code: "daily_cap",
        reason: `Already contacted ${daily?.value} time(s) in the last 24 hours; the healthcare exemption allows ${DAILY_CAP}.`,
      };
    }

    const [weekly] = await tx
      .select({ value: count() })
      .from(contactAttempts)
      .where(
        and(
          eq(contactAttempts.clinicId, input.clinicId),
          eq(contactAttempts.phone, input.phone),
          gte(contactAttempts.attemptedAt, weekAgo),
        ),
      );

    if ((weekly?.value ?? 0) >= WEEKLY_CAP) {
      return {
        allowed: false,
        code: "weekly_cap",
        reason: `Already contacted ${weekly?.value} time(s) in the last 7 days; the healthcare exemption allows ${WEEKLY_CAP}.`,
      };
    }
  }

  return {
    allowed: true,
    basis: `Consent on file (${consents.map((c) => c.consentType).join(", ")}), within frequency caps.`,
  };
}

/**
 * Record an attempt. Call this BEFORE dialling, not after.
 *
 * Logging afterwards means a crash mid-send leaves no trace, and the retry then
 * looks like a first attempt — which is how a bug becomes a retry storm against
 * one patient's phone, and then a class action.
 */
export async function recordAttempt(
  tx: Transaction,
  input: {
    clinicId: string;
    phone: string;
    channel: ContactChannel;
    purpose: ContactPurpose;
  },
): Promise<void> {
  await tx.insert(contactAttempts).values(input);
}

/**
 * Honour a stop request.
 *
 * Defaults to ALL channels, which is the safe reading of "stop": nobody saying
 * that means "text me instead". Pass a channel only where the request was
 * explicitly channel-specific.
 */
export async function suppress(
  tx: Transaction,
  input: {
    clinicId: string;
    phone: string;
    reason: string;
    channel?: ContactChannel;
    note?: string;
  },
): Promise<void> {
  await tx.insert(suppressions).values({
    clinicId: input.clinicId,
    phone: input.phone,
    channel: input.channel ?? null,
    reason: input.reason,
    note: input.note ?? null,
  });
}

/**
 * Phrases that must be treated as a stop request.
 *
 * Deliberately broader than the carrier-standard keywords. A patient saying
 * "please don't call me again" has revoked consent as effectively as one
 * texting STOP, and the TCPA does not require the magic word. Matching loosely
 * costs us a lead; matching narrowly costs $500 a call.
 */
const STOP_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bopt\s?out\b/i,
  /\bremove me\b/i,
  /\bdo ?n[o']?t (call|text|contact|message) me\b/i,
  /\bstop (calling|texting|contacting)\b/i,
  /\bquit\b/i,
  /\bcancel\b/i,
  /\btake me off\b/i,
  /\bno more (calls|texts|messages)\b/i,
];

export function isStopRequest(message: string): boolean {
  return STOP_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The narrower matcher for an inbound MESSAGE on a thread that holds a
 * phone number (design of 23 September 2026, §F.2).
 *
 * `isStopRequest` above is for a reply to something we sent, where "cancel"
 * and "quit" can only mean one thing. On a Meta thread the person is
 * talking to the practice about a booking, and "I need to cancel my
 * appointment" or "can I quit the waiting list" are requests for the desk,
 * not revocations of consent — treating them as a stop would suppress the
 * one number the desk has to ring back. So this list is the carrier
 * keywords plus the unmistakable phrasings, and deliberately NOT `cancel`
 * or `quit`. A match suppresses every channel and revokes the consent rows
 * for the number; tests/meta-front-door.test.ts locks the two examples.
 */
const CALLBACK_STOP_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bopt\s?out\b/i,
  /\bremove me\b/i,
  /\bdo ?n[o']?t (call|contact|message) me\b/i,
  /\bstop (calling|contacting)\b/i,
  /\btake me off\b/i,
  /\bno more (calls|messages)\b/i,
];

export function isCallbackStopRequest(message: string): boolean {
  return CALLBACK_STOP_PATTERNS.some((pattern) => pattern.test(message));
}

/** Never-expiring marker for a number we hold no consent for. */
export const NEVER_CONTACTED = sql`null`;
