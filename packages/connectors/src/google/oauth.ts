import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { fail, failure, ok, type Result } from "../result";
import type { ConnectorContext } from "../types";

import { asString, fetchWithTimeout, googleTokenError, isRecord, type GoogleReply } from "./http";

/**
 * Google OAuth for the Calendar connection: the consent URL, the code
 * exchange, refresh, revocation, the ID token and the scope check.
 *
 * Pure protocol. Which clinic a sign-in is for, which link started it, the
 * key the nonce and PKCE verifier are derived under, and whether a grant is
 * still live on another location before it is revoked are all apps/app's,
 * because they need the database and the environment and this package
 * touches neither.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Exactly the five scopes healdesk asks for, in this order (plan §1.4 A1 as
 * the owner widened it on 6 October 2026), as Google's verification
 * submission lists them. `openid` and the email scope identify the account;
 * `calendar.calendarlist.readonly` lists the calendars the account owns, so
 * the clinic can choose which one healdesk books into;
 * `calendar.events.freebusy` reads when that calendar is free or busy;
 * `calendar.events.owned` adds and reads back the events healdesk creates,
 * and only on calendars the account owns. Adding a scope means a new Google
 * review, so this list is pinned by a test.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

/**
 * The three calendar scopes the connection cannot work without. A sign-in
 * missing one is refused (`scopes`); a refresh that comes back without one is
 * `scope_lost`. The email scope may be refused.
 */
export const REQUIRED_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

/**
 * Send a PKCE challenge (S256) with every sign-in. Google documents PKCE for
 * installed apps; whether it accepts one from a confidential web client is a
 * sandbox check (plan §1.3), and if it refuses, this turns PKCE off for both
 * the start route and the callback without touching either.
 */
export const GOOGLE_USE_PKCE = true;

/** healdesk's OAuth client, as apps/app reads it from its environment. */
export type GoogleOAuthClient = NonNullable<ConnectorContext["oauthClient"]>;

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

/** The granted scopes Google lists in a token response, split on spaces, case kept. */
function scopesOf(value: unknown): string[] {
  return typeof value === "string" ? value.split(" ").filter((scope) => scope.length > 0) : [];
}

export type GrantedScopes = {
  /** Every scope Google says it granted, as it wrote them. Stored in the connection's metadata. */
  granted: string[];
  /** The required calendar scopes that are missing. */
  missing: string[];
  /** Every required calendar scope is present. */
  complete: boolean;
  /** The email scope is present; without it the account email is unknown and shown as "a Google account". */
  email: boolean;
};

/**
 * Which of the scopes healdesk needs Google actually granted (plan §4.6).
 *
 * Google's granular consent lets a person untick a scope, so the token
 * response, not the request, says what healdesk may do. Compared as full URLs
 * and case-sensitively: a short form such as "calendar.events.owned" is not
 * the scope, and nothing is inferred from a broader one healdesk never asked
 * for.
 */
export function grantedCalendarScopes(
  scope: string | readonly string[] | undefined,
): GrantedScopes {
  const granted = typeof scope === "string" ? scopesOf(scope) : [...(scope ?? [])];
  const missing = REQUIRED_CALENDAR_SCOPES.filter((required) => !granted.includes(required));
  return { granted, missing, complete: missing.length === 0, email: granted.includes(EMAIL_SCOPE) };
}

/**
 * The shortest nonce a sign-in may use: 22 base64url characters, 128 bits.
 * deriveGoogleOAuthSecrets makes 43. A shorter one, an empty one above all,
 * would let an ID token from another sign-in pass the nonce check, so it is
 * refused both where the nonce is sent and where it is checked.
 */
const MIN_NONCE_LENGTH = 22;

/**
 * The consent URL the start route redirects to (plan §4.3).
 *
 * Offline access with `prompt=consent select_account`, so every sign-in
 * yields a refresh token and lets the person pick the account. Never `hd` or
 * `login_hint`: which account holds the calendar is the person's choice, and
 * the account kind is read from the ID token afterwards, not steered before.
 *
 * Throws, as a programmer error, on an empty state or a short nonce: either
 * would send a person to Google with the callback's protection already gone.
 */
export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  /** The PKCE verifier from deriveGoogleOAuthSecrets; its S256 challenge is sent. Null sends none. */
  codeVerifier: string | null;
}): string {
  if (input.state.length === 0) throw new Error("buildGoogleAuthUrl needs the sign-in's state.");
  if (input.nonce.length < MIN_NONCE_LENGTH) {
    throw new Error(`buildGoogleAuthUrl needs a nonce of at least ${MIN_NONCE_LENGTH} characters.`);
  }
  const url = new URL(GOOGLE_AUTH_URL);
  const params = url.searchParams;
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("response_type", "code");
  params.set("scope", GOOGLE_SCOPES.join(" "));
  params.set("access_type", "offline");
  params.set("prompt", "consent select_account");
  params.set("include_granted_scopes", "false");
  params.set("state", input.state);
  params.set("nonce", input.nonce);
  if (input.codeVerifier !== null) {
    params.set("code_challenge", pkceChallengeFor(input.codeVerifier));
    params.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/**
 * The nonce and PKCE verifier for one sign-in (plan §4.4), each an HMAC of
 * the state under apps/app's key, so the callback recomputes them from the
 * state it consumes and neither is ever stored. 43 base64url characters
 * apiece, the shortest verifier RFC 7636 allows and plenty for a nonce.
 *
 * `key` is apps/app's HKDF output; this package never learns where it came
 * from. A short key is refused, because a guessable key makes the nonce
 * guessable and the PKCE binding worthless.
 */
export function deriveGoogleOAuthSecrets(
  key: Uint8Array | ArrayBuffer,
  state: string,
  opts: { pkce?: boolean } = {},
): { nonce: string; codeVerifier: string | null } {
  const bytes = key instanceof Uint8Array ? key : new Uint8Array(key);
  if (bytes.length < 32) {
    throw new Error("deriveGoogleOAuthSecrets needs a key of at least 32 bytes.");
  }
  if (state.length === 0) throw new Error("deriveGoogleOAuthSecrets needs the sign-in's state.");
  const mac = (label: string) =>
    createHmac("sha256", bytes).update(`${label}${state}`).digest("base64url");
  return {
    nonce: mac("nonce:"),
    codeVerifier: (opts.pkce ?? GOOGLE_USE_PKCE) ? mac("pkce:") : null,
  };
}

/** The S256 code challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function usableClient(client: GoogleOAuthClient | undefined): client is GoogleOAuthClient {
  return client !== undefined && client.clientId.length > 0 && client.clientSecret.length > 0;
}

/** No client means no request: the same `oauth_client` a client Google rejects gets. */
function unconfiguredClient<T>(context: string): Result<T> {
  return failure("misconfigured", `${context}: healdesk's Google OAuth client is not configured`, {
    reason: "oauth_client",
  });
}

async function tokenRequest(
  form: Record<string, string>,
  call: "exchange" | "refresh",
  context: string,
): Promise<Result<GoogleReply>> {
  return fetchWithTimeout(
    GOOGLE_TOKEN_URL,
    { method: "POST", headers: FORM_HEADERS, body: new URLSearchParams(form).toString() },
    call,
    context,
  );
}

function expiresInOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function malformed<T>(context: string, what: string, status: number): Result<T> {
  return failure("malformed_response", `${context}: ${what}`, {
    status,
    reason: "malformed_response",
  });
}

/**
 * Everything the code exchange got from Google, so the callback can keep the
 * grant or undo it. The refresh token is the only thing the app keeps.
 */
export type GoogleGrant = {
  /**
   * Null when Google issued none: the callback's `no_refresh` outcome (plan
   * §4.5 step 4). The grant still exists at Google then, and `accessToken`
   * is enough to revoke it, since Google's revoke ends the whole grant.
   */
  refreshToken: string | null;
  /** Never stored; good for an hour, and for revoking the grant. */
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Every scope Google granted, as it wrote them; check with grantedCalendarScopes. */
  scopes: string[];
  /**
   * Read with parseGoogleIdToken; never stored. Null when Google sent none,
   * and then nothing says which account was granted, so the callback cannot
   * check that no other location uses it before revoking (§4.5 step 3).
   */
  idToken: string | null;
};

/**
 * Trade the callback's code for tokens (plan §4.5 step 3), 5 s.
 *
 * Every secret travels in the form body, never the URL. Once Google answers
 * 200 a grant exists, whatever the response lacks, so this hands back what
 * Google sent rather than refusing. Refusing here would drop the tokens the
 * callback needs to undo a grant it is not going to keep: every failure after
 * the exchange revokes the grant when no other location uses the account. The
 * callback makes the refusals, in order: the scopes (grantedCalendarScopes),
 * no refresh token (`no_refresh`: healdesk asks for offline access with
 * `prompt=consent` precisely so there always is one, and a connection that
 * dies with its first access token is worse than one that never connected),
 * then the ID token. Only a 200 without an access token is malformed here;
 * Google always sends one.
 */
export async function exchangeGoogleCode(input: {
  client: GoogleOAuthClient | undefined;
  code: string;
  redirectUri: string;
  /** The verifier the start route's challenge was made from, or null when PKCE is off. */
  codeVerifier: string | null;
}): Promise<Result<GoogleGrant>> {
  const ctx = "google exchangeCode";
  if (!usableClient(input.client)) return unconfiguredClient(ctx);
  if (input.code.length === 0) {
    return failure("unsupported", `${ctx}: no code to exchange`, { reason: "missing_code" });
  }

  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
  };
  if (input.codeVerifier !== null) form.code_verifier = input.codeVerifier;

  const reply = await tokenRequest(form, "exchange", ctx);
  if (!reply.ok) return fail(reply.error);
  const { status, json } = reply.value;
  if (!reply.value.ok) return googleTokenError(reply.value, ctx);
  if (!isRecord(json)) {
    return malformed(ctx, "Google answered without a readable token response", status);
  }

  const accessToken = asString(json.access_token);
  const expiresIn = expiresInOf(json.expires_in);
  if (!accessToken || expiresIn === undefined) {
    return malformed(ctx, "Google's token response has no access token or lifetime", status);
  }

  return ok({
    refreshToken: asString(json.refresh_token) ?? null,
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: scopesOf(json.scope),
    idToken: asString(json.id_token) ?? null,
  });
}

/** A fresh access token. Never stored: the adapter keeps it in memory only. */
export type GoogleAccessToken = { accessToken: string; expiresAt: Date; scopes: string[] };

/**
 * Mint an access token from the refresh token (plan §5.5), 3 s.
 *
 * The classification is what the watch and the booking path act on:
 * `invalid_grant` (revoked, expired, or the Workspace session policy wants a
 * fresh sign-in) and `admin_policy_enforced` are definitive for this clinic's
 * grant, and so is a response whose scope list has lost a calendar scope
 * (`scope_lost`). A client problem is `oauth_client`, ours.
 *
 * Google documents `scope` as always present. A response without the field
 * is not read as a loss: absence is not evidence, and a calendar call made
 * with a token that really lacks the scope answers 403. A field that is there
 * is evidence, so one missing a calendar scope is `scope_lost`, and an empty
 * one most of all: it says every scope is gone.
 */
export async function refreshGoogleAccessToken(input: {
  client: GoogleOAuthClient | undefined;
  refreshToken: string;
}): Promise<Result<GoogleAccessToken>> {
  const ctx = "google refresh";
  if (!usableClient(input.client)) return unconfiguredClient(ctx);
  if (input.refreshToken.length === 0) {
    return failure("misconfigured", `${ctx}: the connection holds no refresh token`, {
      reason: "missing_refresh_token",
    });
  }

  const reply = await tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
    },
    "refresh",
    ctx,
  );
  if (!reply.ok) return fail(reply.error);
  const { status, json } = reply.value;
  if (!reply.value.ok) return googleTokenError(reply.value, ctx);
  if (!isRecord(json)) {
    return malformed(ctx, "Google answered without a readable token response", status);
  }

  const accessToken = asString(json.access_token);
  const expiresIn = expiresInOf(json.expires_in);
  if (!accessToken || expiresIn === undefined) {
    return malformed(ctx, "Google's token response has no access token or lifetime", status);
  }
  if (json.scope !== undefined && typeof json.scope !== "string") {
    return malformed(ctx, "Google's token response lists its scopes in an unreadable form", status);
  }
  const scopes = scopesOf(json.scope);
  if (json.scope !== undefined && !grantedCalendarScopes(scopes).complete) {
    return failure("unauthorised", `${ctx}: the grant no longer includes every calendar scope`, {
      status,
      reason: "scope_lost",
    });
  }

  return ok({ accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000), scopes });
}

/**
 * Revoke a token at Google, 4 s, one retry on a transient failure
 * (revocation is idempotent, so a second try cannot do harm).
 *
 * Revoking ends every grant that Google user gave healdesk's project, on
 * every clinic it is connected to. Deciding that no other location still
 * uses the account is the caller's job (apps/app's revokeGoogleGrantIfUnused,
 * keyed by the Google subject); this only speaks the protocol. 200 is
 * "revoked"; 400 is "already_invalid", which for the caller is just as done.
 */
export async function revokeGoogleToken(
  token: string,
): Promise<Result<"revoked" | "already_invalid">> {
  const ctx = "google revoke";
  if (token.length === 0) {
    return failure("misconfigured", `${ctx}: no token to revoke`, { reason: "missing_token" });
  }
  const first = await revokeOnce(token, ctx);
  if (first.ok || !first.error.retryable) return first;
  return revokeOnce(token, ctx);
}

async function revokeOnce(
  token: string,
  ctx: string,
): Promise<Result<"revoked" | "already_invalid">> {
  const reply = await fetchWithTimeout(
    GOOGLE_REVOKE_URL,
    { method: "POST", headers: FORM_HEADERS, body: new URLSearchParams({ token }).toString() },
    "revoke",
    ctx,
  );
  if (!reply.ok) return fail(reply.error);
  if (reply.value.status === 200) return ok("revoked");
  if (reply.value.status === 400) return ok("already_invalid");
  return googleTokenError(reply.value, ctx);
}

/** Who signed in, as far as healdesk keeps it. */
export type GoogleIdentity = {
  /** sha256hex("google:" + sub). The raw subject never leaves parseGoogleIdToken. */
  accountRef: string;
  /** Only when Google says it is verified. Shown to the clinic; never audited, logged or projected to ops. */
  email: string | null;
  /** The token carries `hd`: a Google Workspace or Cloud Identity account. Says nothing about Google's BAA. */
  managed: boolean;
  /** The `hd` claim when present. */
  hostedDomain: string | null;
};

const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const EXPIRY_SKEW_MS = 60_000;
const ISSUED_AT_SKEW_MS = 300_000;

function idTokenRefused<T>(reason: string, what: string): Result<T> {
  return failure("unauthorised", `google idToken: ${what}`, { reason });
}

/**
 * Read the ID token from the code exchange (plan §4.7).
 *
 * Decoded without checking its signature: it came straight from Google's
 * token endpoint over TLS, in answer to a request healdesk authenticated with
 * its client secret, which OpenID Connect Core §3.1.3.7(6) accepts in place
 * of a signature check. The claims are still checked: issuer, audience,
 * expiry (60 s of skew), issue time (no more than 300 s ahead), the nonce
 * derived for this sign-in, and a subject. An expected nonce shorter than the
 * one buildGoogleAuthUrl accepts is refused outright, so a caller that lost
 * its nonce cannot match a token that carries none.
 *
 * `hd` decides only whether the account is managed. It is never taken as
 * evidence that the organisation accepted Google's business associate
 * agreement; that is the practice's own statement in its calendar terms.
 */
export function parseGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; now?: Date },
): Result<GoogleIdentity> {
  const segments = idToken.split(".");
  const payload = segments.length === 3 ? segments[1] : undefined;
  if (!payload) {
    return failure("malformed_response", "google idToken: not a JWT", {
      reason: "id_token_malformed",
    });
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return failure("malformed_response", "google idToken: the payload is not JSON", {
      reason: "id_token_malformed",
    });
  }
  if (!isRecord(claims)) {
    return failure("malformed_response", "google idToken: the payload is not an object", {
      reason: "id_token_malformed",
    });
  }

  const now = (expected.now ?? new Date()).getTime();
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    return idTokenRefused("id_token_issuer", "not issued by Google");
  }
  if (claims.aud !== expected.clientId) {
    return idTokenRefused("id_token_audience", "issued to another client");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - EXPIRY_SKEW_MS) {
    return idTokenRefused("id_token_expired", "expired");
  }
  if (typeof claims.iat !== "number" || claims.iat * 1000 > now + ISSUED_AT_SKEW_MS) {
    return idTokenRefused("id_token_issued_ahead", "issued in the future");
  }
  if (
    expected.nonce.length < MIN_NONCE_LENGTH ||
    typeof claims.nonce !== "string" ||
    !sameString(claims.nonce, expected.nonce)
  ) {
    return idTokenRefused("id_token_nonce", "the nonce is not this sign-in's");
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) {
    return idTokenRefused("id_token_subject", "no subject");
  }

  const verified = claims.email_verified === true || claims.email_verified === "true";
  const hostedDomain = asString(claims.hd) ?? null;
  return ok({
    accountRef: createHash("sha256").update(`google:${sub}`).digest("hex"),
    email: verified ? (asString(claims.email) ?? null) : null,
    managed: hostedDomain !== null,
    hostedDomain,
  });
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
