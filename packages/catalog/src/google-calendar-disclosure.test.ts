import { describe, expect, test } from "vitest";

import {
  GOOGLE_CALENDAR_DISCLOSURE,
  GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE,
  GoogleCalendarDisclosureError,
  googleCalendarDisclosureSha256,
  renderGoogleCalendarDisclosure,
} from "./google-calendar-disclosure";

/**
 * Every connection stores the version and this hash of what was ticked. The
 * golden hash makes an edit to the wording a failing test rather than a
 * silent change to what earlier acceptances point at: change the words, and
 * the version has to change with them. Version /1 has never been shown, so
 * the pre-release audit of 6 October 2026 changed it in place and moved this
 * hash (agreement-changes.md §12.12 and §12.14); once it is shown, it never
 * moves again.
 */
const GOLDEN_SHA256: Record<string, string> = {
  "google-calendar-disclosure/1":
    "5b3fa42bf21ce7ab880bb869f16f19d6953f87b576f67b0c431eb8eb273387d5",
};

describe("the Google Calendar disclosure", () => {
  test("is versioned, and its wording is frozen per version", () => {
    expect(GOOGLE_CALENDAR_DISCLOSURE.version).toBe("google-calendar-disclosure/1");
    expect(
      googleCalendarDisclosureSha256(),
      "The disclosure's wording changed. Give it a new version; stored acceptances point at this one.",
    ).toBe(GOLDEN_SHA256[GOOGLE_CALENDAR_DISCLOSURE.version]);
    expect(GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE).toEqual(["google-calendar-disclosure/1"]);
  });

  test("names the practice in its first paragraph, and nowhere leaves a placeholder", () => {
    const placeholders = GOOGLE_CALENDAR_DISCLOSURE.paragraphs.flatMap(
      (p) => p.match(/\{[^}]*\}/g) ?? [],
    );
    expect(placeholders).toEqual(["{clinicName}"]);
    expect(GOOGLE_CALENDAR_DISCLOSURE.paragraphs[0]).toContain("{clinicName}");

    const rendered = renderGoogleCalendarDisclosure({ clinicName: "  Golden {Clinic} LLC  " });
    expect(rendered.paragraphs[0]).toContain("is asking for Golden {Clinic} LLC to connect");
    expect(rendered.paragraphs.slice(1)).toEqual(GOOGLE_CALENDAR_DISCLOSURE.paragraphs.slice(1));
    expect(rendered.version).toBe(GOOGLE_CALENDAR_DISCLOSURE.version);
    expect(() => renderGoogleCalendarDisclosure({ clinicName: " " })).toThrow(
      GoogleCalendarDisclosureError,
    );
  });

  test("puts the practice's name in verbatim, whatever characters it holds", () => {
    // String.prototype.replace patterns: a name holding one must not bring
    // the placeholder back, copy the rest of the paragraph, or lose a "$".
    for (const clinicName of [
      "A $& B",
      "Glow $' Spa",
      "Cash$$ Clinic",
      "Back $` Bay",
      "$1 Dental",
    ]) {
      const [first] = renderGoogleCalendarDisclosure({ clinicName }).paragraphs;
      expect(first, clinicName).toBe(
        GOOGLE_CALENDAR_DISCLOSURE.paragraphs[0]!.split("{clinicName}").join(clinicName),
      );
      expect(first, clinicName).toContain(
        `is asking for ${clinicName} to connect the Google account you sign in with next`,
      );
      expect(first, clinicName).not.toContain("{clinicName}");
      expect(first!.split(clinicName), clinicName).toHaveLength(2);
    }
  });

  test("says what healdesk reads and adds, as the calendar clauses do", () => {
    const [who, reads, adds, goes, disconnect, limitedUse] = GOOGLE_CALENDAR_DISCLOSURE.paragraphs;
    expect(GOOGLE_CALENDAR_DISCLOSURE.paragraphs).toHaveLength(6);
    expect(who).toContain("healdesk, a service of Viixi FZC");
    expect(who).toContain("to connect the Google account you sign in with next");
    // One calendar, or one per provider, as the calendar clauses say (PT-06).
    expect(who).toContain(
      "healdesk books into that account's main calendar, unless you choose another calendar it " +
        "owns or manages, or one for each provider if you book by provider.",
    );
    expect(reads).toContain(
      "the names of the calendars that account owns or manages, so you can choose where healdesk " +
        "books",
    );
    expect(reads).toContain("when each calendar it books into is free or busy");
    // What Google's permission reaches, the subscribed-calendar list included (PT-20).
    expect(reads).toContain(
      "Google's permission also reaches the list of every calendar you subscribe to",
    );
    expect(reads).toContain("healdesk does not read or store them");
    // The first name the person booking gave (PT-30), and the service's name (ICD-28).
    expect(adds).toContain(
      "as a private event with the first name the person booking gave, the service and the time",
    );
    expect(adds).toContain(
      "never a phone number, an email address, or anything clinical beyond the service's name",
    );
    expect(adds).toContain("with no guests and no reminders");
    expect(adds).toContain("healdesk never changes or deletes an event it did not add");
    expect(goes).toContain("healdesk's AI model provider, Anthropic");
    expect(goes).toContain("healdesk's voice provider, Retell");
    expect(goes).toContain(
      "does not sell this information, use it for advertising, or use it to train AI models",
    );
    expect(disconnect).toContain("healdesk then deletes the stored connection");
    expect(disconnect).not.toMatch(/revok/i);
    // Verbatim as privacy §11 makes it, with its two links.
    expect(limitedUse).toBe(
      "healdesk's use and transfer to any other app of information received from Google APIs will " +
        "adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(limitedUse).toContain(GOOGLE_CALENDAR_DISCLOSURE.limitedUse.linkText);
    expect(GOOGLE_CALENDAR_DISCLOSURE.limitedUse.href).toBe(
      "https://developers.google.com/terms/api-services-user-data-policy",
    );
    expect(GOOGLE_CALENDAR_DISCLOSURE.privacyHref).toBe("https://healdesk.io/privacy#google");
  });

  test("the tick label, and who the times reach on what terms", () => {
    expect(GOOGLE_CALENDAR_DISCLOSURE.tickLabel).toBe(
      "I allow healdesk to see when the calendars it books into are free or busy and to add the " +
        "bookings it makes, as described above.",
    );
    expect(GOOGLE_CALENDAR_DISCLOSURE.timeRecipients).toEqual([
      "Anthropic (the product)",
      "Retell",
    ]);
    // apps/web/src/lib/google-disclosure.test.ts ties this to the register.
    expect(GOOGLE_CALENDAR_DISCLOSURE.baaWording).toBe("conditional");
    expect(GOOGLE_CALENDAR_DISCLOSURE.paragraphs.join(" ")).toContain(
      "signed before any patient's information is processed",
    );
  });
});
