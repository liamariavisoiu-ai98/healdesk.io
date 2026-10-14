/**
 * Call forwarding, as the clinic has to dial it.
 *
 * The decision (docs/v1-product-spec.md → "Voice agent behaviour"): the
 * clinic keeps its published number and forwards it to the Healdesk number,
 * which patients never see or dial directly. The voice agent that answers it
 * runs on Retell. Forwarding is either on busy and on no-answer, so staff keep
 * answering first, or unconditional, for the "All calls" coverage mode. The
 * star codes are carrier-specific and this table is the one place they live.
 * A code we are not sure of is not listed: the page says "ask your carrier"
 * rather than guessing, because a wrong code either does nothing or takes the
 * clinic's line away from its staff.
 *
 * Unconditional forwarding is never the default. It is shown for the two
 * modes that send whole stretches of time to AYA, each with its own warning.
 *
 * The spec has three coverage modes (`CoverageModeId`, which
 * clinic_settings.coverage_mode stores, the single source), and each is set
 * up differently:
 *
 *   - All calls: every call forwarded, all the time (*72 / *73 on the
 *     common landlines).
 *   - Overflow and after hours, the default: forwarded when the line is busy
 *     or nobody answers (*90 and *92 / *91 and *93). While the clinic is
 *     closed nobody answers, so the same pair covers after hours.
 *   - After hours only: every call forwarded while the clinic is closed and
 *     none while it is open. On a landline that is all-call forwarding
 *     switched on at closing and off at opening, every day
 *     (AFTER_HOURS_ONLY_LANDLINE_NOTE); its undo is all-call forwarding's
 *     (*73), never the busy and no-answer pair. A cloud phone system does it
 *     with a business-hours rule.
 *
 * `routing` takes a coverage mode, or `CallRouting`, which predates them and
 * is still what clinics.call_routing and some stored email payloads hold:
 * "always" reads as All calls and "conditional" as Overflow and after hours.
 *
 * Every degradation path (Pause AI, the allowance cap's "Stop and fall back",
 * suspension, cancellation, an outage) sends calls to a direct clinic line.
 * Once the published number forwards to us, that line cannot be the
 * published number, or the call loops back. Collecting and checking a direct
 * line is not built here either.
 */

import type { CoverageModeId } from "./assistant-settings";

export type Carrier = "verizon" | "att" | "tmobile" | "spectrum" | "comcast" | "other";
export type PhoneSystemType = "landline" | "voip" | "unknown";
export type CallRouting = "conditional" | "always";

/** Which calls reach AYA, as forwarding is set up for it: a coverage mode, or the older routing. */
export type ForwardingCoverage = CoverageModeId | CallRouting;

/** The coverage mode a forwarding input means: "always" is All calls, "conditional" the default. */
export function coverageForForwarding(routing: ForwardingCoverage): CoverageModeId {
  if (routing === "always") return "all_calls";
  if (routing === "conditional") return "overflow_after_hours";
  return routing;
}

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
  /** Which calls reach AYA: the clinic's coverage mode, or the older call routing. */
  routing: ForwardingCoverage;
  /** The Healdesk number the clinic forwards to, E.164. */
  destinationE164: string;
}): ForwardingInstruction {
  const coverage = coverageForForwarding(input.routing);
  const notes: string[] = [
    "Forwarding is reversible in one step, by you, with no call to us. The undo codes are below.",
    "Dial each code from the clinic's own line (the handset or the main line, not a cell phone).",
  ];

  if (input.phoneSystemType === "voip") {
    return {
      steps: [
        {
          label:
            coverage === "all_calls"
              ? "In your phone system's admin (RingCentral, Nextiva, Dialpad, 8x8…), set the main number's call handling to forward all calls to:"
              : coverage === "after_hours_only"
                ? "In your phone system's admin (RingCentral, Nextiva, Dialpad, 8x8…), add a business-hours rule to the main number: outside your opening hours, and on the days you're closed, forward all calls to:"
                : "In your phone system's admin (RingCentral, Nextiva, Dialpad, 8x8…), set the main number's call handling so that after it rings the front desk for 3–4 rings, or when the line is busy, it forwards to:",
          dial: input.destinationE164,
        },
        {
          label: "Ask your phone system to keep the ORIGINAL caller's number on forwarded calls (the setting is usually called \"caller ID on forwarded calls\" or \"pass through caller ID\"). Without it every call arrives from your own number.",
          dial: "",
        },
      ],
      undo: [
        {
          label:
            coverage === "after_hours_only"
              ? "Remove the after-hours rule in the same admin screen."
              : "Remove the forwarding rule in the same admin screen.",
          dial: "",
        },
      ],
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
            coverage === "all_calls"
              ? "Ask your carrier to forward all calls on the main line to:"
              : coverage === "after_hours_only"
                ? "Ask your carrier to forward all calls on the main line while you're closed (scheduled forwarding), or for the codes that switch all-call forwarding on at closing and off at opening, to:"
                : "Ask your carrier to forward calls on busy and on no-answer (after 3–4 rings) from the main line to:",
          dial: input.destinationE164,
        },
      ],
      undo: [
        {
          label:
            coverage === "after_hours_only"
              ? "Ask the carrier to remove the forwarding; or dial *73, which cancels all-call forwarding on most US landlines."
              : "Ask the carrier to remove the forwarding; or dial *73 / *91 / *93, which cancel it on most US landlines.",
          dial: "",
        },
      ],
      notes: [
        ...notes,
        "We don't know your carrier's exact codes yet, so we won't guess. Tell us who bills you for the line and this page will show the codes.",
      ],
      needsCarrierHelp: true,
    };
  }

  if (coverage === "after_hours_only") {
    return {
      steps: [
        {
          label: "Each day when you close, forward ALL calls to your assistant:",
          dial: fill(codes.alwaysOn, input.destinationE164),
        },
        {
          label: "Each day when you open, cancel it so your staff get the line back:",
          dial: codes.alwaysOff,
        },
      ],
      undo: [{ label: "Cancel all-call forwarding:", dial: codes.alwaysOff }],
      notes: [
        ...notes,
        "You chose \"After hours only\". Your staff answer every call while you're open; your assistant answers only while you're closed, and each of those counts as a call that would otherwise have rung out.",
        "On a landline this is two codes a day. Forget the first at closing and calls ring unanswered as they do today; forget the second at opening and your staff won't get the line until you dial it. Ask your carrier whether it offers scheduled forwarding, which does this for you.",
      ],
      needsCarrierHelp: false,
    };
  }

  if (coverage === "all_calls") {
    return {
      steps: [{ label: "Forward ALL calls to your assistant (your staff will not get the line back until you undo this):", dial: fill(codes.alwaysOn, input.destinationE164) }],
      undo: [{ label: "Cancel all-call forwarding:", dial: codes.alwaysOff }],
      notes: [
        ...notes,
        "You chose \"All calls\". Only after-hours calls count as calls that would otherwise have rung out in this mode.",
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
      "Your staff keep answering first. Your assistant only gets the calls they miss, and each of those counts as a call that would otherwise have rung out.",
      "Listen for the confirmation tone after each code. If your line is on a business plan (Centrex/PBX), the codes may differ — ask the carrier.",
    ],
    needsCarrierHelp: false,
  };
}
