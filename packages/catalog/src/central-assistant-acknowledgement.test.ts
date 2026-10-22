import { describe, expect, test } from "vitest";

import { hashBaaText } from "./baa";
import {
  CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION,
  CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS,
  CENTRAL_ASSISTANT_LIMITS,
  CentralAssistantAcknowledgementError,
  centralAssistantAcknowledgementParts,
  currentCentralAssistantAcknowledgement,
  getCentralAssistantAcknowledgement,
  hashCentralAssistantAcknowledgement,
  isCentralAssistantAcknowledgementReleased,
  prepareCentralAssistantAcknowledgement,
  renderCentralAssistantAcknowledgement,
  type CentralAssistantAcknowledgementVariables,
} from "./central-assistant-acknowledgement";

/** The 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

const BASE: CentralAssistantAcknowledgementVariables = {
  practiceLegalName: "Radiance Aesthetics LLC",
  locationName: "Radiance Downtown",
  locationAddress: "200 Congress Avenue, Suite 4, Austin, TX 78701",
  packageHasPhone: true,
};

/**
 * The goldens: the hash of each variant's exact text for BASE. A stored
 * acknowledgement row carries the hash of what was accepted, so a wording
 * that moves under a version already accepted would leave every row pointing
 * at a text nobody can reproduce. Change the words in a new version, never
 * here.
 */
const GOLDEN = {
  with_phone: "ddc23e6c59c9b6cb24a2d06dff73c08e7d0b1b75a7de04097825c9c741df064a",
  without_phone: "c87e4e9611356e5ad05e57109bad9abfd3d1d10822dd12443cd86343ec7a591b",
} as const;

describe("the central-assistant acknowledgement, 1.0.0", () => {
  test("each variant renders to its pinned hash", () => {
    const phone = prepareCentralAssistantAcknowledgement(BASE);
    const chat = prepareCentralAssistantAcknowledgement({ ...BASE, packageHasPhone: false });
    expect(phone.variant).toBe("with_phone");
    expect(chat.variant).toBe("without_phone");
    expect(phone.hash).toBe(GOLDEN.with_phone);
    expect(chat.hash).toBe(GOLDEN.without_phone);
    // The digest is the one the BAA and the calendar election use.
    expect(phone.hash).toBe(hashBaaText(phone.text));
    expect(phone.hash).toBe(hashCentralAssistantAcknowledgement(phone.text));
    expect(phone.version).toBe(CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION);
  });

  test("the hash is stable: the same variables give the same bytes, and spacing is not a difference", () => {
    const a = prepareCentralAssistantAcknowledgement(BASE);
    const b = prepareCentralAssistantAcknowledgement({
      ...BASE,
      practiceLegalName: "  Radiance   Aesthetics LLC ",
      locationAddress: "200 Congress Avenue,\nSuite 4, Austin, TX 78701",
    });
    expect(b.text).toBe(a.text);
    expect(b.hash).toBe(a.hash);
    // A different location is a different document.
    expect(
      prepareCentralAssistantAcknowledgement({ ...BASE, locationName: "Radiance Uptown" }).hash,
    ).not.toBe(a.hash);
  });

  test("the sentence ticked is the plan's, word for word, with the practice, location and address", () => {
    const text = unwrap(renderCentralAssistantAcknowledgement(BASE));
    expect(text).toContain(
      "I have authority to bind Radiance Aesthetics LLC. Radiance Downtown, at 200 Congress Avenue, Suite 4, Austin, TX 78701, is operated by Radiance Aesthetics LLC, the practice named in our healdesk agreement, and I accept that AYA answers for it as one central assistant for all our locations, like a call centre, not as a separate assistant for each location.",
    );
    expect(text).toContain(`Version ${CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION}`);
    expect(text).not.toMatch(/\{\{|\}\}/);
  });

  test("a package with phone carries five statements, the call one among them; one without carries four", () => {
    const phone = unwrap(renderCentralAssistantAcknowledgement(BASE));
    const chat = unwrap(renderCentralAssistantAcknowledgement({ ...BASE, packageHasPhone: false }));
    const calls = "This location's calls fall back to its own direct line.";
    expect(phone).toContain(`3. ${calls}`);
    expect(phone).toContain(
      "An urgent message that arrives before AYA knows the location gets the main location's urgent-help number.",
    );
    expect(phone).toContain("5. The price:");
    expect(chat).not.toContain(calls);
    expect(chat).not.toContain("urgent-help number");
    expect(chat).toContain("4. The price:");
    expect(chat).not.toContain("5. ");
  });

  test("the five statements say what the first release does, and no more", () => {
    const text = unwrap(renderCentralAssistantAcknowledgement(BASE));
    expect(text).toContain(
      "1. One AYA, knowledge base and price list for every location; it works out or asks which location a person contacting you means.",
    );
    expect(text).toContain(
      "2. One sign-in and one email address for every location. Anyone with the sign-in sees every location's conversations and bookings, and transcripts and alerts for every location go to that address.",
    );
    // Statement 4 holds the first release's limit (the plan's correction
    // 16): no location after the first can record a calendar election, so
    // the statement promises none.
    expect(text).toContain(
      "4. This location takes booking requests only, and nothing about it reaches Google Calendar: your team confirms each request. A calendar for this location needs a calendar election recorded for it first.",
    );
    expect(text).not.toMatch(/until per-location calendars are available/);
    // Statement 5 is the price as built (correction 1): the setup fee at the
    // add, and the plan price prorated only once the plan has started.
    expect(text).toContain(
      "5. The price: your plan's price again, plus its setup fee once. The setup fee is charged when you add this location. If your plan has started, this location's plan price joins it at once, prorated to your renewal date; if it has not, this location's plan price starts with your plan. Allowances are pooled across your locations.",
    );
  });

  test("names no audience, so the one text is true at a veterinary practice, and makes no claim it may not", () => {
    for (const packageHasPhone of [true, false]) {
      const text = unwrap(renderCentralAssistantAcknowledgement({ ...BASE, packageHasPhone }));
      expect(text).not.toMatch(/\bpatients?\b|\bclients?\b/i);
      expect(text).not.toMatch(/revenue|HIPAA compliant|pilot|beta|early access|founding|cohort/i);
      expect(text).not.toMatch(
        /\b(20\d\d|January|February|March|April|May|June|July|August|September|October|November|December)\b/,
      );
    }
  });

  test("every line keeps to 78 columns, like the BAA and the calendar election", () => {
    const long = renderCentralAssistantAcknowledgement({
      ...BASE,
      practiceLegalName:
        "A".repeat(10) +
        " " +
        "Very Long Practice Name Holdings, Professional Medical Corporation of Texas",
      locationAddress:
        "12345 North Lamar Boulevard, Building C, Second Floor, Suite 210, Austin, TX 78753",
    });
    for (const line of long.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("the portal's words are the document's words", () => {
    const parts = centralAssistantAcknowledgementParts({ ...BASE, packageHasPhone: false });
    const text = unwrap(renderCentralAssistantAcknowledgement({ ...BASE, packageHasPhone: false }));
    expect(parts.statements).toHaveLength(4);
    parts.statements.forEach((statement, i) => expect(text).toContain(`${i + 1}. ${statement}`));
    expect(text).toContain(parts.acceptance);
  });
});

describe("the variables are validated before anything renders", () => {
  test.each([
    ["practiceLegalName", ""],
    ["practiceLegalName", "   "],
    ["locationName", ""],
    ["locationAddress", " \n "],
  ] as const)("refuses an empty %s", (name, value) => {
    expect(() => renderCentralAssistantAcknowledgement({ ...BASE, [name]: value })).toThrow(
      CentralAssistantAcknowledgementError,
    );
  });

  test("refuses a value that is not text, and a phone answer that is not a boolean", () => {
    expect(() =>
      renderCentralAssistantAcknowledgement({ ...BASE, locationName: 42 as unknown as string }),
    ).toThrow(CentralAssistantAcknowledgementError);
    expect(() =>
      renderCentralAssistantAcknowledgement({
        ...BASE,
        packageHasPhone: "yes" as unknown as boolean,
      }),
    ).toThrow(/packageHasPhone/);
    expect(() =>
      renderCentralAssistantAcknowledgement({
        ...BASE,
        packageHasPhone: undefined as unknown as boolean,
      }),
    ).toThrow(/packageHasPhone/);
  });

  test("refuses a value past its limit, and takes one at it", () => {
    for (const name of ["practiceLegalName", "locationName", "locationAddress"] as const) {
      const limit = CENTRAL_ASSISTANT_LIMITS[name];
      expect(() =>
        renderCentralAssistantAcknowledgement({ ...BASE, [name]: "x".repeat(limit + 1) }),
      ).toThrow(new RegExp(`${name} is longer than ${limit}`));
      expect(() =>
        renderCentralAssistantAcknowledgement({ ...BASE, [name]: "x".repeat(limit) }),
      ).not.toThrow();
    }
  });

  test("refuses a placeholder, a control character and a bidirectional override", () => {
    for (const value of [
      "{{practice}}",
      "Radiance } Downtown",
      "Radiance\u0000Downtown",
      "Radiance \u202EnwotnwoD",
      "Radiance\u2066Downtown",
    ]) {
      expect(() => renderCentralAssistantAcknowledgement({ ...BASE, locationName: value })).toThrow(
        CentralAssistantAcknowledgementError,
      );
    }
    // Accents, apostrophes and an ampersand are a business's name, not a trick.
    expect(() =>
      renderCentralAssistantAcknowledgement({
        ...BASE,
        practiceLegalName: "Clínica O’Neil & Søn, P.A.",
      }),
    ).not.toThrow();
  });

  test("prints a dollar sign as typed, never as a replacement pattern", () => {
    const dollars = unwrap(
      renderCentralAssistantAcknowledgement({
        ...BASE,
        practiceLegalName: "Cash$$ Aesthetics $& Co",
      }),
    );
    expect(dollars).toContain(
      "I have authority to bind Cash$$ Aesthetics $& Co. Radiance Downtown,",
    );
    expect(dollars).toContain("is operated by Cash$$ Aesthetics $& Co, the practice named");
  });
});

describe("versions and release", () => {
  test("1.0.0 is current, findable by its version, and not released until its wording audit passes", () => {
    expect(currentCentralAssistantAcknowledgement().version).toBe(
      "central-assistant-acknowledgement/1.0.0",
    );
    expect(getCentralAssistantAcknowledgement(CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION)).toBe(
      currentCentralAssistantAcknowledgement(),
    );
    expect(
      isCentralAssistantAcknowledgementReleased(CENTRAL_ASSISTANT_ACKNOWLEDGEMENT_VERSION),
    ).toBe(false);
    expect(prepareCentralAssistantAcknowledgement(BASE).released).toBe(false);
    expect(
      isCentralAssistantAcknowledgementReleased("central-assistant-acknowledgement/9.9.9"),
    ).toBe(false);
  });

  test("versions are unique, newest first, and each carries the one call statement", () => {
    const versions = CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS.map((a) => a.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const a of CENTRAL_ASSISTANT_ACKNOWLEDGEMENTS) {
      expect(a.version).toMatch(/^central-assistant-acknowledgement\/\d+\.\d+\.\d+$/);
      expect(a.statements.filter((s) => s.phoneOnly).map((s) => s.id)).toEqual(["calls"]);
      for (const placeholder of ["{{practice}}", "{{location}}", "{{address}}"]) {
        expect(a.acceptance).toContain(placeholder);
      }
    }
  });
});
