import { eq } from "drizzle-orm";

import { clinics, type ForwardingTestObservation } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";
import type { VoiceCallEvent } from "@/lib/voice/ingest";

import { completeStep, readOnboarding, reopenStep } from "./steps";

/**
 * The forwarding test: proof that the clinic's line reaches us with the
 * caller's number intact.
 *
 * An operator opens a short window from the onboarding page and rings the
 * clinic's published number from another phone (or lets it ring out). The
 * first call to arrive inside the window is the test. Three facts are
 * recorded — it arrived, the caller ID survived the forward, and which
 * condition fired where the carrier told us — and `test_call_passed` is
 * stamped only when the caller ID survived. If it did not, every caller
 * would look like the clinic: the agent could not identify the caller or
 * read back their number, and the clinic's own follow-up would reach nobody,
 * so the step stays open with the reason on the page.
 *
 * Separately, and at any time: a call whose caller ID IS the clinic's own
 * published number is the carrier substituting the forwarding line. That
 * reopens the step on its own — the carrier changed something, and the
 * clinic should hear about it before calls stop counting as answered.
 *
 * One such call is expected, and neither rule reads it: the carrier's
 * activation call (isForwardingActivationCall).
 */
export const FORWARDING_TEST_WINDOW_MS = 5 * 60 * 1000;

/**
 * The carrier's activation call. On a Verizon home phone and a traditional
 * AT&T landline, switching all-call forwarding on makes the carrier ring the
 * forwarding number from the clinic's own line, and forwarding starts only
 * once that call is answered, so the catalog's step tells the clinic to stay
 * on until AYA answers and then hang up (packages/catalog/src/forwarding.ts,
 * STAY_THEN_HANG_UP). It carries the clinic's own number as caller ID by
 * design, and nobody speaks on it; under After hours only it comes every
 * evening at closing. Read as caller-ID loss, it reopened `test_call_passed`
 * every day, switching the Go live gate off again and hiding a real loss
 * among daily false alarms, and inside a test window it used the window up
 * before the real test call arrived. It is not a call that would have rung
 * out either. So a call from the clinic's own number in which the caller
 * never spoke (the Retell process's `abandoned`, with no caller turn) is
 * none of those. A forwarded caller whose ID was lost and who hung up
 * without a word looks the same, and nothing is missed by passing over it:
 * the next call in which a caller speaks is judged as before.
 */
export function isForwardingActivationCall(
  clinic: { publishedPhoneE164: string | null },
  event: Pick<VoiceCallEvent, "callerPhone" | "outcome" | "transcriptTurns">,
): boolean {
  return (
    callerIsClinicNumber(clinic, event) &&
    event.outcome === "abandoned" &&
    !event.transcriptTurns?.some((turn) => turn.speaker === "person")
  );
}

function callerIsClinicNumber(
  clinic: { publishedPhoneE164: string | null },
  event: Pick<VoiceCallEvent, "callerPhone">,
): boolean {
  return Boolean(
    event.callerPhone && clinic.publishedPhoneE164 && event.callerPhone === clinic.publishedPhoneE164,
  );
}

export async function startForwardingTest(tx: TenantTx, now: Date = new Date()): Promise<Date> {
  const until = new Date(now.getTime() + FORWARDING_TEST_WINDOW_MS);
  await tx.db
    .update(clinics)
    .set({ forwardingTestUntil: until, forwardingTestObserved: null, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_forwarding_test",
    resourceId: tx.clinicId,
    metadata: { started: true, windowMinutes: FORWARDING_TEST_WINDOW_MS / 60_000 },
  });
  return until;
}

export type ForwardingClinicFacts = {
  forwardingTestUntil: Date | null;
  publishedPhoneE164: string | null;
};

/**
 * Whether a call that started at `at` is inside a forwarding test's window:
 * the window open now, or the one that observed its first call, until it
 * ended. The first call closes the open window (observeForwardingCall), but
 * the operator may ring again from another phone inside the same five
 * minutes, and every one of those calls is Healdesk's own: none is billed as
 * minutes or counted as phone's first answer (lib/channels/events.ts).
 */
export function inForwardingTestWindow(
  clinic: { forwardingTestUntil: Date | null; forwardingTestObserved?: ForwardingTestObservation | null },
  at: Date,
): boolean {
  const ends = [
    clinic.forwardingTestUntil?.getTime(),
    clinic.forwardingTestObserved?.windowUntil
      ? Date.parse(clinic.forwardingTestObserved.windowUntil)
      : undefined,
  ];
  const t = at.getTime();
  return ends.some(
    (end) => end !== undefined && !Number.isNaN(end) && t <= end && t >= end - FORWARDING_TEST_WINDOW_MS,
  );
}

export type ForwardingOutcome = "ignored" | "activation_call" | "passed" | "failed" | "caller_id_lost";

function condition(event: VoiceCallEvent): ForwardingTestObservation["condition"] {
  if (event.clinicLineBusy) return "busy";
  if (event.rangAtClinicFirst) return "no_answer";
  if (event.rangAtClinicFirst === false) return "all";
  return "unknown";
}

/**
 * Pure: is this call the test, and what did it show? The carrier's
 * activation call is never the test, and leaves an open window open for the
 * call that is.
 */
export function evaluateForwardingCall(
  clinic: ForwardingClinicFacts,
  event: VoiceCallEvent,
  conversationId: string,
): {
  isTest: boolean;
  callerIsClinic: boolean;
  activationCall: boolean;
  observation: ForwardingTestObservation | null;
} {
  const callerIsClinic = callerIsClinicNumber(clinic, event);
  const activationCall = isForwardingActivationCall(clinic, event);
  const until = clinic.forwardingTestUntil?.getTime();
  const at = event.startedAt.getTime();
  const isTest =
    !activationCall && until !== undefined && at <= until && at >= until - FORWARDING_TEST_WINDOW_MS;
  if (!isTest) return { isTest: false, callerIsClinic, activationCall, observation: null };
  return {
    isTest: true,
    callerIsClinic,
    activationCall,
    observation: {
      arrivedAt: event.startedAt.toISOString(),
      windowUntil: new Date(until!).toISOString(),
      conversationId,
      callerIdPreserved: Boolean(event.callerPhone) && !callerIsClinic,
      condition: condition(event),
    },
  };
}

/** Called by ingestCall() once the conversation row exists, inside its transaction. */
export async function observeForwardingCall(
  tx: TenantTx,
  clinic: ForwardingClinicFacts,
  event: VoiceCallEvent,
  conversationId: string,
): Promise<ForwardingOutcome> {
  const verdict = evaluateForwardingCall(clinic, event, conversationId);
  const now = new Date();

  if (verdict.activationCall) return "activation_call";

  if (verdict.observation) {
    await tx.db
      .update(clinics)
      .set({ forwardingTestObserved: verdict.observation, forwardingTestUntil: null, updatedAt: now })
      .where(eq(clinics.id, tx.clinicId));
    tx.audit.record({
      action: "update",
      resourceType: "clinic_forwarding_test",
      resourceId: tx.clinicId,
      metadata: {
        observed: true,
        callerIdPreserved: verdict.observation.callerIdPreserved,
        condition: verdict.observation.condition,
        conversationId,
      },
    });
    if (verdict.observation.callerIdPreserved) {
      await completeStep(tx, "test_call_passed", { at: event.startedAt, note: "test call observed" });
      return "passed";
    }
    // The step stays open; the page shows why. A test whose caller ID was
    // lost is exactly the finding the test exists to surface.
    if (verdict.callerIsClinic) await reopenIfStamped(tx);
    return "failed";
  }

  if (verdict.callerIsClinic) {
    return (await reopenIfStamped(tx)) ? "caller_id_lost" : "ignored";
  }
  return "ignored";
}

async function reopenIfStamped(tx: TenantTx): Promise<boolean> {
  const state = await readOnboarding(tx);
  if (!state.test_call_passed) return false;
  await reopenStep(tx, "test_call_passed", "a call arrived carrying the clinic's own number as caller ID");
  return true;
}
