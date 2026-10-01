/**
 * Guards every adapter runs its output through.
 *
 * Adapters map untrusted third-party payloads into our canonical model. These
 * are the checks that stop a malformed or hostile response becoming a bad row,
 * a leaked log line, or a clinical claim.
 */

/** Words that would make an annotation read as clinical rather than administrative. */
const CLINICAL_TERMS = [
  "diagnos",
  "prescrib",
  "dosage",
  "dose ",
  "contraindicat",
  "symptom",
  "treatment plan",
  "medical advice",
  "you should take",
  "recommend taking",
];

export class ClinicalContentError extends Error {
  constructor(matched: string) {
    super(
      `Refusing to write clinical content: matched "${matched}". ` +
        `The agent cannot prescribe, diagnose or set treatment plans, and that ` +
        `is enforced in code paths that write a calendar event or booking ` +
        `note, not only in the system prompt. See docs/hipaa-compliance.md.`,
    );
    this.name = "ClinicalContentError";
  }
}

/**
 * Refuse anything that reads as clinical.
 *
 * Applied to write-back payloads. The system prompt tells the model not to give
 * medical advice; this makes it impossible for the result to reach a patient
 * record even if the model ignores it.
 */
export function assertNonClinical(text: string): void {
  const normalized = text.toLowerCase();
  for (const term of CLINICAL_TERMS) {
    if (normalized.includes(term)) throw new ClinicalContentError(term);
  }
}

export class TreatmentNameError extends Error {
  /** The clinic's service name that matched, as the clinic configured it. */
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(
      `Refusing to send a treatment name: the text names the service ` +
        `"${serviceName}". Payment descriptions, statement descriptors, ` +
        `payment metadata and Meta messages carry an amount, a generic ` +
        `descriptor and an opaque reference, never the treatment. See ` +
        `docs/v1-product-spec.md, "Vendor position, vendor by vendor".`,
    );
    this.name = "TreatmentNameError";
    this.serviceName = serviceName;
  }
}

/** Lowercase, and every run of anything but letters and digits to one space. */
function wordsOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Refuse text that names one of the clinic's own treatments.
 *
 * Stripe and Meta sign no business associate agreement, so the spec keeps
 * treatment names out of everything they carry: a payment description, a
 * statement descriptor, payment metadata, a Meta message. "Botox, 3 areas" on
 * a Stripe charge is a named patient's treatment sitting with a vendor that
 * holds no agreement. `assertNonClinical` cannot catch that, because a
 * treatment name is not clinical vocabulary, so this checks against the
 * clinic's configured service names instead.
 *
 * Matching ignores case and punctuation and works on whole words, so "lip
 * filler" is caught in "Lip-filler deposit" but "Lip" alone does not match
 * "lipstick". Blank service names are ignored. Call it on every string that
 * leaves for Stripe, the clinic's gateway or Meta, and fail the send rather
 * than strip the name and carry on.
 */
export function assertNoTreatmentName(text: string, serviceNames: readonly string[]): void {
  const haystack = ` ${wordsOf(text)} `;
  for (const name of serviceNames) {
    const needle = wordsOf(name);
    if (!needle) continue;
    if (haystack.includes(` ${needle} `)) throw new TreatmentNameError(name);
  }
}

/**
 * Best-effort E.164.
 *
 * Returns undefined rather than guessing when the input isn't recognisably a US
 * number. In v1 it normalises the callback number the agent reads back to the
 * caller and stores on the booking, and a WhatsApp sender's number. A wrong
 * callback number is worse than a missing one: the booking points staff at a
 * stranger, and nobody notices until the slot is missed. It is not a record of
 * permission to contact anyone later; v1 contacts no patient first.
 */
export function toE164(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Already international and plausible.
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  return undefined;
}

/**
 * Parse a platform's money value into a decimal string.
 *
 * Phase two: POS read-back. It exists for money values read back from a
 * clinic's POS or transaction system, which v1 does not do; keep it out of
 * every v1 import path. Its only caller today is tests/contract.test.ts.
 *
 * Never returns a float. Accepts numbers, strings with symbols, and integer
 * cents. Platforms disagree, and a silent 100× error in either direction is
 * the kind of bug that reaches a clinic as a wrong figure.
 */
export function toMoney(
  raw: unknown,
  options: { isCents?: boolean } = {},
): string | undefined {
  if (raw === null || raw === undefined) return undefined;

  let value: number;

  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9.-]/g, "");
    if (!cleaned || Number.isNaN(Number(cleaned))) return undefined;
    value = Number(cleaned);
  } else {
    return undefined;
  }

  if (!Number.isFinite(value)) return undefined;
  if (options.isCents) value = value / 100;

  return value.toFixed(2);
}

export function toDate(raw: unknown): Date | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw === "string" || typeof raw === "number") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/**
 * Redact anything log-shaped before it reaches stdout.
 *
 * Adapters log request failures, and a failed request carries the thing that
 * failed. Never log PHI — not to stdout, not to an error tracker.
 */
export function safeLog(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");

  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, "[date]")
    // Bearer tokens and api keys in error bodies.
    .replace(/\b(bearer|api[_-]?key|token)\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .slice(0, 500);
}
