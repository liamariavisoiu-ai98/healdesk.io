import { createHash } from "node:crypto";

import { wrap } from "./wrap";

/**
 * The central-assistant acknowledgement: what a practice accepts, in
 * Billing, before a further location is added to its account (the
 * extra-locations plan of 20 October 2026, section 3).
 *
 * The owner's decision of that day: a location is added "as long as the
 * client accepts that AYA will be a centralizer (like a call center) for all
 * of them, not a particular assistant for each". One account is one tenant,
 * with one knowledge base, one sign-in and one email address, and every
 * location in it is answered by the same AYA. A practice accepts that, and
 * that the location is its own, before the charge; nothing it already signed
 * says so in as many words. Checkout's Terms tick is deleted with the checkout
 * intent 90 days after use, and the settings history holds 64 characters and
 * no document hash, so neither is evidence of it.
 *
 * Built like the calendar election (calendar-terms.ts): the server renders it
 * from validated variables, hashes the exact bytes and stores version, hash
 * and text on an append-only row in the same transaction that marks the add
 * pending, before Stripe is asked for anything, and never takes a hash from
 * the browser. The portal shows the same words above the tick through
 * `centralAssistantAcknowledgementParts`, so what is shown and what is stored
 * cannot drift. Nothing renders it in the portal yet: the add is rewired onto
 * it in the plan's step 8.
 *
 * Four variables, and only the last one changes what is acknowledged:
 *
 *   - the practice's legal name, as on its agreement;
 *   - the location's name and address, as the practice gives them;
 *   - whether the package bought has phone. Only a package with phone
 *     carries the statement about calls, because only it forwards a line.
 *
 * Each statement is true of the first release as designed: one knowledge
 * base and price list for every location; a location after the first takes
 * booking requests only, with nothing about it reaching Google Calendar,
 * because the first release records no calendar election for it (the plan's
 * correction 16); and the price as built, where the setup fee is charged at
 * the add and the plan price joins at once only when the plan has already
 * started (correction 1). The text avoids "patient" and "client" both, so
 * the one wording is true at a veterinary practice too (audience.ts).
 *
 * `released` is the owner's release for use. 1.0.0 is not released: the
 * plan sends this wording, with the BAA's clause 11, to the same independent
 * audit the legal pages pass (the owner's rule of 19 October 2026) before
 * locations are switched on, and the switch is not on.
 *
 * To revise: add a new entry at CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS[0] with a
 * new version. Never edit a released one; a stored row's hash points at it.
 * The goldens in central-assistant-acknowledgement.test.ts pin each variant's
 * hash, so an edit in place fails the build.
 */

export const CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION = "central-assistant-acknowledgement/1.0.0";

export type CentralAssistantAcknowledgement = {
  /** e.g. "central-assistant-acknowledgement/1.0.0"; stored on each acknowledgement row. */
  version: string;
  /** When this text was published. Not when anyone accepted it. */
  publishedOn: string;
  /** Released for use by the owner. An unreleased version may be shown and tested, never recorded for a production clinic. */
  released: boolean;
  /** The statements above the tick, in order. `phoneOnly` ones are left out for a package without phone. */
  statements: readonly { id: string; text: string; phoneOnly: boolean }[];
  /**
   * The sentence the person ticks. `{{practice}}`, `{{location}}` and
   * `{{address}}` are replaced with the validated variables.
   */
  acceptance: string;
};

export const CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS: readonly CentralAssistantAcknowledgement[] = [
  // Newest first; currentCentralAssistantAcknowledgement() reads [0].
  {
    version: CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION,
    publishedOn: "2026-10-20",
    // Drafted on 2026-10-20 from the extra-locations plan, section 3, which
    // the owner approved that day ("implement the extra-locations plan
    // directly once done"). Not released until its wording audit passes.
    released: false,
    statements: [
      {
        id: "one-assistant",
        text: "One AYA, knowledge base and price list for every location; it works out or asks which location a person contacting you means.",
        phoneOnly: false,
      },
      {
        id: "one-sign-in",
        text: "One sign-in and one email address for every location. Anyone with the sign-in sees every location's conversations and bookings, and transcripts and alerts for every location go to that address.",
        phoneOnly: false,
      },
      {
        id: "calls",
        text: "This location's calls fall back to its own direct line. An urgent message that arrives before AYA knows the location gets the main location's urgent-help number.",
        phoneOnly: true,
      },
      {
        id: "requests-only",
        text: "This location takes booking requests only, and nothing about it reaches Google Calendar: your team confirms each request. A calendar for this location needs a calendar election recorded for it first.",
        phoneOnly: false,
      },
      {
        id: "price",
        text: "The price: your plan's price again, plus its setup fee once. The setup fee is charged when you add this location. If your plan has started, this location's plan price joins it at once, prorated to your renewal date; if it has not, this location's plan price starts with your plan. Allowances are pooled across your locations.",
        phoneOnly: false,
      },
    ],
    acceptance:
      "I have authority to bind {{practice}}. {{location}}, at {{address}}, is operated by " +
      "{{practice}}, the practice named in our healdesk agreement, and I accept that AYA answers " +
      "for it as one central assistant for all our locations, like a call centre, not as a " +
      "separate assistant for each location.",
  },
] as const;

export function currentCentralAssistantAcknowledgement(): CentralAssistantAcknowledgement {
  return CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS[0]!;
}

export function getCentralAssistantAcknowledgement(
  version: string,
): CentralAssistantAcknowledgement | undefined {
  return CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS.find((a) => a.version === version);
}

/** Whether a version is released for use. An unknown version is not. */
export function isCentralAssistantAcknowledgementReleased(version: string): boolean {
  return getCentralAssistantAcknowledgement(version)?.released === true;
}

export type CentralAssistantAcknowledgementVariables = {
  /** The practice's legal name, as on its agreement. */
  practiceLegalName: string;
  /** The location being added, as the practice names it. */
  locationName: string;
  /** Its street address. */
  locationAddress: string;
  /** Whether the package bought (never the one billed) has phone. */
  packageHasPhone: boolean;
};

/** Which statements a document carries: the call statement only with phone. */
export type CentralAssistantVariant = "with_phone" | "without_phone";

export class CentralAssistantAcknowledgementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CentralAssistantAcknowledgementError";
  }
}

/** The longest each typed value may be, in characters. */
export const CENTRAL_ASSISTANT_LIMITS = {
  practiceLegalName: 200,
  locationName: 120,
  locationAddress: 300,
} as const;

/**
 * A control or format character (a bidirectional override among them, which
 * would let a name display in an order other than the stored one), or a
 * brace, which would let a value pose as a placeholder.
 */
const REFUSED = /[\p{Cc}\p{Cf}{}]/u;

function field(value: unknown, name: keyof typeof CENTRAL_ASSISTANT_LIMITS): string {
  if (typeof value !== "string") {
    throw new CentralAssistantAcknowledgementError(`${name} must be text.`);
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    throw new CentralAssistantAcknowledgementError(
      `${name} is required to render the central-assistant acknowledgement.`,
    );
  }
  if ([...text].length > CENTRAL_ASSISTANT_LIMITS[name]) {
    throw new CentralAssistantAcknowledgementError(
      `${name} is longer than ${CENTRAL_ASSISTANT_LIMITS[name]} characters.`,
    );
  }
  if (REFUSED.test(text)) {
    throw new CentralAssistantAcknowledgementError(`${name} holds a control character or a brace.`);
  }
  return text;
}

/**
 * The variables, checked and with their whitespace collapsed: what every
 * render reads, so two spellings of the same name that differ only in spaces
 * render, and hash, the same.
 */
export function validateCentralAssistantVariables(
  variables: CentralAssistantAcknowledgementVariables,
): CentralAssistantAcknowledgementVariables {
  if (typeof variables?.packageHasPhone !== "boolean") {
    throw new CentralAssistantAcknowledgementError("packageHasPhone must be true or false.");
  }
  return {
    practiceLegalName: field(variables.practiceLegalName, "practiceLegalName"),
    locationName: field(variables.locationName, "locationName"),
    locationAddress: field(variables.locationAddress, "locationAddress"),
    packageHasPhone: variables.packageHasPhone,
  };
}

export function centralAssistantVariant(packageHasPhone: boolean): CentralAssistantVariant {
  return packageHasPhone ? "with_phone" : "without_phone";
}

/**
 * The words the portal shows: the statements above the tick, numbered as the
 * document numbers them, and the sentence the person ticks. The document is
 * rendered from these, so the two say the same thing.
 */
export function centralAssistantAcknowledgementParts(
  variables: CentralAssistantAcknowledgementVariables,
  acknowledgement: CentralAssistantAcknowledgement = currentCentralAssistantAcknowledgement(),
): { statements: readonly string[]; acceptance: string } {
  const v = validateCentralAssistantVariables(variables);
  const statements = acknowledgement.statements
    .filter((s) => v.packageHasPhone || !s.phoneOnly)
    .map((s) => s.text);
  // Replaced through functions, so a "$&" or "$$" in a typed name is printed
  // as typed rather than read as a replacement pattern.
  const acceptance = acknowledgement.acceptance
    .replaceAll("{{practice}}", () => v.practiceLegalName)
    .replaceAll("{{location}}", () => v.locationName)
    .replaceAll("{{address}}", () => v.locationAddress);
  if (/\{\{|\}\}/.test(acceptance)) {
    throw new CentralAssistantAcknowledgementError(
      "Unsubstituted placeholder in the central-assistant acknowledgement.",
    );
  }
  return { statements, acceptance };
}

/**
 * The exact text a practice accepts. Laid out like the BAA and the calendar
 * election (upper-case headings, every line through the 78-column wrap), so
 * the plain-text copy reads the same everywhere, however long a name is.
 */
export function renderCentralAssistantAcknowledgement(
  variables: CentralAssistantAcknowledgementVariables,
  acknowledgement: CentralAssistantAcknowledgement = currentCentralAssistantAcknowledgement(),
): string {
  const v = validateCentralAssistantVariables(variables);
  const { statements, acceptance } = centralAssistantAcknowledgementParts(v, acknowledgement);
  return [
    `CENTRAL ASSISTANT ACKNOWLEDGEMENT`,
    `for a further location of a healdesk account`,
    `Version ${acknowledgement.version} — accepted electronically`,
    ``,
    `PRACTICE`,
    wrap(v.practiceLegalName),
    ``,
    `LOCATION`,
    wrap(v.locationName),
    wrap(v.locationAddress),
    ``,
    `ONE ASSISTANT FOR EVERY LOCATION`,
    ``,
    statements.map((text, i) => wrap(`${i + 1}. ${text}`, "  ", "     ")).join("\n\n"),
    ``,
    `ACCEPTANCE`,
    ``,
    wrap(acceptance),
  ].join("\n");
}

/** SHA-256 hex of the exact rendered text, the digest the BAA and the calendar election use. */
export function hashCentralAssistantAcknowledgement(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render, hash and name the version and the variant in one step, as prepareCalendarElection does. */
export function prepareCentralAssistantAcknowledgement(
  variables: CentralAssistantAcknowledgementVariables,
  acknowledgement: CentralAssistantAcknowledgement = currentCentralAssistantAcknowledgement(),
): {
  text: string;
  hash: string;
  version: string;
  variant: CentralAssistantVariant;
  released: boolean;
} {
  const text = renderCentralAssistantAcknowledgement(variables, acknowledgement);
  return {
    text,
    hash: hashCentralAssistantAcknowledgement(text),
    version: acknowledgement.version,
    variant: centralAssistantVariant(variables.packageHasPhone),
    released: acknowledgement.released,
  };
}
