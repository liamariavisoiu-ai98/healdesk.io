/**
 * Phone-number handling for the "call me" request on the voice demo.
 *
 * Deliberately dependency-free rather than pulling in libphonenumber-js. The
 * only thing this has to do is refuse a number we should not dial and hand the
 * rest to the telephony provider in E.164, which is the one format every
 * provider accepts. The provider does the authoritative validation, and it
 * charges us for a failed call either way, so a cheap pre-filter here is about
 * abuse and typos, not about being a phone-number library.
 *
 * The North American rules below are the load-bearing part. An endpoint that
 * dials whatever it is given is a harassment tool with our name on the caller
 * ID, so the shape check runs before any of it reaches a carrier.
 */

/** E.164: a leading +, a non-zero country code, and 7–14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Area codes we refuse outright.
 *
 * N11 codes are service codes (411 directory, 611 carrier, 911 emergency), and
 * 555 is the fiction range. Dialing an emergency service because someone typed
 * a joke into a marketing site is the failure mode this exists to prevent.
 */
const BLOCKED_NANP_AREA = new Set([
  "211", "311", "411", "511", "611", "711", "811", "911", "555",
]);

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: string };

/**
 * Normalize visitor input to E.164.
 *
 * Bare 10-digit input is treated as North American, because the site sells to
 * US clinics and that is how a US visitor types their own number. Anything
 * international has to carry its own `+`, guessing a country code for a
 * 9-digit string would dial a stranger.
 */
export function normalizePhone(input: unknown): PhoneResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "Enter a phone number." };
  }

  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Enter a phone number." };

  // Keep a leading + and the digits; drop the spaces, dashes, dots and
  // parentheses people actually type. A "+" anywhere but the front is junk.
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return { ok: false, reason: "Enter a phone number." };
  if (digits.length > 15) return { ok: false, reason: "That number is too long." };

  let e164: string;
  if (plus) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = `+${digits}`;
  } else {
    return {
      ok: false,
      reason: "Add your country code, like +44 or +1.",
    };
  }

  if (!E164.test(e164)) {
    return { ok: false, reason: "That doesn't look like a phone number." };
  }

  if (e164.startsWith("+1")) {
    const national = e164.slice(2);
    if (national.length !== 10) {
      return { ok: false, reason: "A US or Canadian number needs 10 digits." };
    }
    const area = national.slice(0, 3);
    const exchange = national.slice(3, 6);
    // NANP: neither the area code nor the exchange may start with 0 or 1.
    if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) {
      return { ok: false, reason: "That doesn't look like a phone number." };
    }
    if (BLOCKED_NANP_AREA.has(area) || exchange === "555") {
      return { ok: false, reason: "We can't call that number." };
    }
  }

  return { ok: true, e164 };
}

/**
 * Last four digits only, for reading a number back to the visitor.
 *
 * The confirmation says "ending 4821" rather than echoing the whole number:
 * it proves we captured the right one without printing a stranger's phone
 * number onto a screen someone else might be looking at.
 */
export function maskPhone(e164: string): string {
  return e164.slice(-4);
}
