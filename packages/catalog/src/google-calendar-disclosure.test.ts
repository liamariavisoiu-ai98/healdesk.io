import { describe, expect, test } from "vitest";

import {
  GOOGLE_CALENDAR_DISCLOSURE,
  GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE,
  GOOGLE_CALENDAR_DISCLOSURE_DPA,
  GOOGLE_CALENDAR_DISCLOSURES,
  GoogleCalendarDisclosureError,
  googleCalendarDisclosureFor,
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
  // The DPA's two (20 October 2026): the BAA's above did not move with them.
  "google-calendar-disclosure-dpa-patients/1":
    "e2a25caf9a6081308678bcee99c202ece391e680f23d24ffdd9111ad3a1cd12b",
  "google-calendar-disclosure-dpa-clients/1":
    "2d964717aba01e50cf22d07d922e1cd093d7252b2a84b1c76d793c0140d99216",
};

describe("the Google Calendar disclosure", () => {
  test("is versioned, and its wording is frozen per version", () => {
    expect(GOOGLE_CALENDAR_DISCLOSURE.version).toBe("google-calendar-disclosure/1");
    expect(
      googleCalendarDisclosureSha256(),
      "The disclosure's wording changed. Give it a new version; stored acceptances point at this one.",
    ).toBe(GOLDEN_SHA256[GOOGLE_CALENDAR_DISCLOSURE.version]);
    for (const disclosure of GOOGLE_CALENDAR_DISCLOSURES) {
      expect(
        googleCalendarDisclosureSha256(disclosure),
        `${disclosure.version}'s wording changed. Give it a new version; stored acceptances point at this one.`,
      ).toBe(GOLDEN_SHA256[disclosure.version]);
    }
    expect(GOOGLE_CALENDAR_DISCLOSURES.map((d) => d.version)).toEqual(Object.keys(GOLDEN_SHA256));
    expect(GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE).toEqual([
      "google-calendar-disclosure/1",
      "google-calendar-disclosure-dpa-patients/1",
      "google-calendar-disclosure-dpa-clients/1",
    ]);
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

/**
 * Released with the DPA on 20 October 2026: a practice under the Data
 * Protection Agreement has no business associate agreement with healdesk,
 * and a vet's customers are clients, so neither may be shown the BAA's
 * fourth paragraph. Each kind of practice gets its own wording, and the
 * BAA's practices get exactly the wording, version and hash they had.
 */
describe("the wording each practice is shown", () => {
  test("a practice under the BAA gets the BAA's wording, unchanged, whatever else is true of it", () => {
    for (const audience of ["patients", "clients"] as const) {
      for (const agreementKind of ["baa", null] as const) {
        const chosen = googleCalendarDisclosureFor({ agreementKind, audience });
        expect(chosen).toBe(GOOGLE_CALENDAR_DISCLOSURE);
        expect(chosen.version).toBe("google-calendar-disclosure/1");
        expect(googleCalendarDisclosureSha256(chosen)).toBe(
          "5b3fa42bf21ce7ab880bb869f16f19d6953f87b576f67b0c431eb8eb273387d5",
        );
      }
    }
    expect(GOOGLE_CALENDAR_DISCLOSURE).toMatchObject({ agreementKind: "baa", audience: "patients" });
  });

  test("a practice under the DPA gets the DPA's wording for its audience", () => {
    expect(googleCalendarDisclosureFor({ agreementKind: "dpa", audience: "patients" })).toBe(
      GOOGLE_CALENDAR_DISCLOSURE_DPA.patients,
    );
    expect(googleCalendarDisclosureFor({ agreementKind: "dpa", audience: "clients" })).toBe(
      GOOGLE_CALENDAR_DISCLOSURE_DPA.clients,
    );
    for (const audience of ["patients", "clients"] as const) {
      const dpa = GOOGLE_CALENDAR_DISCLOSURE_DPA[audience];
      expect(dpa).toMatchObject({ agreementKind: "dpa", audience });
      expect(dpa.version).toBe(`google-calendar-disclosure-dpa-${audience}/1`);
      // Everything but the fourth paragraph is the BAA's: what healdesk reads
      // and adds is the same calendar clause under either agreement.
      expect(dpa.heading).toBe(GOOGLE_CALENDAR_DISCLOSURE.heading);
      expect(dpa.tickLabel).toBe(GOOGLE_CALENDAR_DISCLOSURE.tickLabel);
      expect(dpa.limitedUse).toEqual(GOOGLE_CALENDAR_DISCLOSURE.limitedUse);
      expect(dpa.privacyHref).toBe(GOOGLE_CALENDAR_DISCLOSURE.privacyHref);
      expect(dpa.timeRecipients).toEqual(GOOGLE_CALENDAR_DISCLOSURE.timeRecipients);
      expect(dpa.baaWording).toBe("conditional");
      expect(dpa.paragraphs).toHaveLength(6);
      dpa.paragraphs.forEach((p, i) => {
        if (i !== 3) expect(p, `paragraph ${i}`).toBe(GOOGLE_CALENDAR_DISCLOSURE.paragraphs[i]);
      });
      const goes = dpa.paragraphs[3]!;
      expect(goes).toContain("healdesk's AI model provider, Anthropic");
      expect(goes).toContain("healdesk's voice provider, Retell");
      // What the DPA's Subcontractors clause holds them to, as a promise about when.
      expect(goes).toContain(
        "Your data protection agreement with healdesk requires healdesk to have each of them agree in writing",
      );
      expect(goes).toContain(
        "to restrictions and conditions at least as protective of that information as those the agreement places on healdesk",
      );
      expect(goes).toContain(
        "does not sell this information, use it for advertising, or use it to train AI models",
      );
      expect(dpa.paragraphs.join(" ")).not.toMatch(/business associate/i);
      expect(dpa.paragraphs.join(" ")).not.toMatch(/HIPAA/);
    }
  });

  test("a vet's wording never says patient: the person offered times is a client", () => {
    const vet = GOOGLE_CALENDAR_DISCLOSURE_DPA.clients;
    const words = [vet.heading, ...vet.paragraphs, vet.tickLabel].join(" ");
    expect(words).not.toMatch(/\bpatients?('s)?\b/i);
    expect(vet.paragraphs[3]).toContain("When your assistant offers a client times");
    expect(vet.paragraphs[3]).toContain("before any client's information reaches it");
    const rendered = renderGoogleCalendarDisclosure({ clinicName: "Paws & Claws" }, vet);
    expect(rendered.version).toBe(vet.version);
    expect(rendered.paragraphs[0]).toContain("is asking for Paws & Claws to connect");
    expect(rendered.paragraphs.join(" ")).not.toMatch(/\bpatients?\b/i);
  });

  test("a DPA practice whose patients are people keeps the word patient", () => {
    const people = GOOGLE_CALENDAR_DISCLOSURE_DPA.patients;
    expect(people.paragraphs[3]).toContain("When your assistant offers a patient times");
    expect(people.paragraphs[3]).toContain("before any patient's information reaches it");
    expect(people.paragraphs.join(" ")).not.toMatch(/\bclients?\b/i);
  });

  test("each wording names the practice once, in its first paragraph, and only there", () => {
    for (const disclosure of GOOGLE_CALENDAR_DISCLOSURES) {
      const placeholders = disclosure.paragraphs.flatMap((p) => p.match(/\{[^}]*\}/g) ?? []);
      expect(placeholders, disclosure.version).toEqual(["{clinicName}"]);
      expect(disclosure.paragraphs[0], disclosure.version).toContain("{clinicName}");
    }
  });
});
