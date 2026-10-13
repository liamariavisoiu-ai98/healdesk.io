import {
  agreementKindFor,
  agreementPlatformFor,
  applicableClauses,
  BAA_EXPLAINER,
  baaExplainerTerms,
  BOOKING_SYSTEMS,
  type BaaVariables,
  buildBaaSelections,
  CALENDAR_ACCOUNTS,
  clauseExplainer,
  COVERED_ANSWERS,
  type CoveredAnswer,
  currentBaaTemplate,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
  DPA_EXPLAINER,
  dpaClauseExplainer,
  getBaaTemplate,
  getPlatform,
  NO_PLATFORM_ID,
  prepareDpa,
  renderBaa,
  specialties,
  specialtyOffered,
  type DpaVariables,
  type SpecialtyId,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  AGREEMENT_COPY,
  agreementCopyFor,
  baaAgreementCopy,
  effectiveDateToday,
  versionLabel,
} from "./agreement-kinds";

/**
 * The preview the buyer reads is the document the server stores.
 *
 * The browser renders the agreement and hashes what it showed; apps/app
 * renders its own copy from the signature request and refuses a signature
 * whose hash differs. So the funnel's preview, built through the catalog's
 * buildBaaSelections with the platform the booking system implies, must come
 * out byte for byte as apps/app's signing path builds it (prepareAgreement in
 * apps/app/src/lib/agreements.ts, from the signature request's answers), for
 * every combination the funnel can produce: every offered specialty, every
 * covered-entity answer, every booking system and every kind of Google
 * account. Since 13 October 2026 the current version is 1.4.0 (1.3.0 from 12 October), whose
 * calendar clause both answers choose.
 */

/**
 * apps/app's prepareAgreement, as it builds the document from a signature
 * request: the catalog's builder over the answers the request carries (the
 * booking system, the platform AgreementStep sends beside it and the kind of
 * Google account), the names trimmed and the address lower-cased.
 */
function serverRender(input: {
  clinicLegalName: string;
  specialty: string;
  platform: string;
  bookingSystem: (typeof BOOKING_SYSTEMS)[number]["id"];
  calendarAccount: (typeof CALENDAR_ACCOUNTS)[number];
  isCoveredEntity: boolean | null;
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  effectiveDate: string;
}): string {
  const template = currentBaaTemplate();
  const variables: BaaVariables = {
    ...buildBaaSelections({
      specialtyId: input.specialty,
      attributionMode: "estimated",
      bookingSystem: input.bookingSystem,
      platformId: input.platform,
      isCoveredEntity: input.isCoveredEntity,
      calendarAccount: input.calendarAccount,
      template,
    }),
    clinicLegalName: input.clinicLegalName.trim(),
    signatoryName: input.signatoryName.trim(),
    signatoryTitle: input.signatoryTitle?.trim() || undefined,
    signatoryEmail: input.signatoryEmail.trim().toLowerCase(),
    effectiveDate: input.effectiveDate,
  };
  return renderBaa(template, variables);
}

/**
 * apps/app's signing as it built a document before plan C3, from the
 * picker's platform alone: what a 1.2.2 document, signed inside an overlap,
 * still names.
 */
function legacyRender122(input: {
  clinicLegalName: string;
  specialty: string;
  platform: string;
  isCoveredEntity: boolean | null;
  signatoryName: string;
  signatoryEmail: string;
  effectiveDate: string;
}): string {
  return renderBaa(getBaaTemplate("1.2.2")!, {
    clinicLegalName: input.clinicLegalName.trim(),
    signatoryName: input.signatoryName.trim(),
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
  });
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
              bookingSystem: system.id,
              calendarAccount: account,
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

  test("1.3.0 on names the booking system answered; 1.2.2 named its phase-two platform, or none", () => {
    const input = (bookingSystem: (typeof BOOKING_SYSTEMS)[number]["id"]) =>
      ({
        clinicLegalName: "Glow Med Spa LLC",
        specialty: "med-spa",
        isCoveredEntity: false,
        bookingSystem,
        calendarAccount: "personal",
        signatoryName: "Laura Owner",
        signatoryEmail: "info@glowmedspa.com",
        effectiveDate: "2026-10-06",
      }) as const;
    const render = (bookingSystem: (typeof BOOKING_SYSTEMS)[number]["id"]) =>
      AGREEMENT_COPY.baa.render(input(bookingSystem)).text;
    expect(AGREEMENT_COPY.baa.version).toBe("1.4.0");
    expect(render("mindbody")).toContain("Mindbody");
    expect(render("calendly")).toContain("Calendly");
    // A 1.2.2 screen, loaded before the release, rendered the platform the
    // booking system implies, as the server signing it inside an overlap does.
    const v122 = baaAgreementCopy(getBaaTemplate("1.2.2")!);
    for (const system of ["mindbody", "calendly"] as const) {
      const preview = v122.render(input(system)).text;
      expect(preview, system).toBe(
        legacyRender122({ ...input(system), platform: agreementPlatformFor(system) }),
      );
    }
    expect(v122.render(input("mindbody")).text).toContain("Mindbody");
    expect(v122.render(input("calendly")).text).not.toContain("Calendly");
  });
});

/** A signer for the DPA's render checks, as the server would date and trim it. */
const DPA_SIGNER_VARIABLES: DpaVariables = {
  clinicLegalName: "Golden Paws Veterinary LLC",
  signatoryName: "Laura Owner",
  signatoryTitle: "Owner",
  signatoryEmail: "info@goldenpaws.com",
  effectiveDate: "2026-10-07",
  specialty: "veterinary",
  bookingSystem: "google_calendar",
  calendarAccount: "personal",
};

/**
 * apps/app's prepareDpaAgreement, as it builds the DPA from a signature
 * request: the names trimmed, the address lower-cased, the specialty by its
 * id and both calendar answers, and nothing else.
 */
function serverRenderDpa(input: {
  clinicLegalName: string;
  specialty: SpecialtyId;
  bookingSystem: (typeof BOOKING_SYSTEMS)[number]["id"];
  calendarAccount: (typeof CALENDAR_ACCOUNTS)[number];
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  effectiveDate: string;
}): string {
  return prepareDpa(currentDpaTemplate(), {
    clinicLegalName: input.clinicLegalName.trim(),
    signatoryName: input.signatoryName.trim(),
    signatoryTitle: input.signatoryTitle?.trim() || undefined,
    signatoryEmail: input.signatoryEmail.trim().toLowerCase(),
    effectiveDate: input.effectiveDate,
    specialty: input.specialty,
    bookingSystem: input.bookingSystem,
    calendarAccount: input.calendarAccount,
  }).text;
}

describe("the DPA the buyer reads is the one apps/app stores, once it is released", () => {
  // The practices the release sends to the DPA: a veterinary practice, never
  // asked, and each specialty HIPAA reaches only if covered, answering No.
  const DPA_PRACTICES = specialties.flatMap((s) =>
    ([...COVERED_ANSWERS, null] as (CoveredAnswer | null)[]).flatMap((covered) => {
      const choice = agreementKindFor({ specialty: s.id, covered, dpaReleased: true });
      return choice.ok && choice.kind === "dpa" ? [{ specialty: s.id, covered }] : [];
    }),
  );

  test("the release sends a vet and every No to it, and nobody else", () => {
    const key = (p: { specialty: string; covered: CoveredAnswer | null }) =>
      `${p.specialty}:${p.covered}`;
    expect(DPA_PRACTICES.map(key).sort()).toEqual(
      [
        "hair-restoration:no",
        "massage-chiro:no",
        "med-spa:no",
        // A veterinary practice is never asked; whatever arrives, it signs the DPA.
        "veterinary:null",
        "veterinary:yes",
        "veterinary:no",
        "veterinary:not_sure",
      ].sort(),
    );
  });

  test.each([...new Set(DPA_PRACTICES.map((p) => p.specialty))].map((id) => [id] as const))(
    "%s: every booking system and Google account, byte for byte, with the DPA's own notes",
    (specialty) => {
      const signer = {
        clinicLegalName: "Golden Paws Veterinary LLC",
        signatoryName: "Laura Owner",
        signatoryTitle: "Owner",
        signatoryEmail: "info@goldenpaws.com",
        effectiveDate: "2026-10-07",
      };
      const copy = AGREEMENT_COPY.dpa;
      let combinations = 0;
      for (const system of BOOKING_SYSTEMS) {
        for (const account of CALENDAR_ACCOUNTS) {
          const preview = copy.render({
            ...signer,
            specialty,
            isCoveredEntity: false,
            bookingSystem: system.id,
            calendarAccount: account,
          });
          const label = `${specialty} ${system.id} ${account}`;
          expect(preview.text, label).toBe(
            serverRenderDpa({
              ...signer,
              specialty,
              bookingSystem: system.id,
              calendarAccount: account,
            }),
          );
          // Every note is the DPA's, for a clause this document carries; none is the BAA's.
          for (const note of preview.notes) {
            expect(note.plain, label).toBe(dpaClauseExplainer(copy.version, note.id)!.plain);
            expect(note.citation, label).not.toMatch(/164\./);
          }
          combinations += 1;
        }
      }
      expect(combinations).toBe(8 * 3);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("AGREEMENT_COPY", () => {
  test("holds the Business Associate Agreement, with its own explainer and assent wording", () => {
    expect(AGREEMENT_COPY.baa.title).toBe("Business Associate Agreement");
    // The current version's explainer: BAA_EXPLAINER's frame above 1.3.0's bullets, which 1.4.0 keeps.
    expect(AGREEMENT_COPY.baa.explainer.heading).toBe(BAA_EXPLAINER.heading);
    expect(AGREEMENT_COPY.baa.explainer.terms).toBe(baaExplainerTerms("1.4.0"));
    expect(AGREEMENT_COPY.baa.assentLabel).toBe("I agree to the Business Associate Agreement");
    expect(AGREEMENT_COPY.baa.version).toBe(currentBaaTemplate().version);
    expect(AGREEMENT_COPY.baa.fileStem).toBe("healdesk-baa");
  });

  test("1.2.2, the version signed until 1.3.0's release, shows exactly BAA_EXPLAINER's bullets", () => {
    expect(AGREEMENT_COPY.baa.version).toBe("1.4.0");
    expect(AGREEMENT_COPY.baa.released).toBe(true);
    const v122 = baaAgreementCopy(getBaaTemplate("1.2.2")!);
    expect(v122.explainer).toBe(BAA_EXPLAINER);
    expect(v122.explainer.terms).toBe(BAA_EXPLAINER.terms);
  });

  test("an entry reads everything off its template: 1.4.0 shows its bullets, notes and text (gate 11)", () => {
    const template = getBaaTemplate("1.4.0")!;
    const copy = baaAgreementCopy(template);
    expect(copy.version).toBe("1.4.0");
    expect(copy.released).toBe(template.approvedByCounsel);
    expect(copy.explainer.terms).toBe(baaExplainerTerms("1.4.0"));
    const bullets = copy.explainer.terms.map((t) => t.plain).join("\n");
    expect(bullets).not.toMatch(/use it only|materially breach/);
    expect(bullets).toContain("limit its use and disclosure");
    expect(bullets).toContain("if you determine that we have violated a material term of it");

    const input = {
      clinicLegalName: "Glow Med Spa LLC",
      specialty: "med-spa",
      isCoveredEntity: false,
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_no_baa",
      signatoryName: "Laura Owner",
      signatoryEmail: "info@glowmedspa.com",
      effectiveDate: "2026-10-06",
    } as const;
    const preview = copy.render(input);
    expect(preview.text).toContain("Version 1.4.0 — executed electronically");
    const variables: BaaVariables = {
      ...buildBaaSelections({
        specialtyId: input.specialty,
        attributionMode: "estimated",
        bookingSystem: input.bookingSystem,
        platformId: agreementPlatformFor(input.bookingSystem),
        isCoveredEntity: input.isCoveredEntity,
        calendarAccount: input.calendarAccount,
        template,
      }),
      clinicLegalName: input.clinicLegalName,
      signatoryName: input.signatoryName,
      signatoryEmail: input.signatoryEmail,
      effectiveDate: input.effectiveDate,
    };
    expect(preview.text).toBe(renderBaa(template, variables));
    expect(preview.notes.map(({ id, plain }) => [id, plain])).toEqual(
      applicableClauses(template, variables).flatMap((clause) => {
        const note = clauseExplainer("1.4.0", clause.id);
        return note ? [[clause.id, note.plain]] : [];
      }),
    );
    // The current entry, 1.4.0's since its release, is the same explainer, and
    // building another leaves it untouched.
    expect(AGREEMENT_COPY.baa.explainer).toBe(copy.explainer);
    expect(baaAgreementCopy(getBaaTemplate("1.2.2")!).explainer).toBe(BAA_EXPLAINER);
  });

  test("holds the Data Protection Agreement too, unreleased, with its own explainer and assent wording", () => {
    const dpa = AGREEMENT_COPY.dpa;
    expect(agreementCopyFor("dpa")).toBe(dpa);
    expect(dpa.kind).toBe("dpa");
    expect(dpa.title).toBe("Data Protection Agreement");
    expect(dpa.explainer).toBe(DPA_EXPLAINER);
    expect(dpa.explainer).not.toBe(BAA_EXPLAINER);
    expect(dpa.assentLabel).toBe(DPA_ASSENT_LABEL);
    expect(dpa.assentSentence("Golden Paws LLC")).not.toMatch(/Business Associate/);
    expect(dpa.version).toBe(currentDpaTemplate().version);
    expect(dpa.released).toBe(false);
    expect(dpa.fileStem).toBe("healdesk-dpa");
  });

  test("nothing reaches the DPA's entry while it is unreleased: the decision never names it", () => {
    for (const s of specialties) {
      for (const covered of [...COVERED_ANSWERS, null] as (CoveredAnswer | null)[]) {
        const choice = agreementKindFor({ specialty: s.id, covered });
        if (choice.ok) expect(choice.kind, `${s.id} ${covered}`).toBe("baa");
      }
    }
  });

  test("a version is labelled as the document prints it", () => {
    expect(versionLabel("1.2.1")).toBe("1.2.1");
    expect(versionLabel("1.1.0-draft")).toBe("1.1.0-draft");
    expect(versionLabel("dpa/1.0.0")).toBe("1.0.0");
    expect(prepareDpa(currentDpaTemplate(), DPA_SIGNER_VARIABLES).text).toContain(
      `Version ${versionLabel(currentDpaTemplate().version)} — executed electronically`,
    );
  });

  test("dates the document in UTC, as the server does", () => {
    expect(effectiveDateToday(new Date("2026-10-06T23:30:00-07:00"))).toBe("2026-10-07");
  });
});
