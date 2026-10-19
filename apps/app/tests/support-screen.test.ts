import { describe, expect, test } from "vitest";

import {
  EMAIL_MASK,
  NUMBER_MASK,
  screenNotices,
  screenText,
  StreamScreen,
  TREATMENT_MASK,
  TREATMENT_NOTICE,
  type ScreenAllow,
} from "@/lib/support/screen";

/**
 * The support chat's screen (plan Part H): phone numbers and email addresses
 * other than the practice's own and the signed-in user's are hidden, and
 * treatment names are replaced visibly, before the model sees a message and
 * before the person reads a reply. No database.
 */

const ALLOW: ScreenAllow = {
  numbers: ["+15125550100", "+18886889404"],
  emails: ["owner@glowspa.test"],
  serviceNames: ["Signature Glow Facial", "Free consultation", "Diamond Peel 60 min"],
};

describe("the identifier screen", () => {
  test("a caller's number is hidden in every common shape", () => {
    for (const number of [
      "(512) 555-0199",
      "512-555-0199",
      "512.555.0199",
      "+1 512 555 0199",
      "5125550199",
      "+44 20 7946 0958",
    ]) {
      const screened = screenText(`Why didn't AYA book ${number} yesterday?`, ALLOW);
      expect(screened.text, number).toBe(`Why didn't AYA book ${NUMBER_MASK} yesterday?`);
      expect(screened.hiddenIdentifiers).toBe(1);
    }
  });

  test("a card number, a record number and a social security number are hidden too", () => {
    expect(screenText("card 4242 4242 4242 4242", ALLOW).text).toBe(`card ${NUMBER_MASK}`);
    expect(screenText("MRN 00012345", ALLOW).text).toBe(`MRN ${NUMBER_MASK}`);
    expect(screenText("ssn 123-45-6789", ALLOW).text).toBe(`ssn ${NUMBER_MASK}`);
  });

  test("the practice's own numbers and healdesk's support line pass, written any way", () => {
    for (const own of ["(512) 555-0100", "512-555-0100", "+1 512 555 0100", "(888) 688-9404"]) {
      expect(screenText(`My main line is ${own}`, ALLOW).text).toBe(`My main line is ${own}`);
    }
  });

  test("a date, a price, a count and a time are not numbers to hide", () => {
    const text =
      "On 10/14/2026 (2026-10-14) at 9:30 we used 1,500 minutes on the $1,200 plan, steps of 100.";
    expect(screenText(text, ALLOW)).toEqual({ text, hiddenTreatments: 0, hiddenIdentifiers: 0 });
  });

  test("another person's email address is hidden; the user's own and healdesk's pass", () => {
    expect(screenText("She wrote from jane.doe+spa@gmail.com.", ALLOW).text).toBe(
      `She wrote from ${EMAIL_MASK}.`,
    );
    expect(screenText("Send it to Owner@GlowSpa.test please", ALLOW).text).toBe(
      "Send it to Owner@GlowSpa.test please",
    );
    expect(screenText("I emailed hello@healdesk.io and legal@healdesk.io", ALLOW).text).toBe(
      "I emailed hello@healdesk.io and legal@healdesk.io",
    );
  });
});

describe("treatment names", () => {
  test("replaced visibly with [treatment], whatever the case, accents or plural", () => {
    const screened = screenText(
      "How do I add Botox and lip fillers? And JUVÉDERM, and two chemical peels?",
      ALLOW,
    );
    expect(screened.text).toBe(
      `How do I add ${TREATMENT_MASK} and ${TREATMENT_MASK}? And ${TREATMENT_MASK}, and two ${TREATMENT_MASK}?`,
    );
    expect(screened.hiddenTreatments).toBe(4);
    expect(screenNotices(screened)).toEqual([TREATMENT_NOTICE]);
  });

  test("a phrase wins over its word, and separators are any", () => {
    expect(screenText("laser hair removal prices", ALLOW).text).toBe(`${TREATMENT_MASK} prices`);
    expect(screenText("GLP-1 shots", ALLOW).text).toBe(`${TREATMENT_MASK} shots`);
    expect(screenText("all-on-4 implants", ALLOW).text).toBe(`${TREATMENT_MASK} implants`);
  });

  test("whole words only: an honest sentence is left alone", () => {
    const text =
      "I appeal the invoice; my toxic inbox is full. Where do I change the greeting and the deposit?";
    expect(screenText(text, ALLOW)).toEqual({ text, hiddenTreatments: 0, hiddenIdentifiers: 0 });
  });

  test("the practice's own menu names are hidden, but not a name made only of booking words", () => {
    expect(screenText("Why isn't the Signature Glow Facial booking?", ALLOW).text).toBe(
      `Why isn't the ${TREATMENT_MASK} booking?`,
    );
    expect(screenText("Diamond Peel 60 min price", ALLOW).text).toBe(`${TREATMENT_MASK} price`);
    // "Free consultation" is on the menu, but it is how AYA offers a booking.
    expect(screenText("Does AYA offer a free consultation?", ALLOW).text).toBe(
      "Does AYA offer a free consultation?",
    );
  });

  test("the notices name each kind of thing hidden, never what it was", () => {
    const screened = screenText("Call 512-555-0199 about her Botox", ALLOW);
    expect(screened.text).toBe(`Call ${NUMBER_MASK} about her ${TREATMENT_MASK}`);
    const notices = screenNotices(screened);
    expect(notices).toHaveLength(2);
    expect(notices.join(" ")).not.toMatch(/512|botox/i);
  });

  test("screening twice changes nothing more", () => {
    const once = screenText("Botox for 512-555-0199 at jane@x.test", ALLOW).text;
    expect(screenText(once, ALLOW)).toEqual({
      text: once,
      hiddenTreatments: 0,
      hiddenIdentifiers: 0,
    });
  });
});

describe("a streamed reply", () => {
  function streamed(chunks: readonly string[]): string {
    const screen = new StreamScreen(ALLOW);
    return chunks.map((c) => screen.push(c)).join("") + screen.end();
  }

  test("a treatment name or a number split across pieces is still hidden whole", () => {
    const reply =
      "You can list prices in Knowledge. For example a laser hair removal package, or call 512-555-0199 to ask, then save. ";
    const pieces = reply.match(/.{1,3}/gs)!;
    expect(streamed(pieces)).toBe(
      `You can list prices in Knowledge. For example a ${TREATMENT_MASK} package, or call ${NUMBER_MASK} to ask, then save. `,
    );
    // Split exactly inside the phrase and inside the number.
    expect(streamed(["Try laser ha", "ir removal now or 512-55", "5-0199 later."])).toBe(
      `Try ${TREATMENT_MASK} now or ${NUMBER_MASK} later.`,
    );
  });

  test("text with nothing to hide comes through unchanged, in order", () => {
    const reply =
      "Open Settings, then Safety net. Your direct line is (512) 555-0100. Change it there, and confirm with your device's passkey.";
    const pieces = reply.match(/.{1,7}/gs)!;
    expect(streamed(pieces)).toBe(reply);
  });

  test("nothing is sent until enough has arrived that nothing can straddle it", () => {
    const screen = new StreamScreen(ALLOW);
    expect(screen.push("Botox")).toBe("");
    expect(screen.end()).toBe(TREATMENT_MASK);
    expect(screen.hidden).toEqual({ treatments: 1, identifiers: 0 });
  });
});
