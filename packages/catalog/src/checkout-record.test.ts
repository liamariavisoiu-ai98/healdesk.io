import { createHash, randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY } from "./agreement-copy";
import { effectiveDateOf, prepareSigning, validateSignRequest } from "./agreement-signing";
import {
  acceptanceVariables,
  agreementPdfRecordOf,
  agreementRecordFrom,
  canonicalJson,
  checkAgreementRecord,
  checkIntentRecord,
  CheckoutRecordError,
  MAX_RECORD_JSON_CHARS,
  openSealedRecord,
  packRecordCells,
  RECORD_CELL_CHARS,
  RECORD_CELLS,
  sealOf,
  sealRecord,
  unpackRecordCells,
  type AgreementRecord,
  type IntentRecord,
} from "./checkout-record";

/**
 * The checkout records apps/web keeps in the marketing Sheet until apps/app
 * imports them (docs/design/checkout-records-on-vercel-2026-10-14.md): what
 * the seal catches, what the cells carry, and that the agreement record,
 * which stores no text, renders back to exactly the document that was signed.
 */

const SECRET = "checkout-record-test-secret";

function signedAgreement(overrides: Record<string, unknown> = {}): AgreementRecord {
  const request: Record<string, unknown> = {
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    attributionMode: "estimated",
    platform: "none",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    signatoryName: "Laura Owner",
    signatoryTitle: "Owner",
    signatoryEmail: "Laura@GlowSpa.test",
    // "Yes": a med spa that bills no insurance signs the DPA since its
    // release (20 October 2026), and this record is a BAA's.
    isCoveredEntity: true,
    assentLabel: AGREEMENT_COPY.baa.assentLabel,
    templateVersion: AGREEMENT_COPY.baa.currentVersion,
    ...overrides,
  };
  validateSignRequest(request);
  const acceptedAt = new Date("2026-10-14T09:15:30.123Z");
  const prepared = prepareSigning(request, effectiveDateOf(acceptedAt), {});
  return agreementRecordFrom(prepared, {
    id: "5d1f2e3a-4b5c-4d6e-8f70-8192a3b4c5d6",
    acceptedAt,
    ipAddress: "203.0.113.4",
    userAgent: "Mozilla/5.0 (test)",
  });
}

function purchase(record: AgreementRecord, overrides: Record<string, unknown> = {}): IntentRecord {
  return {
    record: "checkout_intent",
    v: 1,
    id: "0b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e",
    ref: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    attempt: 1,
    createdAt: "2026-10-14T09:20:00.000Z",
    expiresAt: "2026-10-28T09:20:00.000Z",
    sessionId: null,
    intent: {
      clinicName: "Glow Med Spa LLC",
      specialty: "med-spa",
      platform: "none",
      plan: "voice-webchat-500-300",
      billingInterval: "month",
      contactName: "Laura Owner",
      contactEmail: "laura@glowspa.test",
      agreementId: record.id,
      isCoveredEntity: true,
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
      website: "glowspa.test",
      profile: null,
      profileStatus: "failed",
      inviteRef: null,
      nonceHash: "a".repeat(64),
      terms: { version: "2026-10-14.1", acceptedAt: "2026-10-14T09:19:00.000Z", ip: "203.0.113.4" },
      ...overrides,
    },
  };
}

describe("canonical JSON", () => {
  test("one value has one spelling, whatever order it was built in", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x", null], c: true } })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // Undefined members are dropped, as JSON.stringify drops them.
    expect(canonicalJson({ a: undefined, b: "kept" })).toBe('{"b":"kept"}');
  });

  test("anything that is not a JSON value is refused rather than changed", () => {
    for (const value of [{ at: new Date() }, { n: Number.NaN }, { n: Infinity }, [undefined], { f: () => 1 }, { big: 1n }]) {
      expect(() => canonicalJson(value)).toThrow(CheckoutRecordError);
    }
  });
});

describe("the seal", () => {
  test("opens what it sealed, with the same secret", () => {
    const record = signedAgreement();
    const sealed = sealRecord(record, SECRET);
    expect(sealed.json).toBe(canonicalJson(record));
    expect(openSealedRecord(sealed, SECRET)).toEqual(record);
  });

  test("refuses an edit, a forged seal, another secret, and nothing at all", () => {
    const sealed = sealRecord(signedAgreement(), SECRET);
    // An edit made in the Sheet between signing and provisioning.
    const edited = { ...sealed, json: sealed.json.replace("Laura Owner", "Laura Other") };
    expect(edited.json).not.toBe(sealed.json);
    expect(openSealedRecord(edited, SECRET)).toBeNull();
    // A seal recomputed by someone without the secret.
    expect(openSealedRecord({ json: edited.json, seal: sealOf(edited.json, "a-guess") }, SECRET)).toBeNull();
    expect(openSealedRecord(sealed, "another-secret")).toBeNull();
    expect(openSealedRecord({ ...sealed, seal: `${sealed.seal.slice(0, -1)}A` }, SECRET)).toBeNull();
    expect(openSealedRecord(null, SECRET)).toBeNull();
    expect(openSealedRecord({ json: sealed.json }, SECRET)).toBeNull();
    expect(openSealedRecord(sealed, "")).toBeNull();
  });

  test("is not the request signature: the same secret over the same bytes seals differently", () => {
    const json = canonicalJson(signedAgreement());
    const requestSignature = createHash("sha256").update(json).digest("base64url");
    expect(sealOf(json, SECRET)).not.toBe(requestSignature);
  });

  test("a purchase record cannot pass for an agreement record", () => {
    const record = signedAgreement();
    const opened = openSealedRecord(sealRecord(purchase(record), SECRET), SECRET);
    expect(checkAgreementRecord(opened)).toMatchObject({ ok: false, problem: "shape" });
    expect(checkIntentRecord(openSealedRecord(sealRecord(record, SECRET), SECRET))).toMatchObject({ ok: false });
  });
});

describe("cells", () => {
  test("a small record is one plain cell, and the rest of the row is cleared", () => {
    const json = canonicalJson(signedAgreement());
    const cells = packRecordCells(json);
    expect(cells).toHaveLength(RECORD_CELLS);
    expect(cells[0]).toBe(`j${json}`);
    expect(cells.slice(1).every((cell) => cell === "")).toBe(true);
    expect(unpackRecordCells(cells)).toBe(json);
  });

  test("a purchase with a 200 kB website read round-trips across cells no larger than one may be", () => {
    const record = signedAgreement();
    // Incompressible on purpose: the worst a website read can do to gzip.
    const profile = { notes: randomBytes(100_000).toString("hex") };
    const big = purchase(record);
    big.intent.profile = profile;
    const sealed = sealRecord(big, SECRET);
    expect(sealed.json.length).toBeGreaterThan(200_000);
    const cells = packRecordCells(sealed.json);
    expect(cells[0]!.startsWith("z")).toBe(true);
    expect(cells.filter((cell) => cell !== "").length).toBeGreaterThan(1);
    expect(cells.every((cell) => cell.length <= RECORD_CELL_CHARS)).toBe(true);
    const json = unpackRecordCells(cells);
    expect(json).toBe(sealed.json);
    expect(openSealedRecord({ json, seal: sealed.seal }, SECRET)).toEqual(big);
  });

  test("a record above the cap is refused, never truncated", () => {
    const big = purchase(signedAgreement());
    big.intent.profile = { notes: "x".repeat(MAX_RECORD_JSON_CHARS) };
    expect(() => sealRecord(big, SECRET)).toThrow(CheckoutRecordError);
    expect(() => packRecordCells("x".repeat(MAX_RECORD_JSON_CHARS + 1))).toThrow(/most a record may be/);
    // And everything under the cap fits the row, even text gzip can barely
    // shrink: the cap, not the cells, is the limit a buyer can meet.
    const worst = randomBytes((MAX_RECORD_JSON_CHARS * 3) / 4).toString("base64").slice(0, MAX_RECORD_JSON_CHARS);
    expect(unpackRecordCells(packRecordCells(worst))).toBe(worst);
  });

  test("cells that hold nothing readable read as nothing", () => {
    expect(unpackRecordCells(["", "", ""])).toBeNull();
    expect(unpackRecordCells(["zthis is not gzip"])).toBeNull();
    expect(unpackRecordCells(["{}"])).toBeNull();
  });
});

describe("the agreement record", () => {
  test("stores no text, and renders back to exactly the document signed", () => {
    const record = signedAgreement();
    expect(JSON.stringify(record)).not.toContain("BUSINESS ASSOCIATE AGREEMENT");
    const checked = checkAgreementRecord(record);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(createHash("sha256").update(checked.text, "utf8").digest("hex")).toBe(record.documentHash);
    expect(record.signatoryEmail).toBe("laura@glowspa.test");
    expect(record.effectiveDate).toBe("2026-10-14");
  });

  test("the row apps/app imports holds what a signature taken there would have stored", () => {
    const record = signedAgreement();
    const variables = acceptanceVariables(record);
    expect(variables).toMatchObject({
      clinicLegalName: "Glow Med Spa LLC",
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
      platformId: "none",
      appliedClauses: record.appliedClauses,
      displayedHashVerified: false,
    });
    const pdf = agreementPdfRecordOf(record, "text");
    expect(pdf).toMatchObject({ acceptedByName: "Laura Owner", acceptedByTitle: "Owner", ipAddress: "203.0.113.4" });
    expect(pdf.acceptedAt.toISOString()).toBe("2026-10-14T09:15:30.123Z");
  });

  test("is refused when it no longer renders to its hash, or says other than its document", () => {
    const record = signedAgreement();
    // A sealed record can still be one whose variables were changed with the
    // hash left alone: the text it renders is not the text that was signed.
    const renamed = { ...record, variables: { ...record.variables, clinicLegalName: "Other Spa LLC" } };
    expect(checkAgreementRecord(renamed)).toMatchObject({ ok: false, problem: "hash_mismatch" });
    expect(checkAgreementRecord({ ...record, signatoryName: "Someone Else" })).toMatchObject({
      ok: false,
      problem: "inconsistent",
    });
    expect(checkAgreementRecord({ ...record, documentVersion: "9.9.9" })).toMatchObject({
      ok: false,
      problem: "unknown_version",
    });
    expect(checkAgreementRecord({ ...record, appliedClauses: [] })).toMatchObject({ ok: false, problem: "clauses_mismatch" });
    expect(checkAgreementRecord({ ...record, acceptedAt: "yesterday" })).toMatchObject({ ok: false, problem: "shape" });
  });
});

describe("the purchase record", () => {
  test("is held to provisioning's rules, by the field the funnel names", () => {
    const record = signedAgreement();
    expect(checkIntentRecord(purchase(record))).toMatchObject({ ok: true });
    expect(checkIntentRecord(purchase(record, { plan: "web-voice" }))).toMatchObject({
      ok: false,
      problem: "invalid_purchase",
      field: "plan",
    });
    expect(checkIntentRecord(purchase(record, { nonceHash: "short" }))).toMatchObject({ field: "nonceHash" });
    // One setup link makes one purchase, whose ref is the link's own id.
    expect(checkIntentRecord(purchase(record, { inviteRef: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }))).toMatchObject({
      ok: false,
      problem: "shape",
    });
    expect(checkIntentRecord({ ...purchase(record), attempt: 0 })).toMatchObject({ ok: false, problem: "shape" });
    expect(checkIntentRecord({ ...purchase(record), sessionId: "pi_123" })).toMatchObject({ ok: false, problem: "shape" });
  });
});
