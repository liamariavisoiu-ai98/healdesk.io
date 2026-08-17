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
        `is enforced in code paths that could write into an EMR, not only in ` +
        `the system prompt. See docs/hipaa-compliance.md.`,
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

/**
 * Best-effort E.164.
 *
 * Returns undefined rather than guessing when the input isn't recognisably a US
 * number. A wrong number in the consent ledger is worse than a missing one:
 * it makes us confident about permission we don't have.
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
 * Never returns a float. Accepts numbers, strings with symbols, and integer
 * cents — platforms disagree, and a silent 100× error in either direction is
 * the kind of bug that reaches a customer's monthly report.
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
