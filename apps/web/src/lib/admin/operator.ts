/**
 * The operator session: one administrator, one password, one second factor.
 *
 * ## What this replaces, and why the replacement is smaller
 *
 * The `lib/admin/auth.ts` this replaces (deleted 9 September) authenticated
 * with a shared password held in `HEALDESK_ADMIN_PASSWORD` and issued a session
 * that said nothing but "someone knew the password". An earlier draft of this
 * module went the other way and carried a Better Auth identity, user id,
 * email, display name, because the console was going to sit behind the staff
 * user store in apps/app.
 *
 * Neither is what got built. The clinic console was deleted, staff invitations
 * went with it, and what is left is one surface with exactly one human behind
 * it. So the account model is: `HEALDESK_ADMIN_EMAIL` is the username,
 * `HEALDESK_ADMIN_PASSWORD_HASH` is a scrypt hash of the password, and a TOTP
 * app holding `HEALDESK_ADMIN_TOTP_SECRET` is the second factor. There is no
 * user table on this side, no roles, no invitations, and nothing in the token
 * but the address of the one account.
 *
 * The plaintext password exists in a password manager and nowhere else. It is
 * not in this repository, not in `.env.example`, and must never be written into
 * either. `HEALDESK_ADMIN_PASSWORD` is gone; if you find a code path still
 * reading it, that path is the bug.
 *
 * ## One first factor and one second factor in this directory
 *
 * An earlier draft split the same job across `credential.ts` (a second
 * `verifyAdminPassword` and `adminEmail`) and `totp.ts` (a second TOTP
 * verifier, base32 codec and recovery-code hash). Both were deleted on
 * 9 September, unreferenced by anything but their own tests, and the reason is
 * worth keeping: two implementations of one credential check in one directory
 * is a trap for whoever hardens one of them. Their tests passed, which made
 * them look live. That draft's verifier had no replay guard at all.
 *
 * Today the first factor is `verifyAdminPassword` below and the second is
 * `lib/admin/totp.ts`, which checks the code against
 * `HEALDESK_ADMIN_TOTP_SECRET` and refuses a replay as far as an app with no
 * shared store can (that file says exactly how far). Until 14 October 2026 the
 * second factor lived in apps/app's database and was asked for over the signed
 * ops API, which made the console impossible to sign into while the AWS host
 * was off; the owner moved it here, and apps/app's copy and its table are
 * gone. One of each, and if a second copy of either ever appears beside these
 * files, delete it rather than keeping it in step.
 *
 * ## Why the token carries the email at all, when there is only one account
 *
 * It could carry nothing: a bare expiry plus a MAC would be a perfectly good
 * "yes, signed in" for a single-account system, which is what the old `auth.ts`
 * did.
 * The email is in there because every action this session performs crosses to
 * apps/app and lands in `audit_log.actorLabel`, and a label read out of a token
 * that was signed at sign-in time is a fact about who authenticated. A label
 * read out of `process.env` at action time is a fact about how the server is
 * configured right now, which is a different and weaker claim.
 *
 * Then, because the account is singular, verification ALSO requires the address
 * in the token to be the address the server is configured with today. Change
 * `HEALDESK_ADMIN_EMAIL` and every outstanding session dies, which is the right
 * behaviour: the person who was signed in is no longer the account. The two
 * checks together mean the token cannot name anybody but the one admin, however
 * it was minted.
 *
 * ## The token
 *
 * `b64url(email).<expiry>.<hmac>`, the shape of `lib/agreement-download.ts`,
 * down to the derived key, the constant-time compare and the fail-closed
 * behaviour when the secret is missing. Read that file first; only the
 * differences are restated here.
 *
 *   - base64url emits no `.`, so `b64url(email).expiry` is injective. Raw
 *     concatenation is not: `("ab", "1234")` and `("ab1", "234")` would be the
 *     same bytes, and an ambiguous MAC input is how one token becomes another.
 *   - The expiry is signed as the exact digits stored in the cookie, never as a
 *     re-stringified number, so the bytes verified are the bytes read.
 *   - The signature is checked before the expiry is read and before the email is
 *     decoded. Nothing in the payload is worth looking at until we know we wrote
 *     it.
 *
 * ## The session cookie, and the one other cookie this file signs
 *
 * There used to be a ten-minute enrolment token for the gap between "the
 * password was right" and "an authenticator exists". That gap is gone: the
 * authenticator exists before the deployment does, because enrolment is now a
 * script run on the owner's own machine (`scripts/set-admin-totp.ts`), so
 * every sign-in proves both factors in one request and nothing half-signed-in
 * is ever issued.
 *
 * The other cookie is `hd_operator_step`, which names the last TOTP step this
 * browser signed in with so the same browser cannot use that code again on
 * another serverless instance. It is not a credential and grants nothing: the
 * only thing it can ever do is make a sign-in fail. It is still signed, under
 * its own derived key, because a cookie that can only refuse is a cookie
 * worth forging if you want to lock somebody out: a sibling subdomain tossing
 * an `hd_operator_step` with a huge step would otherwise shut the owner's
 * browser out of the console until it expired.
 *
 * ## Why the key is derived rather than used directly
 *
 * `HEALDESK_ADMIN_SECRET` signs two different things in this file, the
 * session and the step cookie, and signed a third before the old admin gate
 * went. Deriving `HMAC(secret, "<purpose>")` per use means a
 * token minted for one purpose cannot be replayed at another however its payload
 * is shaped, which is a property of the arithmetic rather than a coincidence of
 * two validators disagreeing about field counts.
 *
 * ## Unconfigured is closed, in every environment
 *
 * `gate.ts` and `agreement-download.ts` fall back to a published development
 * string when their secret is missing, so that a developer without a
 * `.env.local` still exercises the real code path. This module does not, and the
 * reason is that here the fallback would buy nothing: signing in also needs
 * `HEALDESK_ADMIN_EMAIL` and `HEALDESK_ADMIN_PASSWORD_HASH`, so a developer with
 * no admin environment cannot sign in whatever this function returns. What the
 * fallback WOULD do is make the console cookie forgeable by anyone in every
 * deployment where `NODE_ENV` is not exactly "production", a preview build, a
 * staging box, a CI environment with a real database behind it. That is a large
 * hole in exchange for nothing, so this fails closed everywhere. `auth.ts`
 * reached the same conclusion for the weaker gate and was right to.
 *
 * ## What this deliberately is not
 *
 *   - It is not bound to a device, IP or user agent. A cookie exfiltrated inside
 *     the window is a valid session until it expires. `httpOnly`, `sameSite:
 *     "strict"`, `secure` in production and the eight-hour lifetime are the whole
 *     mitigation.
 *   - It is not individually revocable. Rotating `HEALDESK_ADMIN_SECRET`
 *     invalidates every outstanding token at once, and changing
 *     `HEALDESK_ADMIN_EMAIL` does the same. There is no session table to delete a
 *     row from, and with one account there is nothing a session table would buy.
 *   - It is not an authority claim. It says "the administrator authenticated on
 *     this browser". Everything the console then does still crosses to apps/app
 *     over the signed API, and that side is the one that decides what an
 *     administrator may do.
 */

import { createHash, createHmac, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

import { cookies } from "next/headers";

import { TOTP_SECRET_VARIABLE, adminTotpSecret } from "@/lib/admin/totp";

/**
 * `promisify(scrypt)` picks the first of node's two overloads, which has no
 * options argument, so the work factors would silently fall back to defaults
 * that do not match the stored hash. Wrapping by hand keeps them.
 *
 * Async rather than `scryptSync`: this runs inside a request handler, and
 * sixteen mebibytes of sequential memory-hard work on the event loop would stall
 * every other request on the instance for the duration. `scrypt` does the work
 * on the thread pool.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Distinct from `ADMIN_COOKIE` ("hd_admin"), `GATE_COOKIE` ("hd_demo") and
 * `DOWNLOAD_COOKIE` ("hd_agreement") on purpose. They are all HMACs over a
 * payload on the same domain; sharing a name would let one be presented where
 * another is expected.
 */
export const OPERATOR_COOKIE = "hd_operator";

/**
 * Eight hours. Long enough for a working day without re-running the second
 * factor, short enough that a laptop left open overnight is signed out by
 * morning.
 */
export const OPERATOR_TTL_SECONDS = 60 * 60 * 8;

/**
 * The browser's record of the last TOTP step it signed in with. See "The
 * session cookie, and the one other cookie this file signs" above, and the
 * replay notes in `lib/admin/totp.ts`.
 */
export const STEP_COOKIE = "hd_operator_step";

/**
 * Ten minutes. A code is acceptable for at most ninety seconds after it is
 * first used (three thirty-second steps), so this outlives every code it could
 * refuse, with room for an instance whose clock is a minute out. Longer would
 * buy nothing: once a code's window has passed it is refused by the clock.
 */
export const STEP_COOKIE_TTL_SECONDS = 60 * 10;

/**
 * Domain separation for the derived keys. Changing either string invalidates
 * every outstanding token of that kind, which is the intended way to break
 * compatibility if a format ever changes.
 *
 * The operator purpose is `.v2` because `.v1` signed a three-field Better Auth
 * identity. Any cookie still holding one of those must not verify here.
 */
const OPERATOR_PURPOSE = "healdesk.admin-operator.v2";
const STEP_PURPOSE = "healdesk.admin-totp-step.v1";

/** The longest legal email address is 320 bytes. */
const MAX_EMAIL_BYTES = 320;

/**
 * A password longer than this is not a password. scrypt's cost is set by N and
 * r rather than by input length, so this is not a work bound; it is a bound on
 * what gets copied, hashed and held in memory on an unauthenticated path.
 */
const MAX_PASSWORD_BYTES = 1024;

/**
 * A cookie longer than any token we mint is refused before anything is hashed.
 * A 320-byte address base64s to 428 characters; the expiry and signature add
 * under 60. The value arrives off a request and the bound is free.
 */
const MAX_TOKEN_LENGTH = 640;

/** base64url, unpadded. The alphabet contains no `.`, which is what makes the
 * three-field split unambiguous. */
const B64URL = /^[A-Za-z0-9_-]{1,512}$/;

/** Plain digits, bounded. The shape is checked before the value is treated as a
 * number, so the comparison below is a comparison of two numbers rather than of
 * whatever `Number()` made of an arbitrary string. */
const EXPIRY = /^[0-9]{1,15}$/;

type TokenPurpose = typeof OPERATOR_PURPOSE | typeof STEP_PURPOSE;

/**
 * The purpose-bound signing key, or null when there is nothing safe to sign
 * with. A blank env var counts as unset, because an env var that is present and
 * empty is the shape a half-finished deploy actually takes.
 *
 * Returning null rather than throwing lets each caller fail in the way its own
 * position demands: minting refuses loudly, verifying refuses quietly.
 */
function signingKey(purpose: TokenPurpose): Buffer | null {
  const configured = process.env.HEALDESK_ADMIN_SECRET;
  if (configured === undefined || configured.length === 0) return null;
  return createHmac("sha256", configured).update(purpose).digest();
}

/**
 * The one account's address, normalised, or null when it is not configured.
 *
 * Lower-cased and trimmed because the address is typed into a form by a human
 * on a phone keyboard that likes to capitalise. The local part of an email
 * address is case-sensitive in the RFC and case-insensitive at every mail
 * provider that exists; with exactly one account and that account at Gmail,
 * matching what people actually type is the correct trade.
 */
export function adminEmail(): string | null {
  const configured = process.env.HEALDESK_ADMIN_EMAIL;
  if (configured === undefined) return null;
  const normalised = normaliseEmail(configured);
  return normalised.length > 0 ? normalised : null;
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Everything sign-in needs, present and non-empty.
 *
 * The sign-in page reads this so a misconfigured deployment says plainly that
 * there is no account here, rather than rendering a form that cannot succeed
 * and answering every attempt with "incorrect".
 */
export function isAdminAccountConfigured(): boolean {
  return (
    adminEmail() !== null &&
    parseScryptHash(process.env.HEALDESK_ADMIN_PASSWORD_HASH) !== null &&
    signingKey(OPERATOR_PURPOSE) !== null
  );
}

/**
 * Which pieces are missing, for the development-only setup panel. Never shown
 * in production: the names of the variables a deployment lacks are operator
 * detail, and the operator has a terminal.
 *
 * `HEALDESK_ADMIN_TOTP_SECRET` is listed here but is not part of
 * `isAdminAccountConfigured()`. Without it the form still renders, and the
 * session route answers a correct password with a 503 naming the variable:
 * that sentence reaches only somebody who has just proved the password, which
 * a page anyone can load is not.
 */
export function missingAdminConfig(): string[] {
  const missing: string[] = [];
  if (adminEmail() === null) missing.push("HEALDESK_ADMIN_EMAIL");
  if (parseScryptHash(process.env.HEALDESK_ADMIN_PASSWORD_HASH) === null) {
    missing.push("HEALDESK_ADMIN_PASSWORD_HASH");
  }
  if (signingKey(OPERATOR_PURPOSE) === null) missing.push("HEALDESK_ADMIN_SECRET");
  if (!adminTotpSecret().ok) missing.push(TOTP_SECRET_VARIABLE);
  return missing;
}

// -----------------------------------------------------------------------------
// The password
// -----------------------------------------------------------------------------

type ScryptHash = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
};

/**
 * `scrypt$N$r$p$<base64 salt>$<base64 key>`, or null if it is not that.
 *
 * Every parameter is read from the stored string rather than assumed, so the
 * hash can be re-generated with different work factors without a code change,
 * and so a hash written by an older or newer generator still verifies. What is
 * NOT taken from the string is trust: N, r and p decide how much memory
 * `scrypt` allocates, so each is bounded here. A hash of
 * `scrypt$1073741824$8$1$...$...` is a way to turn one sign-in attempt into an
 * out-of-memory kill, and the value comes from an environment variable, which is
 * exactly the kind of thing that gets pasted in wrong at three in the morning.
 *
 * Returns null on anything unexpected rather than throwing. A malformed hash
 * means "no password is configured", which is the same closed state as no hash
 * at all.
 */
function parseScryptHash(raw: string | undefined): ScryptHash | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > 4096) return null;

  const parts = raw.split("$");
  if (parts.length !== 6) {
    warnAboutEatenDollars(raw, parts.length);
    return null;
  }
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (scheme !== "scrypt") return null;
  if (!/^[0-9]{1,10}$/.test(rawN)) return null;
  if (!/^[0-9]{1,4}$/.test(rawR)) return null;
  if (!/^[0-9]{1,4}$/.test(rawP)) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  // scrypt requires N to be a power of two greater than one. Node throws if it
  // is not, and a throw on this path would be a 500 on a sign-in attempt.
  if (N < 2 || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32) return null;
  if (p < 1 || p > 16) return null;
  // 128 * N * r is scrypt's working set. Cap it at 64 MiB so a mistyped
  // parameter cannot be a memory bomb; N=16384, r=8 needs 16 MiB.
  if (128 * N * r > 64 * 1024 * 1024) return null;

  const salt = decodeBase64Strict(rawSalt);
  const key = decodeBase64Strict(rawKey);
  if (salt === null || key === null) return null;
  if (salt.length < 8 || salt.length > 64) return null;
  if (key.length < 16 || key.length > 128) return null;

  return { N, r, p, salt, key };
}

/**
 * Say the one thing a malformed hash almost always means, once.
 *
 * `HEALDESK_ADMIN_PASSWORD_HASH` is `scrypt$N$r$p$salt$key`, and Next loads
 * `.env` files through dotenv-expand, which reads every `$N` as a variable
 * reference and substitutes the empty string. An unescaped hash in a file
 * therefore arrives here as `scrypt6384==`: one field instead of six. The
 * caller correctly treats that as "no password configured", and the sign-in
 * page then tells the operator there is no admin account on a server whose
 * `.env.local` visibly contains one. Without this line the only way to find
 * that out is to instrument the loader.
 *
 * ## Why the trigger is the field count and not "there is no dollar left"
 *
 * This used to fire only when the value had NO `$` in it, which is what a
 * fully-eaten hash looks like. That misses the commoner half of the same bug.
 * Expansion consumes `$` only where what follows it parses as a variable name,
 * and the fields of a hash are base64: a salt beginning `+2ix` keeps its `$`
 * while a key beginning `klCT` loses one. The result is a value with four
 * dollars instead of five, still unusable, still reported to the operator as
 * "there is no admin account configured on this server", and, under the old
 * condition, still completely silent in the log. Measured, not reasoned about:
 * a generated hash reached this function as
 * `scrypt$16384$8$1$+2ixQ…Zw==+vRxi…Pc=`, five fields, no warning.
 *
 * The field count is the honest trigger because it is the thing the parser
 * actually rejected. Anything that starts with `scrypt` and is not six fields
 * is a damaged hash, whatever damaged it, and the advice below is right for
 * every way it gets damaged.
 *
 * ## This also catches the deploy that sets a real environment variable
 *
 * Expansion runs over the merged environment, not only over what was read out
 * of a file, so a `HEALDESK_ADMIN_PASSWORD_HASH` exported by the platform is
 * rewritten too whenever the same key ALSO appears in a `.env` file the app
 * loads, a `.env.local` baked into an image, or one left beside a checkout.
 * The variable is set correctly, the file is set correctly, and the server
 * still has no admin password. With no `.env` file naming that key the real
 * environment variable survives untouched, which is why the advice is to keep
 * the hash in one place rather than two.
 *
 * Logged, never rendered: the page's job is to say the door is shut, and the
 * reason a deployment is misconfigured belongs in the log the operator can
 * read. The VALUE is never printed. It is a password verifier, and printing a
 * damaged one still prints most of a salt. The field count is printed, because
 * it says which kind of damage happened and reveals nothing about the secret.
 */
let warnedAboutDollars = false;

function warnAboutEatenDollars(raw: string, fields: number): void {
  if (warnedAboutDollars) return;
  if (!raw.startsWith("scrypt")) return;
  warnedAboutDollars = true;
  console.error(
    `[healdesk] HEALDESK_ADMIN_PASSWORD_HASH is set but splits into ${fields} ` +
      "'$'-separated fields instead of 6, which is what dotenv-expand leaves " +
      "behind when it reads part of the hash as a variable reference. Either " +
      "the hash is in a .env file with unescaped dollars, escape every one as " +
      "\\$, or let apps/web/scripts/set-admin-password.ts write it, or the " +
      "same key is set BOTH as a real environment variable and in a .env file " +
      "this app loads, in which case remove it from the file and keep it in " +
      "the environment. Until then this server has no admin password and the " +
      "sign-in page will say so.",
  );
}

/**
 * Standard base64, decoded only if the string is exactly what an encoder would
 * have produced.
 *
 * `Buffer.from(x, "base64")` is lenient: it skips characters outside the
 * alphabet and accepts lengths no encoder emits, so several different strings
 * decode to the same bytes. Nothing here depends on that being impossible, but a
 * hash that does not round-trip is a hash that was pasted in wrong, and saying
 * so by refusing beats deriving against half a salt.
 */
function decodeBase64Strict(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) return null;
  if (bytes.toString("base64") !== value) return null;
  return bytes;
}

/**
 * Is this the administrator's email and password?
 *
 * Both halves are checked, and the scrypt derivation runs whether or not the
 * address matched. That is deliberate: returning early on a wrong address would
 * make this function answer in a millisecond for "not the admin" and in ~70ms
 * for "the admin, wrong password", which is a free oracle for the one thing an
 * attacker would otherwise have to guess. The cost is one derivation per allowed
 * attempt, and the route in front of this refuses to call it at all once the
 * attempt budget is spent, which is why the rate limiter has to run first.
 *
 * Returns false rather than throwing when nothing is configured. A server with
 * no admin account authenticates nobody.
 */
export async function verifyAdminPassword(
  email: unknown,
  password: unknown,
): Promise<boolean> {
  if (typeof email !== "string" || typeof password !== "string") return false;
  if (password.length === 0) return false;
  if (Buffer.byteLength(email, "utf8") > MAX_EMAIL_BYTES) return false;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;

  const expectedEmail = adminEmail();
  const stored = parseScryptHash(process.env.HEALDESK_ADMIN_PASSWORD_HASH);
  if (expectedEmail === null || stored === null) return false;

  const emailMatches = equals(normaliseEmail(email), expectedEmail);

  let derived: Buffer;
  try {
    derived = await deriveKey(password, stored.salt, stored.key.length, {
      N: stored.N,
      r: stored.r,
      p: stored.p,
      // Node's default is 32 MiB, which N=16384, r=8 fits inside, but only
      // just, and a hash regenerated with r=16 would start throwing. The
      // parser has already bounded the working set, so this is that bound
      // plus room for the per-thread blocks.
      maxmem: 128 * stored.N * stored.r + 128 * stored.r * stored.p + 1024 * 1024,
    });
  } catch {
    // Only reachable if the parameters passed validation and node still
    // refused. Nobody signs in; that is the correct direction to fail.
    return false;
  }

  // `scrypt` was asked for exactly `stored.key.length` bytes, so the guard is
  // belt and braces against a future change: `timingSafeEqual` throws on a size
  // mismatch, and a throw here would be a 500 on a sign-in attempt.
  const passwordMatches =
    derived.length === stored.key.length && timingSafeEqual(derived, stored.key);

  // Short-circuiting on two booleans that are both already computed costs
  // nothing observable. The timing that mattered was the derivation above, and
  // it ran either way.
  return emailMatches && passwordMatches;
}

// -----------------------------------------------------------------------------
// The tokens
// -----------------------------------------------------------------------------

/**
 * Constant-time, and length-independent because both sides collapse to a
 * 32-byte digest first.
 *
 * `timingSafeEqual` throws outright when the buffers differ in size, and a
 * received signature is attacker-controlled and can be any length at all, so a
 * naive call is both a crash and, if guarded by an `a.length !== b.length` early
 * return, a leak of the expected length. Hashing first removes both. Never
 * replace this with `===`.
 */
function equals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * `b64url(email).<expiry>`, injective, so no two (email, expiry) pairs produce
 * the same signed bytes. `expiresAt` is the raw digit string that will appear in
 * the cookie, never a re-stringified number.
 */
function macInput(email: string, expiresAt: string): string {
  return `${Buffer.from(email, "utf8").toString("base64url")}.${expiresAt}`;
}

function issueToken(
  purpose: TokenPurpose,
  email: string,
  ttlSeconds: number,
): string {
  const normalised = normaliseEmail(email);
  if (normalised.length === 0) {
    throw new Error(
      "issueOperatorToken requires a non-empty email: a token naming nobody names nobody in the audit log either.",
    );
  }
  if (Buffer.byteLength(normalised, "utf8") > MAX_EMAIL_BYTES) {
    throw new Error(
      `issueOperatorToken received an email over ${MAX_EMAIL_BYTES} bytes.`,
    );
  }

  const key = signingKey(purpose);
  if (key === null) {
    throw new Error(
      "HEALDESK_ADMIN_SECRET is required: the admin session cookie cannot be signed without it.",
    );
  }

  const expiresAt = String(Date.now() + ttlSeconds * 1000);
  const payload = macInput(normalised, expiresAt);
  return `${payload}.${sign(payload, key)}`;
}

/**
 * The email this token names, or null.
 *
 * Never throws. It runs on an incoming request whose cookie is attacker-chosen,
 * so every malformed shape is a null and never a 500. A null answer means "sign
 * in again" and nothing more specific: forged, expired, signed with a rotated
 * secret and naming an address this server is no longer configured for are all
 * the same event from the outside.
 */
function verifyToken(purpose: TokenPurpose, value: unknown): string | null {
  // Defensive `typeof`: this comes off the wire, and a caller reading a cookie
  // store can hand us anything whatever the signature says.
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_TOKEN_LENGTH) return null;

  const key = signingKey(purpose);
  if (key === null) return null;

  // The address the server is configured with today. Read before the signature
  // check so that an unconfigured server refuses every token rather than
  // accepting one and then having nothing to compare it against.
  const expected = adminEmail();
  if (expected === null) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [rawEmail, expiresAtRaw, signature] = parts as [string, string, string];

  // Shape before signature: this is public structure, checking it costs nothing
  // and it keeps the work below operating on strings of a known alphabet.
  if (!B64URL.test(rawEmail)) return null;
  if (!EXPIRY.test(expiresAtRaw)) return null;

  const payload = `${rawEmail}.${expiresAtRaw}`;
  if (!equals(sign(payload, key), signature)) return null;

  if (Date.now() >= Number(expiresAtRaw)) return null;

  const bytes = Buffer.from(rawEmail, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_EMAIL_BYTES) return null;
  // Canonical re-encode. The MAC covers the encoded form so no variant spelling
  // would verify anyway; this keeps decoding a total function rather than a
  // source of surprises.
  if (bytes.toString("base64url") !== rawEmail) return null;

  const email = normaliseEmail(bytes.toString("utf8"));
  // There is one account. A validly signed token for any other address is a
  // token minted before the address changed, and it is not a session now.
  if (!equals(email, expected)) return null;

  return email;
}

/** Mint the cookie value that signs the administrator in for eight hours. */
export function issueOperatorToken(email: string): string {
  return issueToken(OPERATOR_PURPOSE, email, OPERATOR_TTL_SECONDS);
}

/** The administrator's email if this cookie is a live session, else null. */
export function verifyOperatorToken(value: string | undefined): string | null {
  return verifyToken(OPERATOR_PURPOSE, value);
}

// -----------------------------------------------------------------------------
// The step cookie
// -----------------------------------------------------------------------------

/** Digits only, bounded, as the expiry is: shape before signature. */
const STEP_DIGITS = /^[0-9]{1,15}$/;

/**
 * `<step>.<hmac>` under the step cookie's own derived key, so it can never
 * verify as a session and a session can never verify as one of these.
 *
 * Throws when the signing secret is missing, like the operator token. It is
 * only ever minted in the same response as an operator cookie, which has
 * already needed the secret.
 */
export function issueStepToken(step: number): string {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new Error("issueStepToken requires a non-negative whole step.");
  }
  const key = signingKey(STEP_PURPOSE);
  if (key === null) {
    throw new Error(
      "HEALDESK_ADMIN_SECRET is required: the step cookie cannot be signed without it.",
    );
  }
  const payload = String(step);
  return `${payload}.${sign(payload, key)}`;
}

/**
 * The step this browser last signed in with, or null when the cookie is
 * absent, forged, or signed under a secret this server no longer has. Never
 * throws: the value is whatever the request carried.
 *
 * Null means "nothing known about this browser", never "refuse": a cookie we
 * cannot read is not evidence of a replay, and the in-process ledger still
 * applies.
 */
export function verifyStepToken(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  const key = signingKey(STEP_PURPOSE);
  if (key === null) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (!STEP_DIGITS.test(payload)) return null;
  if (!equals(sign(payload, key), signature)) return null;
  return Number(payload);
}

/**
 * The single question every operator-facing surface asks: is the administrator
 * signed in on this browser, and under what address?
 *
 * Returns null rather than throwing or redirecting so the caller decides what an
 * unauthenticated request means: a page sends them to the sign-in door, a route
 * handler answers 401.
 */
export async function requireOperator(): Promise<string | null> {
  const store = await cookies();
  return verifyOperatorToken(store.get(OPERATOR_COOKIE)?.value);
}

// -----------------------------------------------------------------------------
// Cookie flags
// -----------------------------------------------------------------------------

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: string;
  maxAge: number;
};

/**
 * The flags, in one place so the route that sets a cookie and anything that
 * later clears it cannot drift apart. A browser only replaces a cookie when
 * name, path and domain all match, so sign-out must reuse these.
 *
 * `sameSite: "strict"` because this cookie has no legitimate reason to ride
 * along on a navigation from another site, and refusing to send it there removes
 * cross-site request forgery against the console as a category rather than
 * mitigating it. The visible cost is that following a link to /admin from
 * outside lands on the sign-in page even with a valid session; one click on a
 * page nobody links to is a fair price.
 *
 * `path: "/"` because the console lives at /admin and its API at /api/admin, and
 * no narrower prefix covers both. `secure` is off outside production only
 * because localhost is not HTTPS; in production without it this is a plaintext
 * bearer token on the wire.
 */
export function operatorCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OPERATOR_TTL_SECONDS,
  };
}

/**
 * The step cookie is scoped to the one route that reads it, so it rides on
 * sign-in attempts and nothing else.
 *
 * Deliberately NOT cleared on sign-out. A browser that signs out and then
 * submits the same six digits inside their ninety seconds is exactly the reuse
 * this cookie exists to refuse, and clearing it on the way out would hand that
 * back.
 */
export function stepCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/admin/session",
    maxAge: STEP_COOKIE_TTL_SECONDS,
  };
}
