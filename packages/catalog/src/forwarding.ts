/**
 * Call forwarding, as the clinic has to dial it.
 *
 * The decision (docs/blockers-runbook.md): the clinic keeps its published
 * number and forwards it to the Synthflow-issued one — on busy and on
 * no-answer for "ring at the practice first", or unconditionally for "AYA
 * answers everything". The star codes are carrier-specific and this table is
 * the one place they live. A code we are not sure of is not listed: the page
 * says "ask your carrier" rather than guessing, because a wrong code either
 * does nothing or takes the clinic's line away from its staff.
 *
 * Unconditional forwarding is never the default and is shown only for the
 * "always" routing mode, with its own warning.
 */

export type Carrier = "verizon" | "att" | "tmobile" | "spectrum" | "comcast" | "other";
export type PhoneSystemType = "landline" | "voip" | "unknown";
export type CallRouting = "conditional" | "always";

export const CARRIERS: readonly { id: Carrier; name: string }[] = [
  { id: "verizon", name: "Verizon" },
  { id: "att", name: "AT&T" },
  { id: "tmobile", name: "T-Mobile" },
  { id: "spectrum", name: "Spectrum (Charter)" },
  { id: "comcast", name: "Comcast Xfinity" },
  { id: "other", name: "Other / not sure" },
];

export function isCarrier(value: unknown): value is Carrier {
  return typeof value === "string" && CARRIERS.some((c) => c.id === value);
}

type StarCodes = {
  busyOn: string;
  busyOff: string;
  noAnswerOn: string;
  noAnswerOff: string;
  alwaysOn: string;
  alwaysOff: string;
};

/**
 * `{n}` is the destination number. These are the widely published defaults
 * for each carrier's landline/wireless services; a business line on a PBX or
 * a Centrex plan may differ, which the page says out loud.
 */
const STAR_CODES: Partial<Record<Carrier, StarCodes>> = {
  verizon: { busyOn: "*90{n}", busyOff: "*91", noAnswerOn: "*92{n}", noAnswerOff: "*93", alwaysOn: "*72{n}", alwaysOff: "*73" },
  att: { busyOn: "*90{n}", busyOff: "*91", noAnswerOn: "*92{n}", noAnswerOff: "*93", alwaysOn: "*72{n}", alwaysOff: "*73" },
  spectrum: { busyOn: "*90{n}", busyOff: "*91", noAnswerOn: "*92{n}", noAnswerOff: "*93", alwaysOn: "*72{n}", alwaysOff: "*73" },
  comcast: { busyOn: "*90{n}", busyOff: "*91", noAnswerOn: "*92{n}", noAnswerOff: "*93", alwaysOn: "*72{n}", alwaysOff: "*73" },
  // T-Mobile wireless uses GSM forwarding codes rather than the *9x family.
  tmobile: { busyOn: "**67*{n}#", busyOff: "##67#", noAnswerOn: "**61*{n}#", noAnswerOff: "##61#", alwaysOn: "**21*{n}#", alwaysOff: "##21#" },
};

export type ForwardingInstruction = {
  /** What the clinic dials, in order. */
  steps: { label: string; dial: string }[];
  /** How to undo it, in one step per condition. */
  undo: { label: string; dial: string }[];
  /** Plain-English caveats shown with the codes. */
  notes: string[];
  /** True when we could not give exact codes and the page must say "ask your carrier". */
  needsCarrierHelp: boolean;
};

function fill(code: string, number: string): string {
  return code.replace("{n}", number.replace(/^\+1/, ""));
}

export function forwardingInstructions(input: {
  carrier: Carrier | null;
  phoneSystemType: PhoneSystemType;
  routing: CallRouting;
  /** The Synthflow number, E.164. */
  destinationE164: string;
}): ForwardingInstruction {
  const notes: string[] = [
    "Forwarding is reversible in one step, by you, with no call to us. The undo codes are below.",
    "Dial each code from the clinic's own line (the handset or the main line, not a cell phone).",
  ];

  if (input.phoneSystemType === "voip") {
    return {
      steps: [
        {
          label:
            input.routing === "always"
              ? "In your phone system's admin (RingCentral, Nextiva, Dialpad, 8x8…), set the main number's call handling to forward all calls to:"
              : "In your phone system's admin (RingCentral, Nextiva, Dialpad, 8x8…), set the main number's call handling so that after it rings the front desk for 3–4 rings, or when the line is busy, it forwards to:",
          dial: input.destinationE164,
        },
        {
          label: "Ask your phone system to keep the ORIGINAL caller's number on forwarded calls (the setting is usually called \"caller ID on forwarded calls\" or \"pass through caller ID\"). Without it every call arrives from your own number.",
          dial: "",
        },
      ],
      undo: [{ label: "Remove the forwarding rule in the same admin screen.", dial: "" }],
      notes: [
        ...notes,
        "Cloud phone systems forward by rule, not by star code. If your admin screen names these settings differently, send us a screenshot and we'll point at the right one.",
      ],
      needsCarrierHelp: false,
    };
  }

  const codes = input.carrier ? STAR_CODES[input.carrier] : undefined;
  if (!codes) {
    return {
      steps: [
        {
          label:
            input.routing === "always"
              ? "Ask your carrier to forward all calls on the main line to:"
              : "Ask your carrier to forward calls on busy and on no-answer (after 3–4 rings) from the main line to:",
          dial: input.destinationE164,
        },
      ],
      undo: [{ label: "Ask the carrier to remove the forwarding; or dial *73 / *91 / *93, which cancel it on most US landlines.", dial: "" }],
      notes: [
        ...notes,
        "We don't know your carrier's exact codes yet, so we won't guess. Tell us who bills you for the line and this page will show the codes.",
      ],
      needsCarrierHelp: true,
    };
  }

  if (input.routing === "always") {
    return {
      steps: [{ label: "Forward ALL calls to AYA (your staff will not get the line back until you undo this):", dial: fill(codes.alwaysOn, input.destinationE164) }],
      undo: [{ label: "Cancel all-call forwarding:", dial: codes.alwaysOff }],
      notes: [
        ...notes,
        "You chose \"AYA answers everything\". Only after-hours calls count as recovered on your report in this mode.",
      ],
      needsCarrierHelp: false,
    };
  }

  return {
    steps: [
      { label: "Forward when the line is busy:", dial: fill(codes.busyOn, input.destinationE164) },
      { label: "Forward when nobody answers (after 3–4 rings):", dial: fill(codes.noAnswerOn, input.destinationE164) },
    ],
    undo: [
      { label: "Cancel busy forwarding:", dial: codes.busyOff },
      { label: "Cancel no-answer forwarding:", dial: codes.noAnswerOff },
    ],
    notes: [
      ...notes,
      "Your staff keep answering first. AYA only gets the calls they miss, and every one of those counts as recovered on your report.",
      "Listen for the confirmation tone after each code. If your line is on a business plan (Centrex/PBX), the codes may differ — ask the carrier.",
    ],
    needsCarrierHelp: false,
  };
}
