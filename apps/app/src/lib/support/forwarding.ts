import {
  CARRIERS,
  COVERAGE_MODE_OPTIONS,
  forwardingInstructions,
  isCarrier,
  type CoverageModeId,
  type PhoneSystemType,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { readPhoneStepsNumber } from "@/lib/channels/state";
import { readSetupSettings } from "@/lib/setup/settings";
import { withTenant } from "@/lib/tenant";

/**
 * `get_forwarding_steps` (plan Part H): the codes the clinic dials to forward
 * its main line to AYA, for its own carrier and coverage mode, worded by the
 * catalog's forwardingInstructions, the same table as the wizard and O10.
 *
 * It returns NOTHING until voice is ready for the clinic: phone bought, ready
 * on our side (clinic_channels.ready_at), and AYA's number given. Until then
 * there is no number to forward to, and a clinic that forwards its line early
 * sends its callers nowhere (setup's "Don't change your call forwarding
 * yet"). The chat then says exactly that, rather than guessing at codes.
 */

export type ForwardingSteps = {
  /** AYA's number, which the codes dial: the chat's screen lets it through. */
  ayaNumberE164: string;
  carrier: string;
  mode: string;
  steps: { label: string; dial: string }[];
  undo: { label: string; dial: string }[];
  notes: string[];
  needsCarrierHelp: boolean;
};

export type ForwardingFacts = {
  /**
   * AYA's number once phone is ready on our side, and null until then: the
   * channels' own reader decides (readPhoneStepsNumber, lib/channels/state.ts),
   * the same as the wizard's and Settings' forwarding steps and O11.
   */
  phoneStepsNumberE164: string | null;
  carrier: string | null;
  phoneSystem: string | null;
  mode: CoverageModeId;
  isClosed: boolean;
};

/** Whether the forwarding steps exist for this clinic yet. */
export function voiceReadyForForwarding(facts: ForwardingFacts): boolean {
  return (
    !facts.isClosed &&
    typeof facts.phoneStepsNumberE164 === "string" &&
    /^\+[1-9]\d{6,14}$/.test(facts.phoneStepsNumberE164)
  );
}

/** The pure half: the steps, or null before voice is ready. */
export function forwardingStepsFrom(facts: ForwardingFacts): ForwardingSteps | null {
  if (!voiceReadyForForwarding(facts)) return null;
  const carrier = isCarrier(facts.carrier) ? facts.carrier : null;
  const phoneSystem: PhoneSystemType =
    facts.phoneSystem === "voip" || facts.phoneSystem === "landline"
      ? facts.phoneSystem
      : "unknown";
  const instructions = forwardingInstructions({
    carrier,
    phoneSystemType: phoneSystem,
    routing: facts.mode,
    destinationE164: facts.phoneStepsNumberE164!,
  });
  return {
    ayaNumberE164: facts.phoneStepsNumberE164!,
    carrier: CARRIERS.find((c) => c.id === carrier)?.name ?? "not given",
    mode: COVERAGE_MODE_OPTIONS.find((m) => m.id === facts.mode)?.label ?? facts.mode,
    steps: instructions.steps,
    undo: instructions.undo,
    notes: instructions.notes,
    needsCarrierHelp: instructions.needsCarrierHelp,
  };
}

/** Read the facts for clinic `clinicId` and return its steps, or null before voice is ready. */
export async function readForwardingSteps(input: {
  clinicId: string;
  actor: ActorContext;
}): Promise<ForwardingSteps | null> {
  const facts = await withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        carrier: clinics.carrier,
        phoneSystem: clinics.phoneSystemType,
        offboardingStartedAt: clinics.offboardingStartedAt,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return null;
    const settings = await readSetupSettings(tx.db, tx.clinicId);
    return {
      phoneStepsNumberE164: await readPhoneStepsNumber(tx.db, tx.clinicId),
      carrier: clinic.carrier,
      phoneSystem: clinic.phoneSystem,
      mode: settings.coverageMode,
      isClosed: clinic.offboardingStartedAt !== null,
    } satisfies ForwardingFacts;
  });
  return facts ? forwardingStepsFrom(facts) : null;
}
