import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { AgreementPdfRecord } from "./agreement-pdf";
import {
  renderSignedDocument,
  storedAssentSentence,
  storedVariables,
  type PreparedSigning,
} from "./agreement-signing";
import { agreementKindOfVersion, type AgreementKind } from "./agreement-kind";
import { IntentError, validateIntentRequest, type IntentRequest } from "./checkout-intent";

/**
 * The checkout records: the signed agreement and the purchase, kept by
 * apps/web in the marketing Sheet from the moment they are made until the
 * clinic is provisioned on apps/app, which imports them.
 *
 * ## Why they exist (owner, 14 October 2026)
 *
 * "The agreement and checkout record can also be saved on Vercel instead of
 * AWS." The AWS host has a standby mode that removes its database and load
 * balancer until the first clinic pays, so a buyer must be able to sign the
 * agreement, pay and land somewhere honest with the host off. Until then the
 * signature was a row apps/app wrote at signing and the purchase a row it
 * wrote when Pay was pressed; now both are records apps/web writes, and
 * apps/app takes them in when the first invoice is paid, with the host back
 * (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * Neither is PHI: a clinic owner's name, work email, title, IP address and
 * user agent are business contact data, which is why checkout has always sat
 * on apps/web. They are business data that a contract rests on, though, and
 * a spreadsheet anyone with access can edit, so:
 *
 * ## Every record is sealed
 *
 * A record is canonical JSON (keys sorted at every level, nothing but JSON
 * values) and an HMAC-SHA256 over exactly those bytes, keyed by
 * `HMAC(HEALDESK_PROVISION_SECRET, "healdesk/checkout-record/v1")`: the secret
 * the two apps already share for their signed calls, under a purpose of its
 * own, so a seal can never be replayed as a request signature or the reverse.
 * apps/app holds the same secret and refuses a record whose seal does not
 * match, so an edit made in the Sheet between signing and provisioning is
 * found, not imported. The record carries its own kind (`record`) and format
 * (`v`) inside the seal, so an intent can never be presented as an agreement.
 *
 * ## The agreement record stores no text
 *
 * It stores what re-renders the document exactly: the template version and
 * kind, the variables as they were rendered, the clauses that applied and the
 * effective date, with the document's hash beside them. The text is derived
 * again with the catalogue's renderer wherever it is needed (the PDF, the
 * import) and its hash compared with the recorded one (`checkAgreementRecord`),
 * so a record cannot carry a text that is not the template's. The renderer is
 * deterministic (apps/app tests/baa-golden.test.ts pins it), which is what
 * makes that sound.
 *
 * ## Cells
 *
 * A Sheet cell holds at most 50,000 characters, and the purchase's website
 * read can reach 200 kB. A record is written as `j<json>` when it fits one
 * cell and `z<base64 of gzip of the json>` when it does not, split across up
 * to RECORD_CELLS consecutive cells of RECORD_CELL_CHARS each, in the same row
 * (`packRecordCells`). The seal is over the JSON, never over the cells, so the
 * storage encoding can change without invalidating a record. A record whose
 * JSON exceeds MAX_RECORD_JSON_CHARS, or whose encoding needs more cells, is
 * refused rather than truncated.
 *
 * Server-side only (node:crypto, node:zlib): a subpath export,
 * `@healdesk/catalog/checkout-record`.
 */

export const CHECKOUT_RECORD_PURPOSE = "healdesk/checkout-record/v1";

/** Characters per Sheet cell a record is split into: Google's limit is 50,000. */
export const RECORD_CELL_CHARS = 45_000;

/** How many consecutive cells a record may take in its row. */
export const RECORD_CELLS = 8;

/**
 * The largest record, in characters of its JSON. A purchase is a few hundred
 * characters plus a website read of at most CHECKOUT_PROFILE_MAX_CHARS
 * (200,000), so this is the read's cap with room to spare, and well inside
 * what eight cells hold even when gzip cannot shrink it.
 */
export const MAX_RECORD_JSON_CHARS = 262_144;

export class CheckoutRecordError extends Error {
  constructor(
    message: string,
    readonly reason: "too_large" | "not_json",
  ) {
    super(message);
    this.name = "CheckoutRecordError";
  }
}

// -----------------------------------------------------------------------------
// Canonical JSON and the seal
// -----------------------------------------------------------------------------

/**
 * JSON with every object's keys sorted, so one value has one spelling and its
 * seal does not depend on the order a builder happened to write fields in.
 * Undefined object members are dropped, as JSON.stringify drops them; anything
 * that is not a JSON value (a function, a symbol, a bigint, a non-finite
 * number, a Date or any other class instance, an undefined array element) is
 * refused rather than silently changed.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CheckoutRecordError(`${path} is not a finite number.`, "not_json");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, index) => {
            if (item === undefined) throw new CheckoutRecordError(`${path}[${index}] is undefined.`, "not_json");
            return encode(item, `${path}[${index}]`);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CheckoutRecordError(`${path} is not a plain object.`, "not_json");
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${encode(member, `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new CheckoutRecordError(`${path} is not a JSON value.`, "not_json");
  }
}

/** The seal key: the shared secret under this record format's own purpose. */
function sealKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(CHECKOUT_RECORD_PURPOSE).digest();
}

/** HMAC-SHA256 over the JSON's UTF-8 bytes, base64url. */
export function sealOf(json: string, secret: string): string {
  return createHmac("sha256", sealKey(secret)).update(json, "utf8").digest("base64url");
}

/** A record as it travels: the canonical JSON and its seal. */
export type SealedRecord = { json: string; seal: string };

export function sealRecord(record: AgreementRecord | IntentRecord, secret: string): SealedRecord {
  if (!secret) throw new Error("A checkout record cannot be sealed without HEALDESK_PROVISION_SECRET.");
  const json = canonicalJson(record);
  if (json.length > MAX_RECORD_JSON_CHARS) {
    throw new CheckoutRecordError(
      `The record is ${json.length} characters; the most a record may be is ${MAX_RECORD_JSON_CHARS}.`,
      "too_large",
    );
  }
  return { json, seal: sealOf(json, secret) };
}

/**
 * The record a seal vouches for, parsed, or null when the seal is not this
 * secret's over exactly these bytes (or either is missing, or the JSON does not
 * parse). Constant-time comparison; nothing about the record is read before
 * the seal is checked.
 */
export function openSealedRecord(sealed: unknown, secret: string): unknown | null {
  if (!secret || !sealed || typeof sealed !== "object") return null;
  const { json, seal } = sealed as { json?: unknown; seal?: unknown };
  if (typeof json !== "string" || typeof seal !== "string" || json.length === 0 || seal.length === 0) return null;
  if (json.length > MAX_RECORD_JSON_CHARS) return null;
  const expected = Buffer.from(sealOf(json, secret));
  const received = Buffer.from(seal);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------------

/**
 * The cells a record's JSON is written to: always RECORD_CELLS of them, the
 * unused ones empty, so a rewrite of a smaller record clears what a larger one
 * left. Throws CheckoutRecordError("too_large") rather than truncate.
 */
export function packRecordCells(json: string): string[] {
  if (json.length > MAX_RECORD_JSON_CHARS) {
    throw new CheckoutRecordError(
      `The record is ${json.length} characters; the most a record may be is ${MAX_RECORD_JSON_CHARS}.`,
      "too_large",
    );
  }
  const payload =
    json.length + 1 <= RECORD_CELL_CHARS
      ? `j${json}`
      : `z${gzipSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64")}`;
  const cells: string[] = [];
  for (let at = 0; at < payload.length; at += RECORD_CELL_CHARS) {
    cells.push(payload.slice(at, at + RECORD_CELL_CHARS));
  }
  if (cells.length > RECORD_CELLS) {
    throw new CheckoutRecordError(
      `The record needs ${cells.length} cells; a row holds ${RECORD_CELLS}.`,
      "too_large",
    );
  }
  while (cells.length < RECORD_CELLS) cells.push("");
  return cells;
}

/** The JSON a row's record cells hold, or null when they hold nothing readable. */
export function unpackRecordCells(cells: readonly unknown[]): string | null {
  const payload = cells.map((cell) => (cell === undefined || cell === null ? "" : String(cell))).join("");
  if (payload.startsWith("j")) return payload.slice(1);
  if (payload.startsWith("z")) {
    try {
      const json = gunzipSync(Buffer.from(payload.slice(1), "base64"), {
        maxOutputLength: MAX_RECORD_JSON_CHARS * 4,
      }).toString("utf8");
      return json.length <= MAX_RECORD_JSON_CHARS ? json : null;
    } catch {
      return null;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// The agreement record
// -----------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

/** The evidence that the signer's copy went out: when, and the SHA-256 of the PDF file. */
export type CopyEvidence = { sentAt: string; pdfSha256: string };

/**
 * One signature, as apps/web records it and apps/app imports it into
 * `baa_acceptances` (the same id, the same accepted-at, the text re-rendered).
 */
export type AgreementRecord = {
  record: "agreement";
  v: 1;
  /** The acceptance id, a UUID made at signing; the row apps/app imports keeps it. */
  id: string;
  kind: AgreementKind;
  /** The template version, a DPA's namespaced ("dpa/1.0.0"). */
  documentVersion: string;
  /** SHA-256 of the rendered text, hex. */
  documentHash: string;
  /** The UTC day of the signature, which the document names. */
  effectiveDate: string;
  /** The variables the document was rendered from, exactly. */
  variables: Record<string, unknown>;
  /** The answers kept beside the document, outside its hash (agreement-signing.ts). */
  answers: Record<string, unknown>;
  /** The variant that applied. */
  appliedClauses: string[];
  /** Whether the hash of what the screen displayed was checked. */
  displayedHashVerified: boolean;
  /** The template's own release flag, at signing. */
  approvedByCounsel: boolean;
  /** The full sentence beside the tick box, re-derived from the clinic's legal name. */
  assentLabel: string;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** When the signature was recorded, ISO 8601 UTC with milliseconds. */
  acceptedAt: string;
  /** Written once, when the copy has gone. */
  copy: CopyEvidence | null;
};

/** The record of a signature `prepareSigning` has just prepared and checked. */
export function agreementRecordFrom(
  prepared: PreparedSigning,
  facts: { id: string; acceptedAt: Date; ipAddress: string | null; userAgent: string | null },
): AgreementRecord {
  return {
    record: "agreement",
    v: 1,
    id: facts.id,
    kind: prepared.kind,
    documentVersion: prepared.version,
    documentHash: prepared.hash,
    effectiveDate: prepared.effectiveDate,
    // Through JSON once, so `undefined` members (an absent title) are gone
    // here rather than at sealing, and what is returned is what is sealed.
    variables: JSON.parse(JSON.stringify(prepared.documentVariables)) as Record<string, unknown>,
    answers: JSON.parse(JSON.stringify(prepared.answers)) as Record<string, unknown>,
    appliedClauses: [...prepared.clauseIds],
    displayedHashVerified: prepared.stored.displayedHashVerified === true,
    approvedByCounsel: prepared.approvedByCounsel,
    assentLabel: prepared.assentSentence,
    signatoryName: prepared.signatoryName,
    signatoryEmail: prepared.signatoryEmail,
    signatoryTitle: prepared.signatoryTitle,
    ipAddress: clip(facts.ipAddress, 64),
    userAgent: clip(facts.userAgent, 512),
    acceptedAt: facts.acceptedAt.toISOString(),
    copy: null,
  };
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Why a record was refused: the shape, or the document it describes. */
export type AgreementRecordProblem =
  | "shape"
  | "unknown_version"
  | "hash_mismatch"
  | "clauses_mismatch"
  | "inconsistent";

export type CheckedAgreement =
  | { ok: true; record: AgreementRecord; text: string }
  | { ok: false; problem: AgreementRecordProblem; detail: string };

/**
 * A record's shape, and the document it describes rendered again: refused
 * unless the re-rendered text hashes to the recorded hash, the same clauses
 * applied, and what the record says about the signer is what the document
 * says. The text comes back, for the PDF and for the import, so nobody uses
 * a text the template did not produce.
 *
 * The seal is checked first, by `openSealedRecord`; this checks what the seal
 * cannot, that the record is one of ours in a form the catalogue can still
 * read, and that the template still renders it to the bytes that were signed.
 */
export function checkAgreementRecord(value: unknown): CheckedAgreement {
  const shape = (detail: string): CheckedAgreement => ({ ok: false, problem: "shape", detail });
  if (!value || typeof value !== "object" || Array.isArray(value)) return shape("not an object");
  const r = value as Partial<AgreementRecord>;
  if (r.record !== "agreement" || r.v !== 1) return shape("not an agreement record of format 1");
  if (typeof r.id !== "string" || !UUID.test(r.id)) return shape("id");
  if (typeof r.documentVersion !== "string" || !r.documentVersion) return shape("documentVersion");
  if (r.kind !== agreementKindOfVersion(r.documentVersion)) return shape("kind");
  if (typeof r.documentHash !== "string" || !SHA256_HEX.test(r.documentHash)) return shape("documentHash");
  if (typeof r.effectiveDate !== "string" || !ISO_DAY.test(r.effectiveDate)) return shape("effectiveDate");
  if (!isPlainObject(r.variables)) return shape("variables");
  if (!isPlainObject(r.answers)) return shape("answers");
  if (!Array.isArray(r.appliedClauses) || !r.appliedClauses.every((c) => typeof c === "string")) {
    return shape("appliedClauses");
  }
  if (typeof r.displayedHashVerified !== "boolean") return shape("displayedHashVerified");
  if (typeof r.approvedByCounsel !== "boolean") return shape("approvedByCounsel");
  for (const field of ["assentLabel", "signatoryName", "signatoryEmail", "acceptedAt"] as const) {
    if (typeof r[field] !== "string" || !r[field]) return shape(field);
  }
  for (const field of ["signatoryTitle", "ipAddress", "userAgent"] as const) {
    if (r[field] !== null && typeof r[field] !== "string") return shape(field);
  }
  const acceptedAt = new Date(r.acceptedAt as string);
  if (Number.isNaN(acceptedAt.getTime()) || acceptedAt.toISOString() !== r.acceptedAt) return shape("acceptedAt");
  if (r.copy !== null) {
    if (
      !isPlainObject(r.copy) ||
      typeof r.copy.sentAt !== "string" ||
      Number.isNaN(Date.parse(r.copy.sentAt)) ||
      typeof r.copy.pdfSha256 !== "string" ||
      !SHA256_HEX.test(r.copy.pdfSha256)
    ) {
      return shape("copy");
    }
  }
  const record = r as AgreementRecord;

  const rendered = renderSignedDocument(record.documentVersion, record.variables);
  if (!rendered) {
    return {
      ok: false,
      problem: "unknown_version",
      detail: `version ${record.documentVersion} is not one this catalogue renders`,
    };
  }
  if (rendered.hash !== record.documentHash) {
    return { ok: false, problem: "hash_mismatch", detail: `re-rendered ${rendered.hash}, recorded ${record.documentHash}` };
  }
  if (rendered.clauseIds.join(",") !== record.appliedClauses.join(",")) {
    return { ok: false, problem: "clauses_mismatch", detail: "the clauses that apply are not the ones recorded" };
  }

  // What the record says about the signature beside the document must be
  // what the document itself says: the signer, the day and the sentence.
  const v = record.variables;
  const inconsistent =
    v.signatoryName !== record.signatoryName
      ? "signatoryName"
      : v.signatoryEmail !== record.signatoryEmail
        ? "signatoryEmail"
        : (v.signatoryTitle ?? null) !== record.signatoryTitle
          ? "signatoryTitle"
          : v.effectiveDate !== record.effectiveDate || record.effectiveDate !== record.acceptedAt.slice(0, 10)
            ? "effectiveDate"
            : typeof v.clinicLegalName !== "string" ||
                record.assentLabel !== storedAssentSentence(record.kind, v.clinicLegalName)
              ? "assentLabel"
              : null;
  if (inconsistent) {
    return { ok: false, problem: "inconsistent", detail: `${inconsistent} is not what the document says` };
  }

  return { ok: true, record, text: rendered.text };
}

/** What `baa_acceptances.variables` holds for this signature, as a signature taken on apps/app wrote it. */
export function acceptanceVariables(record: AgreementRecord): Record<string, unknown> {
  return storedVariables(record.variables, record.answers, record.appliedClauses, record.displayedHashVerified);
}

/** What the PDF renderer needs, from a checked record and the text it re-rendered. */
export function agreementPdfRecordOf(record: AgreementRecord, text: string): AgreementPdfRecord {
  return {
    documentVersion: record.documentVersion,
    documentHash: record.documentHash,
    renderedText: text,
    assentLabel: record.assentLabel,
    acceptedByName: record.signatoryName,
    acceptedByEmail: record.signatoryEmail,
    acceptedByTitle: record.signatoryTitle,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
    acceptedAt: new Date(record.acceptedAt),
  };
}

// -----------------------------------------------------------------------------
// The purchase record
// -----------------------------------------------------------------------------

/**
 * One press of Pay: the purchase as `validateIntentRequest` takes it, and the
 * Checkout Session that press opened. apps/app imports it into
 * `checkout_intents` (the same ref, attempt, nonce and session) when its
 * first invoice is paid.
 */
export type IntentRecord = {
  record: "checkout_intent";
  v: 1;
  /** This record's own id: one per press of Pay. */
  id: string;
  /** The purchase; the setup link's request id while purchases are by invitation. */
  ref: string;
  /** Which press of Pay for this ref; Stripe's idempotency key and the paid terms name it. */
  attempt: number;
  createdAt: string;
  /** When an unpaid purchase stops being one: INTENT_TTL_DAYS after it was made. */
  expiresAt: string;
  /** The purchase, as validateIntentRequest takes it. */
  intent: Record<string, unknown>;
  /** The Checkout Session this press opened, once Stripe has answered. */
  sessionId: string | null;
};

export type CheckedIntent =
  | { ok: true; record: IntentRecord; intent: IntentRequest }
  | { ok: false; problem: "shape" | "invalid_purchase"; detail: string; field?: string };

/** A purchase record's shape, and the purchase held to provisioning's rules (validateIntentRequest). */
export function checkIntentRecord(value: unknown): CheckedIntent {
  const shape = (detail: string): CheckedIntent => ({ ok: false, problem: "shape", detail });
  if (!value || typeof value !== "object" || Array.isArray(value)) return shape("not an object");
  const r = value as Partial<IntentRecord>;
  if (r.record !== "checkout_intent" || r.v !== 1) return shape("not a purchase record of format 1");
  if (typeof r.id !== "string" || !UUID.test(r.id)) return shape("id");
  if (typeof r.ref !== "string" || !UUID.test(r.ref)) return shape("ref");
  if (typeof r.attempt !== "number" || !Number.isInteger(r.attempt) || r.attempt < 1 || r.attempt > 999_999_999) {
    return shape("attempt");
  }
  for (const field of ["createdAt", "expiresAt"] as const) {
    if (typeof r[field] !== "string" || Number.isNaN(Date.parse(r[field] as string))) return shape(field);
  }
  if (r.sessionId !== null && (typeof r.sessionId !== "string" || !SESSION_ID.test(r.sessionId))) {
    return shape("sessionId");
  }
  if (!isPlainObject(r.intent)) return shape("intent");
  let intent: IntentRequest;
  try {
    intent = validateIntentRequest(r.intent);
  } catch (error) {
    if (error instanceof IntentError) {
      return { ok: false, problem: "invalid_purchase", detail: error.message, field: error.field };
    }
    throw error;
  }
  // One setup link makes one purchase, whose ref is the link's own request id.
  if (intent.inviteRef !== null && intent.inviteRef !== r.ref) {
    return shape("inviteRef is not the purchase's ref");
  }
  return { ok: true, record: r as IntentRecord, intent };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
