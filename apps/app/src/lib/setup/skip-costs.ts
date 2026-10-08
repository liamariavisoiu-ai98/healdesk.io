import { audienceFor } from "@healdesk/catalog";

import type { SetupScreenId } from "./screen-ids";
import type { SetupState } from "./state";

/**
 * What skipping each screen costs, said beside "Skip for now" (spec, "No
 * dead ends"), worded from what is stored for this clinic, never from an
 * empty practice: on the funnel's main path the website read has already
 * filled step 1, and skipping then keeps what was read, unchecked.
 */
export function skipCost(state: SetupState, screen: SetupScreenId): string {
  const voice = state.channels.some((c) => c.channel === "voice");
  const audience = audienceFor(state.clinic.specialty);
  switch (screen) {
    case "basics":
      return basicsCost(state);
    case "hours":
      return voice
        ? "phone can't go live without your hours, and AYA can't say when you're open."
        : "AYA can't say when you're open.";
    case "services":
      return servicesCost(state);
    case "question":
      return "AYA answers your most common question less well until you add it in Knowledge.";
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
  if (!priced) return "AYA quotes no prices; she offers to book a consultation instead.";
  // The tracker counts prices only once this screen is saved (tracker.ts).
  return state.clinic.siteProfile !== null
    ? "the prices we read from your website stay unchecked, and AYA isn't built until you check them."
    : "the starting prices we filled in stay unchecked, and AYA isn't built until you check them.";
}
