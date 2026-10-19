import {
  CARRIERS,
  forwardingInstructions,
  isCarrier,
  type Carrier,
  type CoverageModeId,
  type PhoneSystemType,
} from "@healdesk/catalog";

import type { ChannelState } from "@/lib/channels/state";

import {
  isPhoneSystem,
  type CarrierSteps,
  type ForwardingSteps,
} from "./forwarding-steps";
import { formatPhone } from "./help";

export type { CarrierSteps, ForwardingSteps } from "./forwarding-steps";

/**
 * Setup step 4's phone row (plan Part E), and the gate on everything in it
 * that tells a clinic to touch its call forwarding.
 *
 * Nothing about forwarding shows until voice is ready for the clinic: AYA's
 * number, the codes, the undo steps and "Email these to my office manager"
 * would otherwise send a practice's calls to an assistant that cannot answer
 * them yet (spec, "The forwarding step"). Ready means, all three:
 *
 *   - the phone channel is ready on our side and waiting on the clinic
 *     (`clinic_channels.ready_at`, which the channel events write once
 *     Retell answers on the BAA path and the pass-through test has passed);
 *   - AYA's own number is set (`clinics.assistant_number_e164`), the number
 *     the main line forwards to;
 *   - the direct line is set, so a call AYA cannot take has somewhere to go
 *     that does not forward back to us (spec, "Failure").
 *
 * Until then the row says what it waits for, in words, with no number. Once
 * the channel is live the steps are done, and Settings → Safety net keeps
 * the undo codes.
 *
 * The clinic picks what runs its main line, a phone company's line or a
 * cloud phone system, and on a phone company's line which carrier, from
 * the lists here (spec: "The clinic picks its carrier or phone system from
 * a list"). Both are saved as they are picked (lib/setup/phone-line.ts), so the steps
 * emailed on (O11, lib/notices/steps-sent.ts) are the ones on the screen.
 *
 * The view is pure: the page reads the facts. The O11 email is given the
 * number only by a server action that asks this same question.
 */

export type ForwardingFacts = {
  voice: Pick<ChannelState, "status" | "readyAt"> | undefined;
  assistantNumberE164: string | null;
  directLineE164: string | null;
};

/** Whether the phone row may show AYA's number and the forwarding steps. */
export function voiceForwardingReady(facts: ForwardingFacts): boolean {
  return (
    facts.voice !== undefined &&
    facts.voice.status === "waiting" &&
    facts.voice.readyAt !== null &&
    facts.assistantNumberE164 !== null &&
    facts.directLineE164 !== null
  );
}

/** Why the phone row shows no steps yet, once the channel is ready but the direct line is not set. */
export function waitsOnDirectLine(facts: ForwardingFacts): boolean {
  return (
    facts.voice !== undefined &&
    facts.voice.status === "waiting" &&
    facts.assistantNumberE164 !== null &&
    facts.directLineE164 === null
  );
}

export type ForwardingView = {
  ayaNumberE164: string;
  /** AYA's number as people write it: "(512) 555-0142". */
  ayaNumber: string;
  /** The carrier the clinic named, or "other" when it named none. */
  carrier: Carrier;
  phoneSystem: PhoneSystemType;
  /** The coverage mode these steps are for. */
  coverageMode: CoverageModeId;
  /** Each carrier's steps for a phone company's line in this coverage mode, for the picker. */
  carriers: CarrierSteps[];
  /** The steps for a cloud phone system in this coverage mode. */
  cloud: ForwardingSteps;
};

/** The forwarding screen's content, for a clinic voiceForwardingReady says is ready. */
export function forwardingView(input: {
  assistantNumberE164: string;
  carrier: string | null;
  phoneSystemType: string | null;
  coverageMode: CoverageModeId;
}): ForwardingView {
  const phoneSystem: PhoneSystemType = isPhoneSystem(input.phoneSystemType)
    ? input.phoneSystemType
    : "unknown";
  const steps = (carrier: Carrier | null, system: PhoneSystemType): ForwardingSteps => {
    const found = forwardingInstructions({
      carrier,
      phoneSystemType: system,
      routing: input.coverageMode,
      destinationE164: input.assistantNumberE164,
    });
    return { steps: found.steps, undo: found.undo, notes: found.notes };
  };
  return {
    ayaNumberE164: input.assistantNumberE164,
    ayaNumber: formatPhone(input.assistantNumberE164),
    carrier: isCarrier(input.carrier) ? input.carrier : "other",
    phoneSystem,
    coverageMode: input.coverageMode,
    carriers: CARRIERS.map(({ id, name }) => ({
      id,
      name,
      ...steps(id === "other" ? null : id, "landline"),
    })),
    cloud: steps(null, "voip"),
  };
}
