import { audienceFor } from "@healdesk/catalog";

import type { SetupScreenId } from "./screen-ids";
import type { SetupState } from "./state";

/**
 * What skipping each screen costs, said beside "Skip for now" (spec, "No
 * dead ends"), worded from what is stored for this clinic, never from an
 * empty practice: on the funnel's main path the website read has already
 * filled step 1, and skipping then keeps what was read, unchecked.
 *
 * Three screens hold the whole build: a priced service, confirmed hours and
 * the most-asked question are what "Your answers set up" needs
 * (tracker.ts, answersMissing), and until they are there the practice
 * questions ask nothing, so no channel can go live. A skip that leaves one
 * of them missing says so (NOT_BUILT), with where it is put right: hours in
 * Knowledge as well as here; the most-asked question only here, since
 * Knowledge has no field for it (Setup's step list, and Home's "You
 * skipped" once setup is done, link back to this screen).
 */
/** How each line that holds the build begins. */
const NOT_BUILT = "AYA isn't built until";

export function skipCost(state: SetupState, screen: SetupScreenId): string {
  const voice = state.channels.some((c) => c.channel === "voice");
  const audience = audienceFor(state.clinic.specialty);
  switch (screen) {
    case "basics":
      return basicsCost(state);
    case "hours":
      return hoursCost(state);
    case "services":
      return servicesCost(state);
    case "question":
      return state.knowledge.mostAsked
        ? "AYA keeps the answer you saved."
        : `${NOT_BUILT} you add it, so no channel can go live. You can add it later from Setup.`;
    case "insurance":
      return "nothing changes now; we'll ask again before AYA answers anyone.";
    case "tone":
      return "AYA uses a warm tone and the standard greetings, which name your practice.";
    case "coverage":
      return "AYA takes the calls your team misses and every call while you're closed, the recommended setting.";
    case "direct_line":
      return "phone can't go live: the direct line is where calls go whenever AYA can't answer.";
    case "deposits":
      return "AYA books without asking for a deposit.";
    case "urgent":
      return state.clinic.regulatoryRegime === "non-hipaa"
        ? "AYA can't answer anyone until you give your emergency referral clinic."
        : voice
          ? `AYA gives ${audience} with something urgent your direct line.`
          : `AYA gives ${audience} with something urgent your main number.`;
    case "calendar":
      return "bookings arrive as requests your team confirms.";
    case "providers":
      return "AYA books any available time.";
    case "channels":
    case "backup":
      return "";
  }
}

function hoursCost(state: SetupState): string {
  if (state.clinic.openingHours && state.clinic.onboarding.hours_confirmed) {
    return "AYA keeps the hours you confirmed.";
  }
  const read = state.clinic.openingHours ? "the hours we filled in stay unconfirmed, and " : "";
  return `${read}${NOT_BUILT} your hours are confirmed, so no channel can go live. You can confirm them later in Your practice.`;
}

/** Whether the clinic has answered this screen, rather than left what we filled in. */
function answered(state: SetupState, screen: SetupScreenId): boolean {
  return state.progress.get(screen)?.outcome === "done";
}

function basicsCost(state: SetupState): string {
  const address = state.clinic.address !== null;
  const phone = state.clinic.publishedPhoneE164 !== null;
  const what =
    address && phone
      ? "the address and number"
      : address
        ? "the address"
        : phone
          ? "the number"
          : null;
  if (!what) return "AYA can't tell callers your address or the number to reach you on.";
  const source = answered(state, "basics")
    ? "you gave"
    : state.clinic.siteProfile !== null
      ? "we read from your website, unchecked"
      : "we have on file";
  const missing = !address
    ? ", and can't tell them your address"
    : !phone
      ? ", and can't tell them a number to reach you on"
      : "";
  return `AYA gives callers ${what} ${source}${missing}.`;
}

function servicesCost(state: SetupState): string {
  if (answered(state, "services")) return "AYA keeps the prices you saved.";
  const priced = state.knowledge.services.some((s) => s.priceFromUsd !== null);
  if (!priced) {
    return `${NOT_BUILT} at least one service has its price, so no channel can go live.`;
  }
  // The tracker counts prices only once this screen is saved (tracker.ts).
  return state.clinic.siteProfile !== null
    ? "the prices we read from your website stay unchecked, and AYA isn't built until you check them."
    : "the starting prices we filled in stay unchecked, and AYA isn't built until you check them.";
}
