import type { Carrier, PhoneSystemType } from "@healdesk/catalog";

/**
 * The forwarding screen's picker, client-safe: what runs the clinic's main
 * line, and the steps a choice shows. lib/setup/forwarding.ts builds the
 * steps from the catalog (forwardingInstructions); this file only chooses
 * among them, so the wizard's and Settings' pickers can run in the browser
 * without the server's modules.
 */

export type ForwardingSteps = {
  steps: { label: string; dial: string }[];
  undo: { label: string; dial: string }[];
  notes: string[];
};

export type CarrierSteps = ForwardingSteps & { id: Carrier; name: string };

/**
 * What runs the clinic's main line, as the picker offers it (spec: "The
 * clinic picks its carrier or phone system from a list"). A phone company's
 * line and "Not sure" both get the carrier picker and its star codes, as the
 * catalog treats them alike; a cloud phone system gets a forwarding rule in
 * its admin instead, and no carrier.
 */
export const PHONE_SYSTEM_OPTIONS: readonly { id: PhoneSystemType; name: string }[] = [
  { id: "landline", name: "A line from a phone company (landline or mobile)" },
  {
    id: "voip",
    name: "A cloud phone system (RingCentral, Nextiva, Dialpad, 8x8, Zoom and the like)",
  },
  { id: "unknown", name: "Not sure" },
];

export function isPhoneSystem(value: unknown): value is PhoneSystemType {
  return PHONE_SYSTEM_OPTIONS.some((o) => o.id === value);
}

/** The steps a view shows for the picker's choice. */
export function stepsFor(
  view: { carriers: readonly CarrierSteps[]; cloud: ForwardingSteps },
  phoneSystem: PhoneSystemType,
  carrier: Carrier,
): ForwardingSteps {
  if (phoneSystem === "voip") return view.cloud;
  return view.carriers.find((c) => c.id === carrier) ?? view.carriers[view.carriers.length - 1]!;
}
