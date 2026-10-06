import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { signInLinks, type SignInLinkPurpose } from "@/db/schema";

/**
 * Single-use sign-in links: the only way into the clinic portal (plan Part D1,
 * design D4). There is no password anywhere. A link is minted for one user,
 * emailed or handed to the paying browser, and consumed exactly once by a
 * POST, which then starts a Better Auth session (lib/auth.ts,
 * `startLinkSession`).
 *
 * The connection_links rules, on the identity plane (`sign_in_links` has no
 * clinic and no RLS; 0043):
 * - 32 random bytes, base64url. Only the SHA-256 of the string we send is
 *   stored, and a CHECK pins `token_hash` to 32 bytes, so storing the token
 *   itself would fail the INSERT;
 * - consumption is one conditional UPDATE (`used_at IS NULL AND expires_at >
 *   now()`), so two submissions of one link cannot both sign in, and a
 *   trigger refuses any later write to a consumed row;
 * - looking a link up never consumes it. A GET renders "Continue" and only the
 *   POST spends the link, so a mail scanner that follows every URL in an
 *   inbox signs nobody in and uses nothing up.
 *
 * The token is returned once, to go into one email or one redirect. It is
 * never logged and never written anywhere but that message.
 */

const TOKEN_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How long each kind of link works (plan C3, C4, D1). */
export const SIGN_IN_LINK_TTL_MS: Readonly<Record<SignInLinkPurpose, number>> = {
  /** The paying browser on /welcome, which uses it at once. */
  checkout: 10 * 60 * 1000,
  /** /sign-in and "Send again". */
  sign_in: 15 * 60 * 1000,
  /** "Continue setup" in the welcome email (B1). */
  welcome: 72 * 60 * 60 * 1000,
  /** Not issued in v1: one sign-in per clinic, so nobody is invited. */
  invite: 7 * 24 * 60 * 60 * 1000,
};

export type IssuedSignInLink = { id: string; token: string; expiresAt: Date };

export type IssueSignInLinkInput = {
  userId: string;
  purpose: SignInLinkPurpose;
  /**
   * Makes one source mint at most one link of this purpose (a partial unique
   * index): the checkout link for an intent is issued once, however many
   * times /welcome polls. Never a raw id; callers pass a digest.
   */
  sourceRef?: string | null;
  /** A path on this app to land on after sign-in. Anything else is refused. */
  redirectTo?: string | null;
  /** A service name or an actor label, kept as a snapshot. */
  issuedBy: string;
};

/**
 * Mint a link. Returns null when `sourceRef` already minted one of this
 * purpose, because a token cannot be shown twice: the second caller tells
 * the person to use what they were already given.
 */
export async function issueSignInLink(input: IssueSignInLinkInput): Promise<IssuedSignInLink | null> {
  if (input.redirectTo != null && !isSafeRedirect(input.redirectTo)) {
    throw new Error("A sign-in link may only land on a path of this app.");
  }
  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  raw.fill(0);

  const rows = await unsafeDb
    .insert(signInLinks)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      purpose: input.purpose,
      sourceRef: input.sourceRef ?? null,
      redirectTo: input.redirectTo ?? null,
      // The database's clock, like every other expiry it enforces.
      expiresAt: sql`now() + ${SIGN_IN_LINK_TTL_MS[input.purpose]} * interval '1 millisecond'`,
      issuedBy: input.issuedBy,
    })
    .onConflictDoNothing()
    .returning({ id: signInLinks.id, expiresAt: signInLinks.expiresAt });

  const row = rows[0];
  if (!row) return null;
  return { id: row.id, token, expiresAt: row.expiresAt };
}

export type SignInLinkProblem = "unknown" | "used" | "expired";

export type ResolvedSignInLink =
  | {
      ok: true;
      userId: string;
      email: string;
      purpose: SignInLinkPurpose;
      redirectTo: string | null;
      expiresAt: Date;
    }
  | { ok: false; reason: SignInLinkProblem };

/** What a link would do, without using it. For the GET that renders "Continue". */
export async function lookUpSignInLink(token: unknown): Promise<ResolvedSignInLink> {
  const hash = hashIfWellFormed(token);
  if (!hash) return { ok: false, reason: "unknown" };

  const [row] = await unsafeDb
    .select({
      userId: signInLinks.userId,
      email: user.email,
      purpose: signInLinks.purpose,
      redirectTo: signInLinks.redirectTo,
      expiresAt: signInLinks.expiresAt,
      usedAt: signInLinks.usedAt,
      expired: sql<boolean>`${signInLinks.expiresAt} <= now()`,
    })
    .from(signInLinks)
    .innerJoin(user, eq(user.id, signInLinks.userId))
    .where(eq(signInLinks.tokenHash, hash))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expired) return { ok: false, reason: "expired" };
  return {
    ok: true,
    userId: row.userId,
    email: row.email,
    purpose: row.purpose,
    redirectTo: row.redirectTo,
    expiresAt: row.expiresAt,
  };
}

export type ConsumedSignInLink =
  | { ok: true; userId: string; purpose: SignInLinkPurpose; redirectTo: string | null }
  | { ok: false; reason: SignInLinkProblem };

/**
 * Spend a link. One conditional UPDATE, so of two concurrent submissions
 * exactly one gets the user back. The IP is a diagnostic, stored only when it
 * parses, because `inet` refuses junk and a strange proxy header must not
 * cost anyone their sign-in.
 */
export async function consumeSignInLink(token: unknown, ip: string | null): Promise<ConsumedSignInLink> {
  const hash = hashIfWellFormed(token);
  if (!hash) return { ok: false, reason: "unknown" };

  const rows = await unsafeDb
    .update(signInLinks)
    .set({ usedAt: sql`now()`, consumedIp: normaliseIp(ip) })
    .where(
      and(
        eq(signInLinks.tokenHash, hash),
        isNull(signInLinks.usedAt),
        gt(signInLinks.expiresAt, sql`now()`),
      ),
    )
    .returning({
      userId: signInLinks.userId,
      purpose: signInLinks.purpose,
      redirectTo: signInLinks.redirectTo,
    });

  const row = rows[0];
  if (row) return { ok: true, ...row };

  // Lost the race, or never could have won: say which, for the page.
  const state = await lookUpSignInLink(token);
  return { ok: false, reason: state.ok ? "used" : state.reason };
}

/**
 * A same-origin path, the way the table's CHECK sees it and stricter: it
 * starts with one slash, and has no backslash and no control character,
 * because browsers turn `/\host` and `/<TAB>/host` into `//host`.
 */
export function isSafeRedirect(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(path)
  );
}

/** "l•••@glowspa.com": enough to recognise an inbox, not enough to read it out. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The digest of a caller-supplied token, or null when it could not be one of ours. */
function hashIfWellFormed(token: unknown): Buffer | null {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return null;
  return hashToken(token);
}

function normaliseIp(ip: string | null): string | null {
  const first = ip?.split(",")[0]?.trim();
  return first && isIP(first) !== 0 ? first : null;
}
