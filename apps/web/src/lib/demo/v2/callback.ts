/**
 * The owner's demo page's team call-back (app/api/demo/[slug]/callback): the
 * words it asks people to agree to, kept as their consent, and the one
 * number shape it takes.
 */

/** The words beside the form, exactly as the page shows them (lib/demo/v2/template.ts). */
export const DEMO_PAGE_CALLBACK_CONSENT = {
  version: "demo-page-callback-2026-10-30.1",
  text: "By submitting, you agree to one call from the Healdesk team about this demo. No marketing calls or texts.",
} as const;

/** A US number as the page takes it, ten digits, to E.164; null for anything else. */
export function usMobileE164(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+1${digits}` : null;
}
