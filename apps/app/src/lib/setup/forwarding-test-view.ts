import { eq } from "drizzle-orm";

import { clinics, clinicSettings, type ForwardingTestObservation } from "@/db/schema";
import { readChannelStates } from "@/lib/channels/state";
import { startForwardingTest } from "@/lib/onboarding/forwarding-test";
import type { TenantTx } from "@/lib/tenant";

import { voiceForwardingReady } from "./forwarding";
import {
  forwardingTestState,
  offersTestNow,
  type ForwardingTestState,
  type ForwardingTestView,
} from "./forwarding-test-words";

export {
  forwardingTestLine,
  forwardingTestState,
  offersTestNow,
  type ForwardingTestState,
  type ForwardingTestView,
} from "./forwarding-test-words";

/**
 * "Test it now" (plan Part E step 4): the clinic's own run of the forwarding
 * test, from the wizard's forwarding screen and from Settings → Channels.
 * The clinic opens the five-minute window (lib/onboarding/forwarding-test.ts,
 * the same window an operator opens from the ops console), rings its main
 * number from another phone, and the screen waits for the call to land and
 * says what it showed. Until then, and without any test, the phone row says
 * "Waiting for call forwarding": a call forwarded from the clinic's own line
 * meets the step by itself (observeForwardingCall).
 *
 * Offered only while phone is ready on our side, has its direct line, is not
 * live and has no passed observation: before that there is nothing to
 * forward to (spec, "The forwarding step"), and after it nothing to prove.
 * That also keeps the window, every call in which is Healdesk's own and
 * neither billed nor a first answer, to the days before phone answers
 * patients. Opening it again while it is open returns the same window.
 *
 * Business data only: whether a call arrived and whether the caller's
 * number came through. Never the time of a patient's call, nor its number.
 */

type TestFacts = {
  offboarding: boolean;
  publishedPhoneE164: string | null;
  forwardingTestUntil: Date | null;
  forwardingTestObserved: ForwardingTestObservation | null;
  /** voiceForwardingReady: ready on our side, waiting on the clinic, AYA's number and the direct line set. */
  forwardingReady: boolean;
  /** Bought, and its row's status. */
  voice: "absent" | "off" | "live" | "other";
};

async function readTestFacts(tx: TenantTx, now: Date): Promise<TestFacts | null> {
  const [clinic] = await tx.db
    .select({
      offboardingStartedAt: clinics.offboardingStartedAt,
      assistantNumberE164: clinics.assistantNumberE164,
      publishedPhoneE164: clinics.publishedPhoneE164,
      forwardingTestUntil: clinics.forwardingTestUntil,
      forwardingTestObserved: clinics.forwardingTestObserved,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;
  const [settings] = await tx.db
    .select({ directLine: clinicSettings.directLineE164 })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const voice = (await readChannelStates(tx.db, tx.clinicId, now)).find(
    (c) => c.channel === "voice",
  );
  return {
    offboarding: clinic.offboardingStartedAt !== null,
    publishedPhoneE164: clinic.publishedPhoneE164,
    forwardingTestUntil: clinic.forwardingTestUntil,
    forwardingTestObserved: clinic.forwardingTestObserved,
    forwardingReady: voiceForwardingReady({
      voice,
      assistantNumberE164: clinic.assistantNumberE164,
      directLineE164: settings?.directLine ?? null,
    }),
    voice: !voice
      ? "absent"
      : voice.status === "off"
        ? "off"
        : voice.liveAt !== null
          ? "live"
          : "other",
  };
}

/** Read the clinic's forwarding test for its phone row, inside its tenant. */
export async function readForwardingTest(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<ForwardingTestView | null> {
  const facts = await readTestFacts(tx, now);
  if (!facts || facts.offboarding || !facts.forwardingReady) return null;
  const state = forwardingTestState(facts, now);
  return { state, canTest: offersTestNow(state) && facts.publishedPhoneE164 !== null };
}

export type StartForwardingTestResult =
  { ok: true; state: ForwardingTestState } | { ok: false; message: string };

/**
 * Open the clinic's forwarding-test window, when it may: phone ready for
 * forwarding and not yet proven. Opening it while it is open returns that
 * window; a passed test is never wiped by a second click.
 */
export async function clinicStartForwardingTest(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<StartForwardingTestResult> {
  const facts = await readTestFacts(tx, now);
  if (!facts) return { ok: false, message: "No such practice." };
  if (facts.offboarding)
    return { ok: false, message: "This account has closed, so there is nothing to test." };
  if (facts.voice === "absent") return { ok: false, message: "Phone isn't part of your plan." };
  if (facts.voice === "live")
    return { ok: false, message: "Phone is live already: AYA is answering your forwarded calls." };
  if (facts.voice === "off") {
    return {
      ok: false,
      message:
        "Phone is switched off in Settings, so AYA won't answer a test call. Switch it on first.",
    };
  }
  if (!facts.forwardingReady) {
    return {
      ok: false,
      message: "Phone isn't ready for call forwarding yet, so there's nothing to test.",
    };
  }
  if (!facts.publishedPhoneE164) {
    return {
      ok: false,
      message:
        "Add your main phone number in setup first (Your practice), so the test can check the caller's number came through.",
    };
  }
  const current = forwardingTestState(facts, now);
  if (current.kind === "open" || current.kind === "passed") return { ok: true, state: current };
  const until = await startForwardingTest(tx, now);
  return { ok: true, state: { kind: "open", until: until.toISOString() } };
}
