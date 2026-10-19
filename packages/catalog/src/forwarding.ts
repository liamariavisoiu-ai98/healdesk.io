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
 * Every code below is as the carrier's own page or guide gave it when each
 * was reopened on 19 October 2026, and the published guide
 * (apps/web/src/lib/content/pieces/conditional-call-forwarding.ts) cites the
 * same pages. The two must say the same thing: when a carrier changes a
 * code, change both. Until that date this table gave every landline carrier
 * the same *90/*92 family with the number appended, which is right for none
 * of them as written: Verizon's *90 and *92 forward to a number its Business
 * Office fixes, AT&T Phone wants # after the number, Spectrum's busy and
 * no-answer code is *71, and Xfinity Voice documents no busy or no-answer
 * code at all.
 *
 * One carrier often sells more than one kind of line with different codes
 * (AT&T Phone, a traditional AT&T landline and AT&T mobile; a Verizon home
 * phone and Verizon mobile; Xfinity Voice and Comcast Business). The clinic
 * picks only a carrier (`Carrier` is stored in clinics.carrier and in email
 * payloads, so it does not grow a value per kind of line), so each step
 * names the kind of line it is for whenever the kinds differ, and the clinic
 * follows the one that is its own. The labels carry it, not the notes,
 * because the emails that send these steps (O10, O11, and the undo steps in
 * a suspension or cancellation) print the steps and the undo, never the
 * notes. For the same reason the steps end with the test call, and for
 * Overflow and after hours with the warning about a machine or greeting
 * answering first, as steps with nothing to dial: they decide whether any
 * call reaches AYA, and a note would never reach the clinic's inbox. Where a
 * carrier's own documents disagree (Verizon's *42 and *41), the label says
 * so and the test call decides.
 *
 * Unconditional forwarding is never the default. It is shown for the two
 * modes that send whole stretches of time to AYA, each with its own warning.
 *
 * The spec has three coverage modes (`CoverageModeId`, which
 * clinic_settings.coverage_mode stores, the single source), and each is set
 * up differently:
 *
 *   - All calls: every call forwarded, all the time (*72 and the number on
 *     most landlines, # after it on AT&T Phone, **21* on T-Mobile).
 *   - Overflow and after hours, the default: forwarded when the line is busy
 *     or nobody answers, and on T-Mobile when the phone is off or out of
 *     range (Verizon documents its mobile *71 for busy and unanswered calls
 *     only). While the clinic is closed nobody answers, so the same codes
 *     cover after hours, provided nothing else on the line answers first: an
 *     answering machine, a voicemail box or a closed-hours greeting that
 *     picks up takes the call before the forwarding can, which a step says
 *     (ANSWERED_FIRST).
 *   - After hours only: every call forwarded while the clinic is closed and
 *     none while it is open. On a landline that is all-call forwarding
 *     switched on at closing and off at opening, every day
 *     (AFTER_HOURS_NOTES); its undo is all-call forwarding's, never the busy
 *     and no-answer codes. A cloud phone system does it with a business-hours
 *     rule.
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

/**
 * One thing to dial or do. In `dial`, `{n}` is the destination as ten
 * digits, `{1n}` as 1 and the ten digits (T-Mobile writes its codes that
 * way), and `{e164}` the destination as given, for a step that asks the
 * carrier rather than dialling a code.
 */
type Step = { label: string; dial: string };

type CarrierCodes = {
  /** All calls: everything forwarded until it is cancelled. */
  allCalls: Step[];
  /** After hours only: all-call forwarding on at closing and off at opening, for each kind of line in turn. */
  afterHours: Step[];
  /** What cancels all-call forwarding: the undo for All calls and for After hours only. */
  allOff: Step[];
  /** Overflow and after hours: busy and no-answer forwarding, and not reachable where the line has it. */
  overflow: Step[];
  /** What cancels everything `overflow` switched on. */
  overflowOff: Step[];
  /** This carrier's caveats, in every mode. */
  notes: string[];
  /** This carrier's caveats for Overflow and after hours. */
  overflowNotes: string[];
};

const ALL_CALLS = "Forward ALL calls to your assistant (your staff will not get the line back until you undo this):";
const AT_CLOSING = "Each day when you close, forward ALL calls to your assistant:";
const AT_OPENING = "Each day when you open, cancel it so your staff get the line back:";
const CANCEL_ALL = "Cancel all-call forwarding:";

/**
 * AT&T's agent line for a traditional landline's busy and no-answer
 * forwarding, which has no code (AT&T KM1000582), as AT&T prints it.
 */
const ATT_AGENT_LINE = "800.288.2020";

/**
 * Every carrier service number a step tells the clinic to call, in E.164. A
 * screen that hides phone numbers it does not know (the support chat's)
 * lets these through beside AYA's number, or the one number a traditional
 * AT&T landline needs to set up and undo its forwarding reads as hidden.
 * The test checks that no label prints a number missing from this list.
 */
export const CARRIER_SERVICE_NUMBERS: readonly string[] = ["+18002882020"];

/** On a traditional landline the carrier calls the number and forwarding starts once it is answered. */
const STAY_THEN_HANG_UP = "stay on the line until your assistant answers, which is when forwarding starts, then hang up";

/** AT&T allows a mobile line's forwarding to be changed only from the phone (AT&T KM1011513). */
const ATT_MOBILE_ONLY_FROM_PHONE = "AT&T lets forwarding be changed only from the phone itself";

const CODES: Partial<Record<Carrier, CarrierCodes>> = {
  // Verizon's star-code page for Fios Digital Voice and traditional lines,
  // the Calling Features User Guide it links to, and its mobile Call
  // Forwarding FAQs and article. *72 and *73 are the same on both kinds of
  // line; on a home phone the guide (p. 7) has Verizon call the number at
  // once and the forwarding start when that call is answered, and then hang
  // up, so the label says to stay on until the assistant answers and then
  // hang up. The same page says a toll-restricted line cannot forward to a
  // toll number, which AYA's number usually is from a traditional line, so
  // the notes name it for a line where forwarding never starts.
  //
  // Busy and no-answer on a home phone: *90 and *92 are the Fixed Option,
  // which forwards to a number the Business Office sets by service order and
  // takes no number from the keypad (guide, p. 8), so "*90{n}" did nothing
  // useful. The option that takes a number is the Variable Option, which the
  // star-code page lists as *42 and the guide as *41, both cancelled with
  // *43; neither says which is current, so the label gives *42, names *41,
  // and lets the test call decide. A clinic for which neither works is told
  // to have Verizon repoint the Fixed Option by service order, which *43
  // does not undo, so the undo says to ask Verizon to set it back. On a
  // mobile line it is *71 (No Answer/Busy Transfer), cancelled with *73;
  // Verizon documents it for busy and unanswered calls only, not for a phone
  // that is switched off, so the label says to leave the phone on.
  verizon: {
    allCalls: [
      {
        label: `Forward ALL calls to your assistant (your staff will not get the line back until you undo this). On a Verizon home phone, dial *72, then the number at the tone, and ${STAY_THEN_HANG_UP}:`,
        dial: "*72{n}",
      },
    ],
    afterHours: [
      {
        label: `Each day when you close, forward ALL calls to your assistant. On a Verizon home phone, dial *72, then the number at the tone, and ${STAY_THEN_HANG_UP}:`,
        dial: "*72{n}",
      },
      { label: AT_OPENING, dial: "*73" },
    ],
    allOff: [{ label: CANCEL_ALL, dial: "*73" }],
    overflow: [
      {
        label:
          "On a Verizon home phone (Fios Digital Voice or a traditional line), forward calls when the line is busy or nobody answers. Verizon's star-code page gives *42 for this and its Calling Features User Guide gives *41: dial *42 and the number, and if a test call doesn't reach your assistant, dial *43, then *41 and the number instead:",
        dial: "*42{n}",
      },
      {
        label:
          "On a Verizon mobile line, forward the calls you don't answer within three or four rings, or can't take because you're on another call. Verizon documents this code only for those calls, not for a phone that is switched off, so leave the phone on while you're closed, or make the test call with it switched off:",
        dial: "*71{n}",
      },
    ],
    overflowOff: [
      { label: "Cancel busy and no-answer forwarding on a Verizon home phone:", dial: "*43" },
      {
        label:
          "If Verizon pointed your home phone's busy and no-answer forwarding at your assistant by service order instead, *43 doesn't undo it: ask Verizon to set it back to where it went before.",
        dial: "",
      },
      { label: "Cancel forwarding on a Verizon mobile line:", dial: "*73" },
    ],
    notes: [
      "Verizon says its home-phone codes may not be available in all areas. On a Verizon mobile line, the confirmation after a code may sound like a busy signal.",
      "Verizon's guide says forwarded calls from a home phone may carry local or toll charges, and that a toll-restricted line can't forward to a toll number: if forwarding never starts, ask Verizon whether your line is toll restricted.",
    ],
    overflowNotes: [
      "Verizon's *90 and *92 also forward a home phone when it's busy or unanswered, but to a number Verizon's Business Office sets, not one you dial, so they won't reach your assistant unless Verizon changes that number by service order. If neither *42 nor *41 works on your line, ask Verizon to do that.",
      "Verizon's guide says its busy and no-answer forwarding isn't available in North Carolina, and that the kind you point at a number yourself isn't available everywhere.",
    ],
  },

  // AT&T Phone, AT&T's digital home service (both its plans) and AT&T Phone
  // for Business, takes the number and then # after each code that switches
  // forwarding on, and ends each cancel code with #; it also has Safe Call
  // Forwarding (*372), for a service disruption on the clinic's own line,
  // which is part of "the calls staff cannot take" as T-Mobile's not
  // reachable is. On AT&T Phone, missed-call voicemail is itself busy and
  // no-answer forwarding ("Send missed calls to voicemail or another
  // number"), so pointing *90 and *92 at AYA replaces it, and *91# and *93#
  // turn it off rather than bring voicemail back; AT&T's business help
  // (KM1181691) restores it in Voicemail Settings online, which the undo
  // says. A traditional AT&T landline takes *72 or 72#, then the number at
  // the dial tone; AT&T then calls that number and the forwarding starts
  // only if it is answered, so a confirmation tone alone does not mean it is
  // on. Its busy and no-answer forwarding has no code: AT&T sets it on a
  // call to 800.288.2020. On a mobile line, AT&T says forwarding can be
  // changed only from the phone, never online (KM1011513), and gives #21#
  // to turn it off (KM1062174) and no code to turn it on; Google's Voice
  // help gives GSM codes for AT&T Wireless, but that is not AT&T's own
  // page, so a mobile line is sent to the phone's own forwarding settings
  // rather than to AT&T, which would send it back to the phone.
  att: {
    allCalls: [
      {
        label:
          "Forward ALL calls to your assistant (your staff will not get the line back until you undo this). On AT&T Phone, AT&T's digital home and business service, press # after the number:",
        dial: "*72{n}#",
      },
      {
        label: `On a traditional AT&T landline instead, dial *72, wait for the dial tone, then the number (with 1 in front if it's a long-distance call from your line). AT&T then calls that number, and forwarding starts only once it's answered, so ${STAY_THEN_HANG_UP}:`,
        dial: "*72{n}",
      },
      {
        label: `On an AT&T mobile line, ${ATT_MOBILE_ONLY_FROM_PHONE} and gives no code to switch it on: in the phone's own call-forwarding settings (AT&T's device help for your phone shows where), forward all calls to:`,
        dial: "{e164}",
      },
    ],
    afterHours: [
      {
        label:
          "Each day when you close, forward ALL calls to your assistant. On AT&T Phone, AT&T's digital home and business service, press # after the number:",
        dial: "*72{n}#",
      },
      { label: "Each day when you open, cancel it on AT&T Phone so your staff get the line back:", dial: "*73#" },
      {
        label: `On a traditional AT&T landline instead, each day when you close, dial *72, wait for the dial tone, then the number (with 1 in front if it's a long-distance call from your line). AT&T then calls that number, and forwarding starts only once it's answered, so ${STAY_THEN_HANG_UP}:`,
        dial: "*72{n}",
      },
      { label: "On a traditional AT&T landline, each day when you open, cancel it:", dial: "*73" },
      {
        label: `On an AT&T mobile line, each day when you close, forward all calls in the phone's own call-forwarding settings (${ATT_MOBILE_ONLY_FROM_PHONE} and gives no code to switch it on), to:`,
        dial: "{e164}",
      },
      { label: "On an AT&T mobile line, each day when you open, turn it off from the phone:", dial: "#21#" },
    ],
    allOff: [
      { label: "Cancel all-call forwarding on AT&T Phone:", dial: "*73#" },
      { label: "Cancel all-call forwarding on a traditional AT&T landline:", dial: "*73" },
      { label: "Turn off forwarding on an AT&T mobile line:", dial: "#21#" },
    ],
    overflow: [
      {
        label:
          "On AT&T Phone, AT&T's digital home and business service, forward calls when the line is busy, pressing # after the number:",
        dial: "*90{n}#",
      },
      { label: "On AT&T Phone, forward calls nobody answers, pressing # after the number:", dial: "*92{n}#" },
      {
        label: "On AT&T Phone, forward calls while service on your line is disrupted (AT&T's Safe Call Forwarding):",
        dial: "*372{n}#",
      },
      {
        label: `On a traditional AT&T landline, busy and no-answer forwarding has no code: call AT&T on ${ATT_AGENT_LINE} and ask for Call Forwarding - Busy Line and Call Forwarding - Don't Answer, to:`,
        dial: "{e164}",
      },
      {
        label: `On an AT&T mobile line, ${ATT_MOBILE_ONLY_FROM_PHONE} and gives no code for busy or unanswered calls: in the phone's own call-forwarding settings, if they offer forwarding when busy, unanswered or unreachable (AT&T's device help for your phone shows where; some phones offer only all-call forwarding), forward those calls to:`,
        dial: "{e164}",
      },
    ],
    overflowOff: [
      { label: "Cancel busy forwarding on AT&T Phone:", dial: "*91#" },
      { label: "Cancel no-answer forwarding on AT&T Phone:", dial: "*93#" },
      { label: "Cancel Safe Call Forwarding on AT&T Phone:", dial: "*373#" },
      {
        label:
          "On AT&T Phone, those codes don't bring back AT&T voicemail for missed calls: to send unanswered and busy calls to voicemail again, sign in to your AT&T account, open Voicemail Settings and set No Answer and Busy Call Forwarding to Forward to Voice Mail.",
        dial: "",
      },
      {
        label: `On a traditional AT&T landline, call AT&T on ${ATT_AGENT_LINE} to remove busy and no-answer forwarding, or to set it back to your voicemail if that's where it went before.`,
        dial: "",
      },
      {
        label: `On an AT&T mobile line, turn the forwarding off in the phone's own call-forwarding settings (${ATT_MOBILE_ONLY_FROM_PHONE}).`,
        dial: "",
      },
    ],
    notes: [
      "AT&T says some calling features need a monthly subscription or carry a usage fee, and that forwarding from a traditional landline may add local and long-distance charges.",
    ],
    overflowNotes: [],
  },

  // T-Mobile's self-service short codes page: GSM codes, the number written
  // 1 and the ten digits ("1+PhoneNumber"; its calling-services page accepts
  // 10 or 11 digits, so this is the form T-Mobile shows). Overflow needs
  // not reachable (**62*) as well as busy and no reply: a phone switched off
  // at closing forwards on that condition, not on no reply. T-Mobile's own
  // words for busy are "if receiving a call while dialing out". ##004#
  // "resets call forwarding to default", which undoes all three conditional
  // codes at once, so it is the first undo: a ## code on its own erases that
  // condition's forwarding in GSM rather than returning it to T-Mobile's
  // default (usually the voicemail box, though the page says only
  // "default"), and the three single codes follow as alternatives. It is not
  // offered as the all-call undo, because the page does not say it clears
  // **21* and in GSM it does not.
  tmobile: {
    allCalls: [{ label: ALL_CALLS, dial: "**21*{1n}#" }],
    afterHours: [
      { label: AT_CLOSING, dial: "**21*{1n}#" },
      { label: AT_OPENING, dial: "##21#" },
    ],
    allOff: [{ label: CANCEL_ALL, dial: "##21#" }],
    overflow: [
      {
        label: "Forward when the phone is busy (T-Mobile says this covers a call that comes in while the phone is dialling out):",
        dial: "**67*{1n}#",
      },
      { label: "Forward when nobody answers:", dial: "**61*{1n}#" },
      { label: "Forward when the phone is off or out of signal range:", dial: "**62*{1n}#" },
    ],
    overflowOff: [
      { label: "Return T-Mobile's busy, no-answer and not-reachable forwarding to its default in one code:", dial: "##004#" },
      { label: "Or cancel busy forwarding on its own:", dial: "##67#" },
      { label: "Or cancel no-answer forwarding on its own:", dial: "##61#" },
      { label: "Or cancel forwarding when the phone is off or out of range on its own:", dial: "##62#" },
    ],
    notes: [],
    overflowNotes: [
      "If the phone is switched off while you're closed, the third code is the one that sends those calls to your assistant.",
    ],
  },

  // Spectrum's page on Spectrum Voice, its home phone service: *72 then the
  // number for all calls, *71 for unanswered or busy calls, *73 to turn off
  // either. It lists no *90 to *93 and does not mention Spectrum Business
  // Voice, whose pages answered 403, so *71 is labelled for Spectrum Voice
  // and a business line is told to ask Spectrum Business; a code that does
  // nothing there would leave overflow calls ringing out. *72 and *73 stay
  // shared, as on nearly every US landline. The full star-code guide on
  // spectrum.net is drawn by script and could not be read, which is one
  // reason every path ends in a test call.
  spectrum: {
    allCalls: [{ label: ALL_CALLS, dial: "*72{n}" }],
    afterHours: [
      { label: AT_CLOSING, dial: "*72{n}" },
      { label: AT_OPENING, dial: "*73" },
    ],
    allOff: [{ label: CANCEL_ALL, dial: "*73" }],
    overflow: [
      {
        label: "On Spectrum Voice (Spectrum's home phone service), forward calls nobody answers, and calls that come in while the line is busy:",
        dial: "*71{n}",
      },
      {
        label: "On Spectrum Business Voice, the Spectrum pages we could open give no code for this: ask Spectrum Business to forward busy and unanswered calls to:",
        dial: "{e164}",
      },
    ],
    overflowOff: [
      { label: "On Spectrum Voice, cancel forwarding (*73 turns off both kinds):", dial: "*73" },
      { label: "On Spectrum Business Voice, ask Spectrum Business to remove the forwarding.", dial: "" },
    ],
    notes: [],
    overflowNotes: [],
  },

  // Xfinity's quick reference lists *72 and *73 (and *63 and *83 for
  // selective forwarding) and no busy or no-answer code, and says forwarding
  // is not included with Unlimited Saver; Xfinity's "Use the Xfinity Voice
  // Call Forwarding feature" page (support/articles/forward-calls-with-call-
  // forwarding) adds Local With More, which is where the note's second plan
  // comes from. Its Advanced Call Forwarding is set online and rings up to
  // four numbers alongside the home phone, so AYA set up that way would
  // answer before staff could; the ask step warns against it. Comcast
  // Business's 2017 handset guides for VoiceEdge and Managed Voice give
  // *72/*73, *92/*93 for no answer and *90/*91 for busy "if call waiting is
  // not enabled", each followed by the number. So the busy and no-answer
  // codes are offered for those two services by name, and every other
  // Comcast line is told to ask.
  comcast: {
    allCalls: [{ label: ALL_CALLS, dial: "*72{n}" }],
    afterHours: [
      { label: AT_CLOSING, dial: "*72{n}" },
      { label: AT_OPENING, dial: "*73" },
    ],
    allOff: [{ label: CANCEL_ALL, dial: "*73" }],
    overflow: [
      {
        label:
          "On Comcast Business VoiceEdge or Managed Voice, forward calls when the line is busy (Comcast's guides say this applies when you're on a call and call waiting is off):",
        dial: "*90{n}",
      },
      { label: "On Comcast Business VoiceEdge or Managed Voice, forward calls nobody answers:", dial: "*92{n}" },
      {
        label:
          "On Xfinity Voice, or any other Comcast line, Comcast's pages give no code for forwarding only busy or unanswered calls: ask Comcast whether your line can do it. Don't add your assistant as a number that rings at the same time as your phones (Xfinity's Advanced Call Forwarding works that way), or it will answer before your staff can. The number to forward those calls to:",
        dial: "{e164}",
      },
    ],
    overflowOff: [
      { label: "Cancel busy forwarding on Comcast Business VoiceEdge or Managed Voice:", dial: "*91" },
      { label: "Cancel no-answer forwarding on Comcast Business VoiceEdge or Managed Voice:", dial: "*93" },
      { label: "On Xfinity Voice or any other Comcast line, ask Comcast to remove the forwarding.", dial: "" },
    ],
    notes: [
      "Xfinity says call forwarding isn't available on its Xfinity Voice Unlimited Saver and Local With More plans. On Xfinity Voice, forwarding all calls can also be switched on and off in the Voice settings on xfinity.com.",
    ],
    overflowNotes: [],
  },
};

export type ForwardingInstruction = {
  /**
   * What the clinic dials or does, in order, ending with the test call; a
   * step with an empty `dial` is one to read or do, not a code.
   */
  steps: { label: string; dial: string }[];
  /** How to undo it: a step per condition, and per kind of line where the kinds differ. */
  undo: { label: string; dial: string }[];
  /** Plain-English caveats shown with the codes. */
  notes: string[];
  /** True when we could not give exact codes and the page must say "ask your carrier". */
  needsCarrierHelp: boolean;
};

function fill(code: string, destinationE164: string): string {
  const national = destinationE164.replace(/^\+1/, "");
  return code.replace(/\{(1n|n|e164)\}/g, (_, slot: string) =>
    slot === "n" ? national : slot === "1n" ? destinationE164.replace(/^\+/, "") : destinationE164,
  );
}

const UNDO_YOURSELF = "You can undo forwarding yourself at any time, with no call to us. The undo steps are below.";

/**
 * Not "not a cell phone": on T-Mobile, and on a mobile line with any
 * carrier, the line being forwarded is the mobile, and its codes only work
 * dialled from it.
 */
const DIAL_FROM_THE_LINE =
  "Dial each code from the line you're forwarding, the clinic's main number, not from another phone. Listen for a confirmation tone or message after each one.";

const BUSINESS_SYSTEM =
  "If your line runs through a business phone system (Centrex or a PBX), the codes may differ: ask the carrier.";

/**
 * Busy and no-answer forwarding fires only when nothing else answers first,
 * so a machine or greeting that picks up at closing takes every after-hours
 * call the mode promises AYA. A step, not a note, so the emails print it.
 */
const ANSWERED_FIRST =
  "Your assistant gets a call only if nothing else answers it first. If an answering machine, a voicemail box or a closed-hours greeting on your line picks up before the forwarding does, the call stops there, so switch it off or set it to answer later than the forwarding.";

/**
 * The test call, per mode, as the last step: it is also what settles a code
 * two of a carrier's documents disagree on, and the emails print steps.
 */
const TEST_CALL: Record<CoverageModeId, string> = {
  all_calls:
    "Then test it: call your main number from a phone that isn't on the clinic's account. Your assistant should answer straight away.",
  overflow_after_hours:
    "Then test it: call your main number from a phone that isn't on the clinic's account and let it ring unanswered. Your assistant should answer. Test once while you're closed too.",
  after_hours_only:
    "Then test it on the first evening: once forwarding is on, call your main number from a phone that isn't on the clinic's account, and your assistant should answer. After cancelling it in the morning, call again: it should ring at the clinic.",
};

const ALL_CALLS_NOTE =
  "You chose \"All calls\". Only after-hours calls count as calls that would otherwise have rung out in this mode.";
const OVERFLOW_NOTE =
  "Your staff keep answering first. Your assistant only gets the calls they miss, and each of those counts as a call that would otherwise have rung out.";
const AFTER_HOURS_NOTES = [
  "You chose \"After hours only\". Your staff answer every call while you're open; your assistant answers only while you're closed, and each of those counts as a call that would otherwise have rung out.",
  "On a landline this is two codes a day. Forget the first at closing and calls ring unanswered as they do today; forget the second at opening and your staff won't get the line until you dial it. Ask your carrier whether it offers scheduled forwarding, which does this for you.",
];

export function forwardingInstructions(input: {
  carrier: Carrier | null;
  phoneSystemType: PhoneSystemType;
  /** Which calls reach AYA: the clinic's coverage mode, or the older call routing. */
  routing: ForwardingCoverage;
  /** The Healdesk number the clinic forwards to, E.164. */
  destinationE164: string;
}): ForwardingInstruction {
  const coverage = coverageForForwarding(input.routing);
  const filled = (steps: Step[]) => steps.map((s) => ({ label: s.label, dial: fill(s.dial, input.destinationE164) }));
  // The last steps on every path: nothing to dial, but they decide whether a
  // call reaches AYA at all, so they go where the emails print them.
  const last: Step[] = [...(coverage === "overflow_after_hours" ? [ANSWERED_FIRST] : []), TEST_CALL[coverage]].map(
    (label) => ({ label, dial: "" }),
  );

  if (input.phoneSystemType === "voip") {
    // A rule, not a star code: some cloud systems take *72 from a desk phone
    // (Nextiva documents it), but a rule can follow opening hours and be read
    // back on screen. Two things stop a rule reaching AYA silently: a
    // forward that waits for the far end to press a key (Zoom's "Send
    // unanswered calls to my voicemail" makes the forwarding contact press
    // 1), which an assistant answering the call will not do, and Google
    // Voice, which says forwarding to an automated system is unsupported.
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
        {
          label:
            "If your system can make whoever answers a forwarded call press a key before it connects (Zoom's \"Send unanswered calls to my voicemail\" option does this), turn that off for this rule, so calls connect straight through to your assistant.",
          dial: "",
        },
        ...last,
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
        UNDO_YOURSELF,
        "Cloud phone systems usually set forwarding as a rule in their admin or app, which is what these steps use. If your admin screen names these settings differently, send us a screenshot and we'll point at the right one.",
        "Set the rule where calls to your main number arrive: on some systems a person's own forwarding doesn't apply to calls that come in through a call group or call centre, as Nextiva says of its own.",
        "If your main number is a Google Voice number, Google says forwarding it to an automated system is unsupported, so talk to us before you rely on it.",
      ],
      needsCarrierHelp: false,
    };
  }

  const codes = input.carrier ? CODES[input.carrier] : undefined;
  if (!codes) {
    // No code is offered for the busy and no-answer undo: *91 and *93 are
    // wrong on Spectrum and Verizon mobile and lack AT&T Phone's #, so a
    // guess there would leave the line forwarded. *73 cancels all-call
    // forwarding on every landline listed above, with # on AT&T Phone.
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
        ...last,
      ],
      undo: [
        {
          label:
            coverage === "overflow_after_hours"
              ? "Ask the carrier to remove the forwarding: the codes that cancel busy and no-answer forwarding differ from carrier to carrier."
              : "Ask the carrier to remove the forwarding; or dial *73, which cancels all-call forwarding on most US landlines (on some digital lines it is *73#).",
          dial: "",
        },
      ],
      notes: [
        UNDO_YOURSELF,
        DIAL_FROM_THE_LINE,
        "We don't know your carrier's exact codes yet, so we won't guess. Tell us who bills you for the line and this page will show the codes.",
      ],
      needsCarrierHelp: true,
    };
  }

  const shared = [UNDO_YOURSELF, DIAL_FROM_THE_LINE];
  const after = [...codes.notes, BUSINESS_SYSTEM];

  if (coverage === "after_hours_only") {
    return {
      steps: [...filled(codes.afterHours), ...last],
      undo: filled(codes.allOff),
      notes: [...shared, ...AFTER_HOURS_NOTES, ...after],
      needsCarrierHelp: false,
    };
  }

  if (coverage === "all_calls") {
    return {
      steps: [...filled(codes.allCalls), ...last],
      undo: filled(codes.allOff),
      notes: [...shared, ALL_CALLS_NOTE, ...after],
      needsCarrierHelp: false,
    };
  }

  return {
    steps: [...filled(codes.overflow), ...last],
    undo: filled(codes.overflowOff),
    notes: [...shared, OVERFLOW_NOTE, ...codes.overflowNotes, ...after],
    needsCarrierHelp: false,
  };
}
