import { and, count, eq, gte, isNull, or, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { consentRecords, contactAttempts, suppressions } from "@/db/schema";

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
  | "transactional";

export type ContactDecision =
  | { allowed: true; basis: string }
  | { allowed: false; reason: string; code: ContactRefusalCode };

/**
 * Inbound-only: decision of 21 September 2026, and a locked decision of the
 * v1 product spec ("No outbound on any product").
 *
 * healdesk places no calls and sends no texts to patients: no reminders, no
 * missed-call callbacks, no call-backs, no reactivation. The consented
 * call-back of 23 September 2026 was removed for v1. The gate below is kept,
 * as phase-two groundwork, because it is correct and because outbound is
 * scoped for phase two; while this is false it refuses every request before
 * reading a single row, so no code path can contact a patient by forgetting
 * to check. Nothing in the product calls `canContact()` today — this is the
 * guard for the day something does.
 */
export const OUTBOUND_CONTACT_ENABLED = false;

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

/** Local-time window for outbound contact. Federal floor is 8am–9pm. */
export const QUIET_HOURS_START = 21;
export const QUIET_HOURS_END = 8;

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
  if (!timezone) return null;
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    })
      .formatToParts(at)
      .find((p) => p.type === "hour")?.value;
    const n = Number(hour);
    return Number.isInteger(n) ? n % 24 : null;
  } catch {
    return null;
  }
}

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
    now?: Date;
    /**
     * Evaluate the consent, cap and quiet-hours rules without authorising a
     * contact. For tests of those rules only; a caller that intends to send
     * never sets it, and the product-wide switch above still answers first.
     */
    policyOnly?: boolean;
  },
): Promise<ContactDecision> {
  const now = input.now ?? new Date();

  if (!OUTBOUND_CONTACT_ENABLED && !input.policyOnly) {
    return {
      allowed: false,
      code: "outbound_disabled",
      reason: "healdesk is inbound-only: it places no calls and sends no texts to patients.",
    };
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
  const localHour = localHourIn(input.recipientTimezone, now);
  if (localHour === null) {
    return {
      allowed: false,
      code: "quiet_hours",
      reason:
        "The recipient's timezone is unknown, so the quiet-hours window cannot be checked. Record contacts.timezone before contacting this number.",
    };
  }
  if (localHour >= QUIET_HOURS_START || localHour < QUIET_HOURS_END) {
    return {
      allowed: false,
      code: "quiet_hours",
      reason: `Outside the permitted window (${QUIET_HOURS_END}:00–${QUIET_HOURS_START}:00 recipient local time).`,
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

/** Never-expiring marker for a number we hold no consent for. */
export const NEVER_CONTACTED = sql`null`;
