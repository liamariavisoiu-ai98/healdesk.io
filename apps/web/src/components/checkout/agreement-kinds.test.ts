import {
  agreementKindFor,
  agreementPlatformFor,
  BAA_EXPLAINER,
  BOOKING_SYSTEMS,
  type BaaVariables,
  CALENDAR_ACCOUNTS,
  COVERED_ANSWERS,
  currentBaaTemplate,
  getPlatform,
  NO_PLATFORM_ID,
  renderBaa,
  specialties,
  specialtyOffered,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY, agreementCopyFor, effectiveDateToday } from "./agreement-kinds";

/**
 * The preview the buyer reads is the document the server stores.
 *
 * The browser renders the agreement and hashes what it showed; apps/app
 * renders its own copy from the signature request and refuses a signature
 * whose hash differs. So the funnel's preview, built through the catalog's
 * buildBaaSelections with the platform the booking system implies, must come
 * out byte for byte as apps/app's signing path builds it today (from
 * `platform`, in apps/app/src/lib/agreements.ts), for every combination the
 * funnel can produce: every offered specialty, every covered-entity answer,
 * every booking system and every kind of Google account.
 */

/** apps/app's signAgreement, as it builds the document from a signature request. */
function serverRender(input: {
  clinicLegalName: string;
  specialty: string;
  platform: string;
  isCoveredEntity: boolean | null;
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  effectiveDate: string;
}): string {
  const variables: BaaVariables = {
    clinicLegalName: input.clinicLegalName.trim(),
    signatoryName: input.signatoryName.trim(),
    signatoryTitle: input.signatoryTitle?.trim() || undefined,
    signatoryEmail: input.signatoryEmail.trim().toLowerCase(),
    effectiveDate: input.effectiveDate,
    specialty: specialties.find((s) => s.id === input.specialty)?.name ?? input.specialty,
    isCoveredEntity: input.isCoveredEntity,
    attributionMode: "estimated",
    connectedPlatform:
      input.platform === NO_PLATFORM_ID ? null : (getPlatform(input.platform)?.name ?? null),
    outboundMessaging: false,
    bookingMode: "desk_confirms",
    calendarWrite: null,
  };
  return renderBaa(currentBaaTemplate(), variables);
}

/** Rendering a whole agreement twice, 72 times per specialty, is slow under a busy runner. */
const RENDER_TIMEOUT_MS = 60_000;

const OFFERED = specialties.filter((s) => specialtyOffered(s.id));

describe("the agreement the buyer reads is the one apps/app stores", () => {
  test("every specialty offered is covered", () => {
    expect(OFFERED.map((s) => s.id)).toHaveLength(7);
  });

  test.each(OFFERED.map((s) => [s.id, s] as const))(
    "%s: every answer, booking system and Google account",
    (_id, specialty) => {
      const signer = {
        clinicLegalName: "Glow Med Spa LLC",
        signatoryName: "Laura Owner",
        signatoryTitle: "Owner",
        signatoryEmail: "info@glowmedspa.com",
        effectiveDate: "2026-10-06",
      };
      let combinations = 0;
      for (const covered of COVERED_ANSWERS) {
        const choice = agreementKindFor({ specialty: specialty.id, covered });
        expect(choice.ok, specialty.id).toBe(true);
        if (!choice.ok) continue;
        const copy = agreementCopyFor(choice.kind);
        expect(copy, `${specialty.id} ${covered}`).not.toBeNull();
        for (const system of BOOKING_SYSTEMS) {
          for (const account of CALENDAR_ACCOUNTS) {
            const preview = copy!.render({
              ...signer,
              specialty: specialty.id,
              isCoveredEntity: choice.isCoveredEntity,
              bookingSystem: system.id,
              calendarAccount: account,
            });
            const stored = serverRender({
              ...signer,
              specialty: specialty.id,
              platform: agreementPlatformFor(system.id),
              isCoveredEntity: choice.isCoveredEntity,
            });
            expect(preview.text, `${specialty.id} ${covered} ${system.id} ${account}`).toBe(stored);
            combinations += 1;
          }
        }
      }
      // Three answers, eight systems, three accounts.
      expect(combinations).toBe(3 * 8 * 3);
    },
    RENDER_TIMEOUT_MS,
  );

  test("a booking system with a phase-two platform names it; one without names none", () => {
    const render = (bookingSystem: (typeof BOOKING_SYSTEMS)[number]["id"]) =>
      AGREEMENT_COPY.baa.render({
        clinicLegalName: "Glow Med Spa LLC",
        specialty: "med-spa",
        isCoveredEntity: false,
        bookingSystem,
        calendarAccount: "personal",
        signatoryName: "Laura Owner",
        signatoryEmail: "info@glowmedspa.com",
        effectiveDate: "2026-10-06",
      }).text;
    expect(render("mindbody")).toContain("Mindbody");
    expect(render("calendly")).not.toContain("Calendly");
  });
});

describe("AGREEMENT_COPY", () => {
  test("holds the Business Associate Agreement, with its own explainer and assent wording", () => {
    expect(AGREEMENT_COPY.baa.title).toBe("Business Associate Agreement");
    expect(AGREEMENT_COPY.baa.explainer).toBe(BAA_EXPLAINER);
    expect(AGREEMENT_COPY.baa.assentLabel).toBe("I agree to the Business Associate Agreement");
    expect(AGREEMENT_COPY.baa.version).toBe(currentBaaTemplate().version);
    expect(AGREEMENT_COPY.baa.fileStem).toBe("healdesk-baa");
  });

  test("has no Data Protection Agreement until it is released, so nothing signs one by accident", () => {
    expect(AGREEMENT_COPY.dpa).toBeUndefined();
    expect(agreementCopyFor("dpa")).toBeNull();
  });

  test("dates the document in UTC, as the server does", () => {
    expect(effectiveDateToday(new Date("2026-10-06T23:30:00-07:00"))).toBe("2026-10-07");
  });
});
