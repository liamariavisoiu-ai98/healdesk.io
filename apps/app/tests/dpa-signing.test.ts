import { randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
  dpaAssentSentence,
  prepareDpa,
  SIGNATURE_HEADER,
  sign,
  TIMESTAMP_HEADER,
  type DpaVariables,
} from "@healdesk/catalog";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { POST as signRoute } from "@/app/api/agreements/route";
import {
  AgreementError,
  agreementKindForRequest,
  prepareAgreement,
  prepareDpaAgreement,
  signableDpaTemplate,
  signAgreement,
  validateSignRequest,
  type SignableOptions,
  type SignAgreementRequest,
  type SignedAgreement,
} from "@/lib/agreements";
import { renderAgreementCopy, type AgreementCopyRequest } from "@/lib/email/agreement-copy";
import { ProvisioningError, provisionClinic, type ProvisionRequest } from "@/lib/provisioning";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * Signing the Data Protection Agreement (plan Part L), the path a veterinary
 * practice and a practice that answered "No" take once the owner releases it:
 * rendered through prepareDpa, stored as `dpa/1.0.0` with its own variables,
 * held to the BAA path's refusals by field, its displayed-hash comparison and
 * its released-templates-only rule, and sent to the signer as a PDF and an
 * email that name the document they signed.
 *
 * The template is unreleased, as it must be until the owner releases it, and
 * nothing here flips its flag. A test signs as after the release by passing
 * `dpaReleased` (`RELEASED`), the same stand-in agreementKindFor takes; and
 * provisioning, which reads the bound row's own template, is shown the
 * release through `release`, which changes only what `getDpaTemplate`
 * reports, as tests/agreement-kinds.test.ts does.
 */
const release = vi.hoisted(() => ({ dpa: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    getDpaTemplate: (version: string) => {
      const template = actual.getDpaTemplate(version);
      return template && release.dpa ? { ...template, approvedByCounsel: true } : template;
    },
  };
});

/** The signer's copy, caught on its way to the transport, which the real renderers built. */
const sent = vi.hoisted(() => ({ copies: [] as unknown[] }));
vi.mock("@/lib/email/agreement-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/agreement-copy")>();
  return {
    ...actual,
    sendAgreementCopy: async (request: unknown) => {
      sent.copies.push(request);
      return { sent: false, status: "skipped", reason: "No transport in this test." };
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Standing in for the owner's release of the DPA. Its own flag stays false. */
const RELEASED = { dpaReleased: true } satisfies SignableOptions;

/** The effective date the signing tests fix, so no test depends on the day it runs. */
const DATE = "2026-10-07";

/** A veterinary practice's signature request, as the funnel's agreement step builds it. */
function vetRequest(over: Partial<SignAgreementRequest> = {}): SignAgreementRequest {
  return {
    clinicLegalName: "Golden Paws Veterinary LLC",
    specialty: "veterinary",
    signatoryName: "Laura Owner",
    signatoryTitle: "Owner",
    signatoryEmail: "Info@GoldenPaws.test",
    // Never asked of a vet; the funnel sends agreementKindFor's reading.
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform: agreementPlatformFor("google_calendar"),
    bookingSystem: "google_calendar",
    calendarAccount: "personal",
    assentLabel: DPA_ASSENT_LABEL,
    templateVersion: currentDpaTemplate().version,
    ...over,
  };
}

/** A med spa that bills no insurance electronically, on Mindbody, which reads no Google Calendar. */
function noRequest(over: Partial<SignAgreementRequest> = {}): SignAgreementRequest {
  return vetRequest({
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    signatoryEmail: "info@glowmedspa.test",
    isCoveredEntity: false,
    platform: agreementPlatformFor("mindbody"),
    bookingSystem: "mindbody",
    calendarAccount: "workspace_no_baa",
    ...over,
  });
}

/** The DPA a request signs on DATE, as the funnel's preview renders and hashes it. */
function displayed(request: SignAgreementRequest): ReturnType<typeof prepareDpa> {
  const variables: DpaVariables = {
    clinicLegalName: request.clinicLegalName.trim(),
    signatoryName: request.signatoryName.trim(),
    signatoryTitle: request.signatoryTitle?.trim() || undefined,
    signatoryEmail: request.signatoryEmail.trim().toLowerCase(),
    effectiveDate: DATE,
    specialty: request.specialty as DpaVariables["specialty"],
    bookingSystem: request.bookingSystem!,
    calendarAccount: request.calendarAccount!,
  };
  return prepareDpa(currentDpaTemplate(), variables);
}

/** The refusal a synchronous call makes, so a test can read the field it names. */
function refusal(run: () => unknown): AgreementError {
  try {
    run();
  } catch (error) {
    if (error instanceof AgreementError) return error;
    throw error;
  }
  throw new Error("Expected an AgreementError; nothing was refused.");
}

describe("which agreement, and whether it can be signed", () => {
  test("once released, a vet and a No are sent to the DPA; a Yes or a not sure stays on the BAA", () => {
    expect(agreementKindForRequest(vetRequest(), RELEASED)).toBe("dpa");
    expect(agreementKindForRequest(vetRequest({ isCoveredEntity: null }), RELEASED)).toBe("dpa");
    expect(agreementKindForRequest(noRequest(), RELEASED)).toBe("dpa");
    for (const isCoveredEntity of [true, null]) {
      expect(agreementKindForRequest(noRequest({ isCoveredEntity }), RELEASED)).toBe("baa");
    }
    expect(agreementKindForRequest({ specialty: "dental", isCoveredEntity: false }, RELEASED)).toBe(
      "baa",
    );
  });

  test("with the flag off, signing a DPA refuses exactly as before", () => {
    // A vet has nothing to sign: refused by name, before any other field.
    expect(refusal(() => validateSignRequest(vetRequest()))).toMatchObject({
      message: "This specialty can't sign up yet.",
      field: "specialty",
    });
    expect(refusal(() => prepareDpaAgreement(vetRequest(), DATE))).toMatchObject({
      field: "specialty",
    });
    // A No signs the BAA, as it always has: the DPA's label and version are refused.
    expect(agreementKindForRequest(noRequest())).toBe("baa");
    expect(refusal(() => validateSignRequest(noRequest()))).toMatchObject({
      field: "assentLabel",
    });
    expect(
      refusal(() => validateSignRequest(noRequest({ assentLabel: BAA_ASSENT_LABEL }))),
    ).toMatchObject({ message: "Unknown agreement version.", field: "templateVersion" });
    expect(refusal(() => prepareDpaAgreement(noRequest(), DATE))).toMatchObject({
      message: "This practice signs the Business Associate Agreement, not this one.",
      field: "specialty",
    });
    // And the DPA template itself is not signable while its flag is false.
    expect(refusal(() => signableDpaTemplate(currentDpaTemplate().version))).toMatchObject({
      message: "The Data Protection Agreement can't be signed yet.",
      field: "templateVersion",
    });
  });

  test("released, only the current DPA signs: no BAA version, no unknown version", () => {
    expect(signableDpaTemplate("dpa/1.0.0", RELEASED)).toBe(currentDpaTemplate());
    for (const version of [CURRENT_BAA_VERSION, "1.3.0", "1.0.0"]) {
      expect(
        refusal(() => signableDpaTemplate(version, RELEASED)),
        version,
      ).toMatchObject({
        message: "This practice signs the Data Protection Agreement. Please reload and review it.",
        field: "templateVersion",
      });
    }
    for (const version of ["dpa/9.9.9", "dpa/", undefined, 7]) {
      expect(
        refusal(() => signableDpaTemplate(version, RELEASED)),
        String(version),
      ).toMatchObject({ message: "Unknown agreement version.", field: "templateVersion" });
    }
  });
});

/**
 * The same 422-by-field checks as the BAA path: each refusal names the field a
 * client keys its message to, before anything is rendered or written.
 */
describe("the DPA's refusals, by field", () => {
  test("accepts a complete vet signature and a complete No", () => {
    expect(() => validateSignRequest(vetRequest(), RELEASED)).not.toThrow();
    expect(() => validateSignRequest(noRequest(), RELEASED)).not.toThrow();
    // A vet the funnel never asked may send no answer at all.
    expect(() =>
      validateSignRequest(vetRequest({ isCoveredEntity: null }), RELEASED),
    ).not.toThrow();
  });

  test("names the field of everything it refuses", () => {
    const cases: [Partial<SignAgreementRequest> | Record<string, unknown>, string][] = [
      [{ clinicLegalName: " " }, "clinicLegalName"],
      [{ specialty: "astrology" }, "specialty"],
      [{ signatoryName: "L" }, "signatoryName"],
      [{ signatoryEmail: "not an address" }, "signatoryEmail"],
      [{ isCoveredEntity: "maybe" }, "isCoveredEntity"],
      // A "yes" never reaches the DPA from the funnel, which never asks a vet.
      [{ isCoveredEntity: true }, "isCoveredEntity"],
      [{ attributionMode: "sometimes" }, "attributionMode"],
      [{ bookingSystem: "zenoti" }, "bookingSystem"],
      [{ calendarAccount: "gmail" }, "calendarAccount"],
      [{ bookingSystem: undefined }, "bookingSystem"],
      [{ calendarAccount: undefined }, "calendarAccount"],
      [{ platform: "mindbody" }, "platform"],
      [{ platform: "zenoti" }, "platform"],
      // The BAA's button is not this document's.
      [{ assentLabel: BAA_ASSENT_LABEL }, "assentLabel"],
      [{ assentLabel: "" }, "assentLabel"],
      [{ displayedHash: "abc" }, "displayedHash"],
      [{ templateVersion: CURRENT_BAA_VERSION }, "templateVersion"],
      [{ templateVersion: "dpa/9.9.9" }, "templateVersion"],
    ];
    for (const [over, field] of cases) {
      expect(
        refusal(() => validateSignRequest({ ...vetRequest(), ...over }, RELEASED)),
        JSON.stringify(over),
      ).toMatchObject({ field });
    }
  });

  test("never signs verified reporting, whatever phase two's switch says", () => {
    vi.stubEnv("HEALDESK_PHASE_TWO_ATTRIBUTION", "true");
    try {
      expect(
        refusal(() =>
          validateSignRequest(
            noRequest({ attributionMode: "verified", platform: "mindbody" }),
            RELEASED,
          ),
        ),
      ).toMatchObject({
        message: "The Data Protection Agreement describes no verified reporting.",
        field: "attributionMode",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the endpoint answers a DPA it cannot sign with 422 and the field, while it is unreleased", async () => {
    const SECRET = "provision-secret-for-dpa-tests";
    vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
    try {
      for (const [request, field] of [
        [vetRequest(), "specialty"],
        [noRequest(), "assentLabel"],
      ] as [SignAgreementRequest, string][]) {
        const raw = JSON.stringify(request);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await signRoute(
          new Request("https://app.healdesk.io/api/agreements", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [TIMESTAMP_HEADER]: timestamp,
              [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
            },
            body: raw,
          }),
        );
        expect(response.status, request.specialty).toBe(422);
        expect(await response.json()).toMatchObject({ field });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the BAA's own path refuses a practice the release sends to the DPA, whoever calls", () => {
    expect(
      refusal(() =>
        prepareAgreement(
          noRequest({ assentLabel: BAA_ASSENT_LABEL, templateVersion: CURRENT_BAA_VERSION }),
          DATE,
          RELEASED,
        ),
      ),
    ).toMatchObject({
      message: "This practice signs the Data Protection Agreement, not this one.",
      field: "specialty",
    });
  });
});

describe("the DPA's render", () => {
  test("is prepareDpa's, from the request's own answers, trimmed and dated as the server dates it", () => {
    for (const request of [vetRequest(), noRequest(), vetRequest({ isCoveredEntity: null })]) {
      const { template, variables, prepared } = prepareDpaAgreement(request, DATE, RELEASED);
      expect(template).toBe(currentDpaTemplate());
      expect(prepared).toEqual(displayed(request));
      expect(variables.signatoryEmail).toBe(request.signatoryEmail.trim().toLowerCase());
      expect(variables.specialty).toBe(request.specialty);
      expect(prepared.text.startsWith("HEALDESK DATA PROTECTION AGREEMENT\n")).toBe(true);
    }
    const vet = prepareDpaAgreement(vetRequest(), DATE, RELEASED).prepared;
    expect(vet.clauseIds).toContain("status-veterinary");
    expect(vet.clauseIds).toContain("google-calendar-uncovered");
    const no = prepareDpaAgreement(noRequest(), DATE, RELEASED).prepared;
    expect(no.clauseIds).toContain("status-not-covered");
    expect(no.clauseIds).toContain("google-calendar-not-used");
  });
});

describeDb("signing the DPA", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    release.dpa = false;
    await closePools();
  });

  /** signAgreement on DATE, with only Date faked, as tests/agreements.test.ts signs. */
  async function signOnDate(
    request: SignAgreementRequest,
    options: SignableOptions = RELEASED,
  ): Promise<SignedAgreement> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DATE}T15:00:00.000Z`));
    try {
      return await signAgreement(
        request,
        { ipAddress: "203.0.113.9", userAgent: "DpaTest/1.0" },
        options,
      );
    } finally {
      vi.useRealTimers();
    }
  }

  async function storedRow(agreementId: string) {
    const { rows } = await getMigratorPool().query<{
      document_version: string;
      agreement_kind: string;
      document_hash: string;
      rendered_text: string;
      variables: Record<string, unknown>;
      assent_label: string;
      accepted_by_email: string;
      organization_id: string | null;
    }>(
      `select document_version, agreement_kind, document_hash, rendered_text, variables,
              assent_label, accepted_by_email, organization_id
         from baa_acceptances where id = $1`,
      [agreementId],
    );
    return rows[0]!;
  }

  async function acceptanceCount(): Promise<number> {
    const { rows } = await getMigratorPool().query<{ n: string }>(
      `select count(*) as n from baa_acceptances`,
    );
    return Number(rows[0]!.n);
  }

  test("a vet signs it: the row stores dpa/1.0.0, the DPA kind and its variables", async () => {
    const request = vetRequest();
    const shown = displayed(request);
    const signed = await signOnDate({ ...request, displayedHash: shown.hash });

    expect(signed).toMatchObject({
      version: "dpa/1.0.0",
      hash: shown.hash,
      text: shown.text,
      clauseIds: shown.clauseIds,
      // What the row and its event record about release is the template's own flag.
      approvedByCounsel: false,
    });
    const row = await storedRow(signed.agreementId);
    expect(row.document_version).toBe("dpa/1.0.0");
    expect(row.agreement_kind).toBe("dpa");
    expect(row.document_hash).toBe(shown.hash);
    expect(row.rendered_text).toBe(shown.text);
    expect(row.assent_label).toBe(dpaAssentSentence("Golden Paws Veterinary LLC"));
    expect(row.accepted_by_email).toBe("info@goldenpaws.test");
    expect(row.organization_id).toBeNull();
    expect(row.variables).toEqual({
      clinicLegalName: "Golden Paws Veterinary LLC",
      signatoryName: "Laura Owner",
      signatoryTitle: "Owner",
      signatoryEmail: "info@goldenpaws.test",
      effectiveDate: DATE,
      specialty: "veterinary",
      bookingSystem: "google_calendar",
      calendarAccount: "personal",
      isCoveredEntity: false,
      platformId: "none",
      appliedClauses: shown.clauseIds,
      displayedHashVerified: true,
    });

    const { rows } = await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = 'baa_accepted' and metadata->>'agreementId' = $1`,
      [signed.agreementId],
    );
    expect(rows[0]!.metadata).toMatchObject({
      version: "dpa/1.0.0",
      hash: shown.hash,
      approvedByCounsel: false,
    });
  });

  test("a No signs it too, on its own status clause and its booking system's calendar clause", async () => {
    const request = noRequest();
    const shown = displayed(request);
    const signed = await signOnDate({ ...request, displayedHash: shown.hash });
    const row = await storedRow(signed.agreementId);
    expect(row.agreement_kind).toBe("dpa");
    expect(row.document_version).toBe("dpa/1.0.0");
    expect(row.variables).toMatchObject({
      specialty: "med-spa",
      bookingSystem: "mindbody",
      calendarAccount: "workspace_no_baa",
      isCoveredEntity: false,
      platformId: agreementPlatformFor("mindbody"),
      appliedClauses: signed.clauseIds,
    });
    expect(signed.clauseIds).toContain("status-not-covered");
    expect(row.rendered_text).toContain(
      "Practice warrants that this is true on the effective date.",
    );
  });

  test("the signer's copy names the document they signed: a DPA's PDF and email, by kind", async () => {
    sent.copies.length = 0;
    const signed = await signOnDate(vetRequest());
    expect(signed.copy).toMatchObject({ status: "skipped" });
    expect(sent.copies).toHaveLength(1);
    const copy = sent.copies[0] as AgreementCopyRequest;
    expect(copy.version).toBe("dpa/1.0.0");
    expect(copy.documentHash).toBe(signed.hash);
    // Dated by the acceptance, which the database stamps, not by the document's effective date.
    expect(copy.filename).toBe(
      `healdesk-dpa-1.0.0-${copy.acceptedAt.toISOString().slice(0, 10)}.pdf`,
    );
    const pdf = await PDFDocument.load(copy.pdf);
    expect(pdf.getTitle()).toBe("healdesk Data Protection Agreement dpa/1.0.0");

    // The real wording: only the send is stood in for.
    const email = renderAgreementCopy(copy);
    expect(email.subject).toBe(
      "Your signed data protection agreement for Golden Paws Veterinary LLC",
    );
    expect(email.text).toContain("is the data protection agreement you signed for");
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/business associate|\bpatients?\b|\bPHI\b/i);
    }
  });

  test("a tampered displayed hash is refused, and nothing is written", async () => {
    const before = await acceptanceCount();
    for (const displayedHash of ["0".repeat(64), displayed(noRequest()).hash]) {
      await expect(signOnDate({ ...vetRequest(), displayedHash })).rejects.toMatchObject({
        field: "displayedHash",
      });
    }
    expect(await acceptanceCount()).toBe(before);
  });

  test("with the flag off, a direct call refuses a DPA and writes nothing", async () => {
    const before = await acceptanceCount();
    await expect(signOnDate(vetRequest(), {})).rejects.toMatchObject({ field: "specialty" });
    // A No under the DPA's label and version: the BAA path's, and refused as such.
    await expect(signOnDate(noRequest(), {})).rejects.toMatchObject({ field: "templateVersion" });
    expect(await acceptanceCount()).toBe(before);
  });

  test("the BAA path is unchanged beside it: a Yes still signs the current BAA", async () => {
    const signed = await signOnDate(
      noRequest({
        clinicLegalName: "Covered Med Spa LLC",
        isCoveredEntity: true,
        assentLabel: BAA_ASSENT_LABEL,
        templateVersion: CURRENT_BAA_VERSION,
      }),
    );
    const row = await storedRow(signed.agreementId);
    expect(row.document_version).toBe(CURRENT_BAA_VERSION);
    expect(row.agreement_kind).toBe("baa");
    expect(row.rendered_text.startsWith("HEALDESK BUSINESS ASSOCIATE AGREEMENT")).toBe(true);
    expect(row.variables).toMatchObject({ isCoveredEntity: true, specialty: expect.any(String) });
  });

  function provisionRequest(over: Partial<ProvisionRequest>): ProvisionRequest {
    return {
      clinicName: "Golden Paws Veterinary LLC",
      specialty: "veterinary",
      platform: "none",
      plan: "voice-webchat-1000-1000",
      contactName: "Laura Owner",
      contactEmail: `laura-${randomUUID().slice(0, 8)}@goldenpaws.test`,
      agreementId: randomUUID(),
      idempotencyKey: `test_${randomUUID()}`,
      ...over,
    };
  }

  test("provisioning refuses a signed DPA while it is unreleased, and binds it once released", async () => {
    const signed = await signOnDate(vetRequest({ clinicLegalName: "Bound Paws LLC" }));

    release.dpa = false;
    const refused = provisionRequest({
      agreementId: signed.agreementId,
      clinicName: "Bound Paws LLC",
    });
    await expect(provisionClinic(refused)).rejects.toThrow(/not released/);
    expect((await storedRow(signed.agreementId)).organization_id).toBeNull();

    release.dpa = true;
    try {
      const result = await provisionClinic(
        provisionRequest({ agreementId: signed.agreementId, clinicName: "Bound Paws LLC" }),
      );
      expect((await storedRow(signed.agreementId)).organization_id).toBe(result.organizationId);
      const { rows } = await getMigratorPool().query<{
        regulatory_regime: string;
        agreement_kind: string;
        is_covered_entity: boolean | null;
      }>(`select regulatory_regime, agreement_kind, is_covered_entity from clinics where id = $1`, [
        result.clinicId,
      ]);
      expect(rows[0]).toEqual({
        regulatory_regime: "non-hipaa",
        agreement_kind: "dpa",
        is_covered_entity: false,
      });

      // Released, it still binds only the practice it was written for.
      const other = await signOnDate(vetRequest({ clinicLegalName: "Other Paws LLC" }));
      await expect(
        provisionClinic(
          provisionRequest({
            agreementId: other.agreementId,
            specialty: "med-spa",
            clinicName: "Other Paws LLC",
          }),
        ),
      ).rejects.toBeInstanceOf(ProvisioningError);
    } finally {
      release.dpa = false;
    }
  });
});
