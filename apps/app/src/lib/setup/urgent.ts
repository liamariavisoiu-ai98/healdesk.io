import { formatPhone } from "./help";
import type { SetupState } from "./state";

/**
 * The number AYA gives someone reporting a complication or something urgent,
 * after 911 (plan Part E, 2.5): the clinic's own urgent-help number, or by
 * default the direct line, or the main number for a practice without phone.
 *
 * The default is resolved when the number is READ, never copied in when the
 * screen is saved: urgent_help_e164 stays null for "use the default", so a
 * direct line changed later (with its step-up and its history row) moves the
 * urgent number with it, instead of leaving urgent callers on the old line, a
 * departed manager's mobile, say. A chat-only practice that adds phone later
 * has its main number forwarded to AYA, so a copied main number would send
 * urgent callers straight back to her.
 */

/**
 * What the urgent number is resolved from: the bought channels, the two
 * numbers in the clinic's settings, and its main number. Structural, so the
 * wizard passes its SetupState and the Meta front door the same facts read
 * in its own transaction (lib/meta/front-door.ts).
 */
type UrgentFacts = {
  channels: readonly Pick<SetupState["channels"][number], "channel">[];
  settings: Pick<SetupState["settings"], "urgentHelpE164" | "directLineE164">;
  clinic: Pick<SetupState["clinic"], "publishedPhoneE164">;
};

function hasPhone(state: UrgentFacts): boolean {
  return state.channels.some((c) => c.channel === "voice");
}

/** The default: the direct line with phone, the main number without. */
export function urgentHelpDefault(state: UrgentFacts): string | null {
  return hasPhone(state) ? state.settings.directLineE164 : state.clinic.publishedPhoneE164;
}

/** The number AYA gives urgent callers today: the clinic's own, or the default as it stands now. */
export function urgentHelpNumber(state: UrgentFacts): string | null {
  return state.settings.urgentHelpE164 ?? urgentHelpDefault(state);
}

/**
 * Wizard 2.5's field: the clinic's own number, or empty, with the default
 * named beside it (and shown as the placeholder), never typed into it, so an
 * untouched screen saves "use the default".
 */
export function urgentHelpField(state: UrgentFacts): {
  value: string;
  placeholder: string;
  hint: string;
} {
  const phone = hasPhone(state);
  const fallback = urgentHelpDefault(state);
  const which = phone ? "your direct line" : "your main number";
  const never = phone ? " AYA never gives your main number, which forwards to her." : "";
  return {
    value: state.settings.urgentHelpE164 ? formatPhone(state.settings.urgentHelpE164) : "",
    placeholder: fallback ? formatPhone(fallback) : "",
    hint: fallback
      ? `Leave it empty and AYA gives ${which}, ${formatPhone(fallback)}, and follows it if that number changes.${never}`
      : `Leave it empty and AYA gives ${which} once you add it.${never}`,
  };
}
