/**
 * Whether text a stranger typed into a form may be put into an email we send
 * to an address nobody has confirmed (Annex X5, P6: "in public mode it goes
 * once per address per day, with the typed variables restricted to safe
 * characters").
 *
 * The signer's copy of the agreement names the practice and the signer, as
 * they were typed, and goes to the address typed beside them. Without a rule,
 * the signing form is a way to have healdesk's sender deliver a chosen
 * sentence, a link or a phone number to anyone. So the names may hold letters
 * (any script, with their accents), digits, spaces and the punctuation a
 * business or a person is named with, and nothing a mail client would turn
 * into a link: no "@", no "/" or ":", no "www.", and no full stop between a
 * letter or digit and two or more letters, the way a domain is written
 * ("radiance.com", "x.com"), which is what a reader's mail client would offer
 * to open. Seven digits read as a phone number however they are punctuated
 * ("512-555-0100", "+1 (512) 555 0100"), since the separators the rule allows
 * would otherwise break the run, and are refused for the same reason.
 *
 * It is a rule about mail, not about the agreement: a name it refuses is still
 * signed and recorded as typed, and the copy waits for a person
 * (apps/web/src/lib/email/agreement-copy.ts). apps/app holds the signatory's
 * name in an email's payload to the same rule (lib/email/lint.ts).
 */

/** Letters and their marks, digits, spaces, and . , ' ’ & ( ) + - – # only. */
const SAFE_CHARACTERS = /^[\p{L}\p{M}\p{N} .,'’&()+\-–#]+$/u;

/** A full stop between a letter or digit and two or more letters, as in a domain, or "www." anywhere. */
const LINK_SHAPED = /(?:^|[^\p{L}\p{N}])www\.|[\p{L}\p{N}]\.[\p{L}]{2,}/iu;

/** A phone number's worth of digits, once the separators a number is written with are taken out. */
const PHONE_SHAPED = /\d{7,}/;
const NUMBER_SEPARATORS = /[\s().+\-\u2013]/g;

export function isSafeTypedText(value: unknown, maxChars = 200): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].length > maxChars) return false;
  return (
    SAFE_CHARACTERS.test(trimmed) &&
    !LINK_SHAPED.test(trimmed) &&
    !PHONE_SHAPED.test(trimmed.replace(NUMBER_SEPARATORS, ""))
  );
}
