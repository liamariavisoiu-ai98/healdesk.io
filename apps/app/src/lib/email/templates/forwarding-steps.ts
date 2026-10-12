import {
  CARRIERS,
  forwardingInstructions,
  type CallRouting,
  type Carrier,
  type PhoneSystemType,
} from "@healdesk/catalog";

import { formatPhone } from "@/lib/setup/help";

import type { Block } from "./compose";

/**
 * The forwarding steps an email carries (O10 and O11): AYA's number, what to
 * dial from the practice's own line for its carrier and how its calls should
 * reach AYA, and the one step that undoes it. Built here from catalog ids,
 * never stored as text: the payload holds the carrier, the phone system, the
 * routing and the number (Annex X4's allowlist), and
 * forwardingInstructions(...) words the steps, the same as the wizard's
 * forwarding screen, so an email can never print codes the screen would not.
 */

export type ForwardingFields = {
  /** AYA's number, which the practice's main line forwards to. */
  ayaNumberE164: string;
  /** The practice's carrier, when it said; null shows every carrier's codes' common form. */
  carrier: Carrier | null;
  phoneSystem: PhoneSystemType;
  routing: CallRouting;
};

export function forwardingBlocks(fields: ForwardingFields): Block[] {
  const steps = forwardingInstructions({
    carrier: fields.carrier,
    phoneSystemType: fields.phoneSystem,
    routing: fields.routing,
    destinationE164: fields.ayaNumberE164,
  });
  const carrierName = fields.carrier
    ? (CARRIERS.find((c) => c.id === fields.carrier)?.name ?? null)
    : null;
  const line = (step: { label: string; dial: string }) =>
    step.dial ? `${step.label} ${step.dial}` : step.label;
  return [
    { type: "facts", rows: [["Forward calls to", formatPhone(fields.ayaNumberE164)]] },
    {
      type: "paragraph",
      text: carrierName
        ? `The steps for ${carrierName}${fields.phoneSystem === "voip" ? "'s phone system" : ""}:`
        : "The steps:",
    },
    { type: "list", items: steps.steps.map(line) },
    { type: "paragraph", text: "To undo it at any time:" },
    { type: "list", items: steps.undo.map(line) },
  ];
}
