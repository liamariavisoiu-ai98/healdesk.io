import { domainToASCII } from "node:url";

/**
 * Whether healdesk can send to an address, asked in one place by both apps.
 *
 * apps/app's mail layer (reporting/deliver.ts, `normaliseRecipient`) refuses
 * any address it cannot write into a US-ASCII header, and the agreement's
 * signature (agreement-signing.ts) asks the same question before the address
 * goes onto the record of who signed. Since 14 October 2026 the signature is
 * taken on apps/web (docs/design/checkout-records-on-vercel-2026-10-14.md), so
 * the predicate lives here: a second spelling of "is this an address" drifts
 * from the first, and the way anyone finds out is a signer who cannot be
 * mailed their copy.
 *
 * Server-side only (it reads `node:url`), so it is a subpath export,
 * `@healdesk/catalog/mail-address`, and not part of the index the browser
 * imports.
 *
 * ## The two halves are different problems
 *
 *   - the DOMAIN already has a standard ASCII form. IDNA/punycode exists so
 *     that `münchen-klinik.test` can travel as `xn--mnchen-klinik-wob.test`
 *     and reach the same host, so it is CONVERTED rather than refused.
 *   - the LOCAL part has no such form. A non-ASCII mailbox name needs
 *     SMTPUTF8, which is negotiated per hop and which healdesk does not speak,
 *     and transliterating one would deliver a signed contract to whatever
 *     different mailbox the stripped accents happened to name. So it is
 *     REFUSED.
 *
 * Both patterns are positive classes, deliberately: a negated class is a list
 * of what we thought of, and the code point that matters is always the one
 * nobody thought of.
 */

/**
 * RFC 5322 dot-atom: the atext characters, in dot-separated runs. ASCII by
 * construction, and it rejects the leading, trailing and doubled dots that are
 * not a legal mailbox anywhere.
 */
const LOCAL_PART =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/**
 * An LDH domain of at least two labels, checked AFTER punycode conversion:
 * `domainToASCII` is a converter, not a validator, and hands back `a..b.com`
 * and `-bad.com` unchanged rather than rejecting them.
 */
const DOMAIN_ASCII =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/;

/**
 * 64 for the local part is RFC 5321 §4.5.3.1; 253 for the domain is the DNS
 * presentation-format limit, measured after punycode conversion.
 */
const MAX_LOCAL_PART_CHARS = 64;
const MAX_DOMAIN_CHARS = 253;

/** Why an address cannot be sent to, in the vocabulary deliver.ts words its refusals in. */
export type RecipientProblem =
  /** A line break or null byte: in a header that is an injected header, not a value. */
  | "header_break"
  /** Not one bare `local@domain`. */
  | "not_single_address"
  /** The mailbox name is not ASCII dot-atom, or is too long. */
  | "local_part"
  /** The domain has no ASCII form a header can carry. */
  | "domain";

type Checked = { ok: true; address: string } | { ok: false; problem: RecipientProblem };

function check(value: string): Checked {
  if (typeof value !== "string") return { ok: false, problem: "not_single_address" };
  if (/[\r\n\0]/.test(value)) return { ok: false, problem: "header_break" };
  const trimmed = value.trim();

  // The last "@", not the first: the local part cannot contain one, so the two
  // agree for any address that will be accepted, and a rejected address is
  // rejected for its local part rather than for a domain that was never the
  // domain.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return { ok: false, problem: "not_single_address" };

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length > MAX_LOCAL_PART_CHARS || !LOCAL_PART.test(local)) {
    return { ok: false, problem: "local_part" };
  }

  // domainToASCII returns "" when it cannot convert, and returns some invalid
  // inputs unchanged, so the result is validated either way.
  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > MAX_DOMAIN_CHARS || !DOMAIN_ASCII.test(ascii)) {
    return { ok: false, problem: "domain" };
  }
  return { ok: true, address: `${local}@${ascii}` };
}

/** Why this address cannot be sent to, or null when it can. */
export function recipientProblem(value: string): RecipientProblem | null {
  const checked = check(value);
  return checked.ok ? null : checked.problem;
}

/**
 * The address in the form it will be transmitted (the domain as its A-label),
 * or null when it cannot be sent to. Returned rather than merely approved,
 * because the conversion is a change to the value.
 */
export function asciiRecipient(value: string): string | null {
  const checked = check(value);
  return checked.ok ? checked.address : null;
}

/** True when healdesk can send to this address. */
export function isSendableAddress(value: string): boolean {
  return check(value).ok;
}
