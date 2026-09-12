/**
 * The agreement download cookie: proof that this browser is the one that signed.
 *
 * ## Unlike `lib/gate.ts`, this IS a security boundary
 *
 * That file says of itself, correctly, that it is "lead capture and abuse
 * control, not authentication" and that "nothing behind it is sensitive". Both
 * halves of that sentence are false here, so nothing in this module may be
 * relaxed on the strength of the demo gate having relaxed it first.
 *
 * What sits behind this cookie is the clinic's countersigned HIPAA business
 * associate agreement: the practice's legal name, the name and work email of
 * the person who signed, the record of assent captured at signature time, and
 * the full agreement text. None of it is patient data. All of it is a contract
 * and the identity of the human who agreed to it, and it belongs to exactly one
 * party: the buyer sitting in front of the checkout flow right now.
 *
 * ## The attack this exists to prevent
 *
 * The obvious design is `/agreement/<uuid>.pdf`. An earlier review of this
 * codebase rejected it in one sentence, and that sentence is the reason this
 * file exists:
 *
 *   > The acceptance id is deliberately NOT in the email. A future "download
 *   > what I signed" endpoint keyed on it would turn a UUID mailed to an
 *   > unverified address into a bearer credential.
 *
 * Nobody proves ownership of the address a clinic types into a checkout form.
 * A shared front-desk mailbox, a forwarded receipt, a billing inbox a vendor
 * can read, a mail relay's logs: any of those hands the uuid to someone who is
 * not the signer. If the uuid alone opened the document, all of them would be a
 * disclosure. So the uuid is deliberately not a credential. This is:
 *
 *   - a short-lived HMAC that only the browser which completed the signature
 *     step is ever given, and
 *   - which is arithmetically useless for any agreement other than the single
 *     one it was minted for.
 *
 * Possession of the id gets you nothing. You need the session that signed.
 *
 * ## Why the agreement id is not stored in the token
 *
 * The cookie is `<expiry>.<hmac>` and nothing else. The id is an *input* to the
 * MAC, never a field the verifier reads back out. That inverts the usual failure
 * mode: there is no id to parse, no id to trust, and no path on which a token
 * that is merely well-formed can be presented against a different agreement.
 * `verifyDownloadToken` cannot even be called without the id the caller is about
 * to serve, and if that id is not the one the token was minted for the MAC
 * simply does not reproduce. The binding is structural rather than a check that
 * a later edit could drop.
 *
 * The MAC input is `base64url(agreementId).expiry` rather than the two values
 * concatenated. Raw concatenation is ambiguous, id `"ab"` with expiry `"1234"`
 * and id `"ab1"` with expiry `"234"` are the same bytes, and an ambiguous MAC
 * input is how a token for one record becomes a token for another. base64url
 * emits no `.`, so the encoding is injective and the dot is an unambiguous
 * separator. The expiry is signed as the exact digits that appear in the cookie,
 * not as a re-stringified number, so the bytes verified are the bytes stored.
 *
 * ## Why the key is derived rather than used directly
 *
 * `HEALDESK_GATE_SECRET` is reused on purpose: it is already required in
 * production, and a new secret is a new thing to rotate, a new thing to forget
 * in an environment, and a new way for a deploy to be half-configured. What
 * reuse costs is cross-protocol safety, because `gate.ts` signs a payload of
 * exactly this shape, `base64url(value).timestamp`, with the very same key.
 * Today an email must contain an `@` and an agreement id is a uuid, so no gate
 * cookie is a valid download token by accident; that is a coincidence of two
 * validators in two files, not a guarantee, and it is not something a future
 * edit to either file would be expected to preserve.
 *
 * So the signing key here is `HMAC(HEALDESK_GATE_SECRET, "<purpose>")` and not
 * the secret itself. One environment variable, one key per use, and a token
 * minted anywhere else in this app cannot be replayed here however its payload
 * is shaped.
 *
 * ## The expiry is inside the signature, and it is thirty minutes
 *
 * A cookie's `Max-Age` is the browser's promise about when to stop sending the
 * cookie, not ours about when to stop honouring it. So the expiry is signed and
 * checked here, server-side, and a browser that keeps sending a stale cookie
 * gets a refusal rather than a document.
 *
 * Thirty minutes because this is the signing session's artefact, not a document
 * store. The buyer is on the last screen before payment and wants their copy
 * now. The durable record is the copy that goes out by email, and ops can
 * already resend it. A longer window would not serve the buyer any better and
 * would leave a working credential sitting in a browser on a shared front-desk
 * machine for the rest of the day.
 *
 * ## What this deliberately is not
 *
 *   - It is not bound to a device, IP or user agent. A cookie exfiltrated
 *     within the window is a valid download until it expires. `httpOnly`
 *     (script cannot read it), `sameSite: "strict"` (no other origin can cause
 *     it to be sent), `secure` in production (not readable on the wire) and the
 *     thirty-minute lifetime are the whole mitigation, and they are proportional
 *     to one contract belonging to the person holding the browser.
 *   - It is not revocable. Rotating `HEALDESK_GATE_SECRET` invalidates every
 *     outstanding token at once and is the only revocation that exists. At a
 *     thirty-minute TTL that is an acceptable substitute.
 *   - It carries no authorisation beyond the one id. It is not a session, it
 *     does not identify the clinic to any other route, and it must never be
 *     read as "this browser is logged in".
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Distinct from `GATE_COOKIE` ("hd_demo") and `ADMIN_COOKIE` ("hd_admin") on
 * purpose. All three are HMACs over a payload on the same domain; sharing a
 * name would let one be presented where another is expected.
 */
export const DOWNLOAD_COOKIE = "hd_agreement";

/** Thirty minutes. See the header: this is a signing-session artefact. */
export const DOWNLOAD_TTL_SECONDS = 60 * 30;

/**
 * The `Path` the cookie is scoped to, so it is not attached to every request
 * the browser makes to this site.
 *
 * This is the narrowest prefix that still covers the download route in either
 * shape it might take (`/api/agreement/download` or an id in the path), and it
 * keeps the cookie off `/api/chat`, `/admin` and every page. It costs the
 * cookie riding along on `POST /api/agreement` itself, which ignores it.
 *
 * If the download route ever moves, this constant is the single thing to
 * change: a path that no longer matches means the browser silently stops
 * sending the cookie and every download 401s.
 */
export const DOWNLOAD_COOKIE_PATH = "/api/agreement";

/**
 * Domain separation for the derived key. Changing this string invalidates every
 * outstanding token, which is the intended way to break compatibility if the
 * token format ever changes.
 */
const KEY_PURPOSE = "healdesk.agreement-download.v1";

/**
 * Matches `gate.ts`, which falls back to a known string outside production so
 * that a developer without a `.env.local` still exercises the real code path.
 * In production there is no fallback: see `signingKey()`.
 */
const DEV_ONLY_SECRET = "dev-only-insecure-secret";

/**
 * The purpose-bound signing key, or null when there is nothing safe to sign
 * with. A blank env var counts as unset, because an env var that exists and is
 * empty is the shape a half-finished deploy actually takes.
 *
 * Returning null rather than throwing lets each caller fail in the way its own
 * position demands: minting refuses loudly, verifying refuses quietly.
 */
function signingKey(): Buffer | null {
  const configured = process.env.HEALDESK_GATE_SECRET;
  if (configured !== undefined && configured.length > 0) {
    return createHmac("sha256", configured).update(KEY_PURPOSE).digest();
  }

  // Never sign a real boundary with a string that is published in this file.
  if (process.env.NODE_ENV === "production") return null;

  return createHmac("sha256", DEV_ONLY_SECRET).update(KEY_PURPOSE).digest();
}

/**
 * `base64url(agreementId).expiry`, injective, so no pair of (id, expiry) can
 * produce another pair's bytes. `expiresAt` is the raw digit string from the
 * cookie, never a re-stringified number, so what is verified is what is stored.
 */
function macInput(agreementId: string, expiresAt: string): string {
  const encodedId = Buffer.from(agreementId, "utf8").toString("base64url");
  return `${encodedId}.${expiresAt}`;
}

function sign(agreementId: string, expiresAt: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update(macInput(agreementId, expiresAt))
    .digest("base64url");
}

/**
 * Constant-time, and length-independent because both sides collapse to a
 * 32-byte digest first.
 *
 * `timingSafeEqual` throws outright when the buffers differ in size, and the
 * received signature is attacker-controlled and can be any length at all, so a
 * naive call is both a crash and, if guarded by an `a.length !== b.length`
 * early return, a leak of the expected length. Hashing first removes both.
 * Never replace this with `===`.
 */
function equals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

/**
 * Mint the cookie value that lets this browser download this one agreement.
 *
 * Throws when there is no key to sign with (production, secret missing) or when
 * handed a blank id, rather than returning a token nobody can rely on.
 *
 * CALLERS MUST CATCH. This is minted on the last screen before payment, and the
 * buyer must never be shown an error there, the plain-text copy of the
 * agreement is the fallback, and it is the stored text, which is the authority.
 * A missing PDF link is a smaller failure than a broken checkout.
 */
export function issueDownloadToken(agreementId: string): string {
  if (typeof agreementId !== "string" || agreementId.length === 0) {
    throw new Error(
      "issueDownloadToken requires a non-empty agreement id, a token bound to nothing would unlock nothing.",
    );
  }

  const key = signingKey();
  if (key === null) {
    throw new Error(
      "HEALDESK_GATE_SECRET is required in production, the agreement download cookie cannot be signed without it.",
    );
  }

  const expiresAt = String(Date.now() + DOWNLOAD_TTL_SECONDS * 1000);
  return `${expiresAt}.${sign(agreementId, expiresAt, key)}`;
}

/**
 * Does this cookie authorise a download of THIS agreement?
 *
 * Both arguments matter. A token that is perfectly well-formed, unexpired and
 * signed by us is still refused unless it was minted for `agreementId`, because
 * the id is an input to the MAC. That is the property the whole design rests
 * on, and it is the one the test suite spends the most words on.
 *
 * Never throws. It runs on an incoming request whose cookie is attacker-chosen
 * and whose id came off a URL, so every malformed shape is a `false` and never
 * a 500. Unconfigured is `false` too, in every environment: a boundary with no
 * key fails closed.
 */
export function verifyDownloadToken(
  value: string | undefined,
  agreementId: string,
): boolean {
  // Defensive `typeof`: both of these come off the wire, and a caller reading a
  // dynamic route segment can hand us `undefined` whatever the signature says.
  if (typeof value !== "string" || value.length === 0) return false;
  if (typeof agreementId !== "string" || agreementId.length === 0) return false;

  const key = signingKey();
  if (key === null) return false;

  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [expiresAtRaw, signature] = parts as [string, string];

  // Plain digits only, bounded. A signature over `"1e30"` or `" 12"` would
  // still be rejected below, but refusing the shape up front keeps the expiry
  // comparison a comparison of two numbers rather than of whatever `Number()`
  // made of an arbitrary string.
  if (!/^[0-9]{1,15}$/.test(expiresAtRaw)) return false;

  // Signature first: the expiry is only worth reading once we know we wrote it.
  if (!equals(sign(agreementId, expiresAtRaw, key), signature)) return false;

  return Date.now() < Number(expiresAtRaw);
}

export type DownloadCookieOptions = {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: string;
  maxAge: number;
};

/**
 * The flags, in one place so the route that sets the cookie and anything that
 * later clears it cannot drift apart.
 *
 * `sameSite: "strict"` rather than the demo gate's `"lax"`: this cookie has no
 * legitimate reason to ride along on a navigation from another site, and
 * refusing to send it there removes cross-site request forgery and cross-site
 * download-triggering as a category rather than mitigating them. The buyer
 * reaches the download from the page they are already on, so nothing is lost.
 *
 * `secure` is off outside production only because localhost is not HTTPS. In
 * production it is on, and without it this is a plaintext bearer token on the
 * wire.
 *
 * `maxAge` matches the signed TTL so the browser stops sending a cookie at
 * about the moment we stop honouring it. The signed expiry is what actually
 * enforces the window; this is only politeness toward the browser.
 */
export function downloadCookieOptions(): DownloadCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: DOWNLOAD_COOKIE_PATH,
    maxAge: DOWNLOAD_TTL_SECONDS,
  };
}
