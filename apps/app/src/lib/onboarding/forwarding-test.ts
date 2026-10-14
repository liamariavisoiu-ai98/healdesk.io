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
 */
export const FORWARDING_TEST_WINDOW_MS = 5 * 60 * 1000;

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

export type ForwardingOutcome = "ignored" | "passed" | "failed" | "caller_id_lost";

function condition(event: VoiceCallEvent): ForwardingTestObservation["condition"] {
  if (event.clinicLineBusy) return "busy";
  if (event.rangAtClinicFirst) return "no_answer";
  if (event.rangAtClinicFirst === false) return "all";
  return "unknown";
}

/** Pure: is this call the test, and what did it show? */
export function evaluateForwardingCall(
  clinic: ForwardingClinicFacts,
  event: VoiceCallEvent,
  conversationId: string,
): { isTest: boolean; callerIsClinic: boolean; observation: ForwardingTestObservation | null } {
  const callerIsClinic = Boolean(
    event.callerPhone && clinic.publishedPhoneE164 && event.callerPhone === clinic.publishedPhoneE164,
  );
  const until = clinic.forwardingTestUntil?.getTime();
  const at = event.startedAt.getTime();
  const isTest = until !== undefined && at <= until && at >= until - FORWARDING_TEST_WINDOW_MS;
  if (!isTest) return { isTest: false, callerIsClinic, observation: null };
  return {
    isTest: true,
    callerIsClinic,
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
