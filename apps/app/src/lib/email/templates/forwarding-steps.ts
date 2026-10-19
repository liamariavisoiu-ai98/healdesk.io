import {
  CARRIERS,
  forwardingInstructions,
  type Carrier,
  type ForwardingCoverage,
  type PhoneSystemType,
} from "@healdesk/catalog";

import { formatPhone } from "@/lib/setup/help";

import type { Block } from "./compose";

/**
 * The forwarding steps an email carries (O10 and O11): AYA's number, what to
 * dial or do for the practice's carrier and how its calls should reach AYA,
 * each kind of line the carrier sells named in its own step, ending with the
 * test call, and the steps that undo it. A step with nothing to dial prints
 * as its words alone. Built here from catalog ids,
 * never stored as text: the payload holds the carrier, the phone system, the
 * routing and the number (Annex X4's allowlist), and
 * forwardingInstructions(...) words the steps, the same as the wizard's
 * forwarding screen, so an email can never print codes the screen would not.
 */

export type ForwardingFields = {
  /** AYA's number, which the practice's main line forwards to. */
  ayaNumberE164: string;
  /** The practice's carrier, when it said; null gives the catalog's "ask your carrier" steps, never a guessed code. */
  carrier: Carrier | null;
  phoneSystem: PhoneSystemType;
  /**
   * Which calls reach AYA: the clinic's coverage mode, so After hours only
   * gets its own steps. A notice queued before 14 October 2026 holds the older
   * 'conditional' or 'always', which the catalog reads as the mode it meant.
   */
  routing: ForwardingCoverage;
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
