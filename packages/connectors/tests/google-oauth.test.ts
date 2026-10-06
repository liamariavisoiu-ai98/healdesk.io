import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  fakeGoogleCalendar,
  fakeGoogleIdToken,
  type FakeGoogleCalendar,
  type FakeGoogleFailure,
} from "../src/google/fake";
import { setGoogleFetch, setGoogleTimeouts } from "../src/google/http";
import {
  buildGoogleAuthUrl,
  deriveGoogleOAuthSecrets,
  exchangeGoogleCode,
  GOOGLE_SCOPES,
  GOOGLE_USE_PKCE,
  grantedCalendarScopes,
  parseGoogleIdToken,
  refreshGoogleAccessToken,
  REQUIRED_CALENDAR_SCOPES,
  revokeGoogleToken,
} from "../src/google/oauth";
import type { Result } from "../src/result";

/**
 * Google OAuth for the Calendar connection, against the in-memory Google.
 * Never a live call: the global fetch throws for the whole file, so a request
 * that escaped setGoogleFetch would fail here instead of reaching Google.
 *
 * The scope list is asserted as five literal strings rather than through the
 * constant, because changing it means a new Google verification review and
 * this test is where that should be noticed.
 */

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("live call attempted from the Google OAuth tests");
  });
});
afterAll(() => vi.unstubAllGlobals());

/** A synthetic stand-in for apps/app's HKDF output. */
const KEY = new Uint8Array(32).fill(7);
const STATE = "c3ludGhldGljLXN0YXRlLWZvci1hLXRlc3Q";
const REDIRECT = "https://app.healdesk.test/api/calendar/google/callback";
const WORKSPACE = "100000000000000000001";
const CONSUMER = "100000000000000000002";

const OPENID = "openid";
const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const CALENDARLIST = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const FREEBUSY = "https://www.googleapis.com/auth/calendar.events.freebusy";
const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const ALL = [OPENID, EMAIL, CALENDARLIST, FREEBUSY, OWNED];

let google: FakeGoogleCalendar;

beforeEach(() => {
  google = fakeGoogleCalendar();
  google.addAccount({ sub: WORKSPACE, email: "bookings@practice.example", hd: "practice.example" });
  google.addAccount({ sub: CONSUMER, email: "owner@personal.example" });
  setGoogleFetch(google.fetch);
});

afterEach(() => {
  setGoogleFetch(undefined);
  setGoogleTimeouts(undefined);
});

function failed<T>(result: Result<T>) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error;
}

function succeeded<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The browser leg: consent URL, the person agrees at the fake Google, a code comes back. */
function signIn(
  sub: string,
  opts: { pkce?: boolean; scopes?: readonly string[]; withholdRefreshToken?: boolean } = {},
) {
  const secrets = deriveGoogleOAuthSecrets(KEY, STATE, { pkce: opts.pkce });
  const authUrl = buildGoogleAuthUrl({
    clientId: google.client.clientId,
    redirectUri: REDIRECT,
    state: STATE,
    nonce: secrets.nonce,
    codeVerifier: secrets.codeVerifier,
  });
  const consent = google.authorize(authUrl, {
    sub,
    scopes: opts.scopes,
    withholdRefreshToken: opts.withholdRefreshToken,
  });
  if (!("code" in consent)) throw new Error(`consent refused: ${consent.error}`);
  return { secrets, authUrl, code: consent.code };
}

/** signIn, then the exchange, which must succeed. */
async function connect(sub: string, opts: Parameters<typeof signIn>[1] = {}) {
  const { secrets, code } = signIn(sub, opts);
  const grant = succeeded(
    await exchangeGoogleCode({
      client: google.client,
      code,
      redirectUri: REDIRECT,
      codeVerifier: secrets.codeVerifier,
    }),
  );
  return { secrets, code, grant };
}

describe("the consent URL", () => {
  test("carries exactly the five literal scopes in order, offline access, consent select_account and S256, and no hd", () => {
    const secrets = deriveGoogleOAuthSecrets(KEY, STATE);
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: "client-123.apps.googleusercontent.com",
        redirectUri: REDIRECT,
        state: STATE,
        nonce: secrets.nonce,
        codeVerifier: secrets.codeVerifier,
      }),
    );
    const q = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(q.get("scope")?.split(" ")).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent select_account");
    expect(q.get("include_granted_scopes")).toBe("false");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(
      createHash("sha256")
        .update(secrets.codeVerifier ?? "")
        .digest("base64url"),
    );
    expect(q.get("state")).toBe(STATE);
    expect(q.get("nonce")).toBe(secrets.nonce);
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("client_id")).toBe("client-123.apps.googleusercontent.com");

    // Which account holds the calendar is the person's choice, read from the
    // ID token afterwards; nothing steers it.
    expect(q.has("hd")).toBe(false);
    expect(q.has("login_hint")).toBe(false);
    expect([...q.keys()].sort()).toEqual(
      [
        "access_type",
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "include_granted_scopes",
        "nonce",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
  });

  test("the scope constants are the five literal strings, and booking needs the three calendar ones", () => {
    expect([...GOOGLE_SCOPES]).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
    expect([...REQUIRED_CALENDAR_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
  });

  test("GOOGLE_USE_PKCE = false sends no challenge and no verifier, and the code still exchanges", async () => {
    // On by default; the sandbox check of a confidential client may turn it off.
    expect(GOOGLE_USE_PKCE).toBe(true);
    expect(deriveGoogleOAuthSecrets(KEY, STATE).codeVerifier).not.toBeNull();

    const { secrets, authUrl, code } = signIn(WORKSPACE, { pkce: false });
    expect(secrets.codeVerifier).toBeNull();
    const q = new URL(authUrl).searchParams;
    expect(q.has("code_challenge")).toBe(false);
    expect(q.has("code_challenge_method")).toBe(false);

    const grant = await exchangeGoogleCode({
      client: google.client,
      code,
      redirectUri: REDIRECT,
      codeVerifier: secrets.codeVerifier,
    });
    expect(grant.ok).toBe(true);
    expect(google.lastRequest().form?.has("code_verifier")).toBe(false);
  });

  test("an empty state or a short nonce is a programmer error, refused before anyone is sent to Google", () => {
    const input = {
      clientId: "client-123.apps.googleusercontent.com",
      redirectUri: REDIRECT,
      state: STATE,
      nonce: deriveGoogleOAuthSecrets(KEY, STATE).nonce,
      codeVerifier: null,
    };
    expect(() => buildGoogleAuthUrl({ ...input, state: "" })).toThrow(/state/);
    expect(() => buildGoogleAuthUrl({ ...input, nonce: "" })).toThrow(/nonce/);
    expect(() => buildGoogleAuthUrl({ ...input, nonce: "a".repeat(21) })).toThrow(/nonce/);
    expect(() => buildGoogleAuthUrl({ ...input, nonce: "a".repeat(22) })).not.toThrow();
  });
});

describe("PKCE and nonce derivation", () => {
  test("both come from the state under the key, so the callback recomputes them and nothing is stored", () => {
    const a = deriveGoogleOAuthSecrets(KEY, STATE);
    expect(deriveGoogleOAuthSecrets(KEY, STATE)).toEqual(a);
    expect(deriveGoogleOAuthSecrets(KEY.buffer.slice(0), STATE)).toEqual(a);

    const other = deriveGoogleOAuthSecrets(KEY, `${STATE}x`);
    expect(other.nonce).not.toBe(a.nonce);
    expect(other.codeVerifier).not.toBe(a.codeVerifier);
    expect(a.nonce).not.toBe(a.codeVerifier);
    // 32 bytes of HMAC: 43 base64url characters, the shortest verifier RFC 7636 allows.
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const otherKey = deriveGoogleOAuthSecrets(new Uint8Array(32).fill(8), STATE);
    expect(otherKey.nonce).not.toBe(a.nonce);
  });

  test("a short key or an empty state is refused, since either makes the nonce guessable", () => {
    expect(() => deriveGoogleOAuthSecrets(new Uint8Array(16), STATE)).toThrow(/32 bytes/);
    expect(() => deriveGoogleOAuthSecrets(KEY, "")).toThrow(/state/);
  });
});

describe("the code exchange", () => {
  test("trades the code for a refresh token, with every secret in the form body and none in a URL", async () => {
    const { secrets, code, grant } = await connect(WORKSPACE);
    expect(grant.refreshToken).toMatch(/^1\/\//);
    expect(grant.accessToken).toMatch(/^ya29\./);
    expect(grant.scopes).toEqual(ALL);
    expect(grant.idToken?.split(".")).toHaveLength(3);
    expect(grant.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const request = google.lastRequest();
    expect(request.endpoint).toBe("token");
    expect(request.method).toBe("POST");
    expect(request.url.search).toBe("");
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request.form?.get("grant_type")).toBe("authorization_code");
    expect(request.form?.get("code")).toBe(code);
    expect(request.form?.get("code_verifier")).toBe(secrets.codeVerifier);
    expect(request.form?.get("client_secret")).toBe(google.client.clientSecret);
    expect(request.url.href).not.toContain(code);
    expect(request.url.href).not.toContain(google.client.clientSecret);
  });

  test("a verifier that does not match the challenge is refused as invalid_grant", async () => {
    const { code } = signIn(WORKSPACE);
    const error = failed(
      await exchangeGoogleCode({
        client: google.client,
        code,
        redirectUri: REDIRECT,
        codeVerifier: deriveGoogleOAuthSecrets(KEY, "another-state").codeVerifier,
      }),
    );
    expect(error.code).toBe("unauthorised");
    expect(error.reason).toBe("invalid_grant");
  });

  test("no refresh token comes back as null, with what the callback needs to refuse it and still undo the grant", async () => {
    // An earlier grant of the same account, so the revocation has something to end.
    const earlier = (await connect(WORKSPACE)).grant.refreshToken;
    expect(google.grantOf(earlier ?? "")?.revoked).toBe(false);

    const { secrets, grant } = await connect(WORKSPACE, { withholdRefreshToken: true });
    expect(grant.refreshToken).toBeNull();
    expect(grant.accessToken).toMatch(/^ya29\./);
    // The ID token still says which account was granted, which the
    // callback's "revoke only if unused" check is keyed by.
    expect(grant.idToken).not.toBeNull();
    const identity = parseGoogleIdToken(grant.idToken ?? "", {
      clientId: google.client.clientId,
      nonce: secrets.nonce,
    });
    expect(identity).toMatchObject({
      ok: true,
      value: { accountRef: createHash("sha256").update(`google:${WORKSPACE}`).digest("hex") },
    });

    // The access token alone revokes, and Google's revoke ends every grant
    // that account gave the client.
    expect(await revokeGoogleToken(grant.accessToken)).toEqual({ ok: true, value: "revoked" });
    expect(google.grantOf(earlier ?? "")?.revoked).toBe(true);
  });

  test("no ID token comes back as null, with the refresh token kept for the callback to decide on", async () => {
    google.respondNext("token", {
      access_token: "ya29.synthetic-access",
      expires_in: 3599,
      refresh_token: "1//synthetic-refresh",
      scope: ALL.join(" "),
      token_type: "Bearer",
    });
    const grant = succeeded(
      await exchangeGoogleCode({
        client: google.client,
        code: "4/synthetic-code",
        redirectUri: REDIRECT,
        codeVerifier: null,
      }),
    );
    expect(grant).toMatchObject({
      refreshToken: "1//synthetic-refresh",
      accessToken: "ya29.synthetic-access",
      idToken: null,
      scopes: ALL,
    });
  });

  test("a 200 without an access token is malformed, not a grant", async () => {
    google.respondNext("token", { refresh_token: "1//synthetic-refresh", token_type: "Bearer" });
    const error = failed(
      await exchangeGoogleCode({
        client: google.client,
        code: "4/synthetic-code",
        redirectUri: REDIRECT,
        codeVerifier: null,
      }),
    );
    expect(error.code).toBe("malformed_response");
    expect(error.message).not.toContain("1//synthetic-refresh");
  });

  test("an unconfigured client is refused without a request", async () => {
    for (const client of [undefined, { clientId: google.client.clientId, clientSecret: "" }]) {
      const error = failed(
        await exchangeGoogleCode({
          client,
          code: "4/anything",
          redirectUri: REDIRECT,
          codeVerifier: null,
        }),
      );
      expect(error.code).toBe("misconfigured");
      expect(error.reason).toBe("oauth_client");
    }
    expect(google.requests).toHaveLength(0);
  });
});

describe("refresh", () => {
  test("mints an access token, with the refresh token in the form body only", async () => {
    const { refreshToken } = google.grant({ sub: WORKSPACE });
    const minted = succeeded(
      await refreshGoogleAccessToken({ client: google.client, refreshToken }),
    );
    expect(minted.accessToken).toMatch(/^ya29\./);
    expect(minted.scopes).toEqual(ALL);
    expect(minted.expiresAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);

    const request = google.lastRequest();
    expect(request.url.search).toBe("");
    expect(request.form?.get("grant_type")).toBe("refresh_token");
    expect(request.form?.get("refresh_token")).toBe(refreshToken);
    expect(request.url.href).not.toContain(refreshToken);
  });

  test("refresh classification: the grant's end, the client's fault and Google's bad day", async () => {
    setGoogleTimeouts({ refresh: 30 });
    const token = (spec: Omit<FakeGoogleFailure, "on">) => () =>
      google.failNext({ on: "token", ...spec });
    const oauthClient = "misconfigured/oauth_client";
    // What happens to the grant, then the code/reason and retryability the caller sees.
    type Row = [
      name: string,
      arrange: (refreshToken: string) => void,
      expected: string,
      retryable: boolean,
    ];
    const rows: Row[] = [
      ["revoked", (t) => google.revokeRefreshToken(t), "unauthorised/invalid_grant", false],
      [
        "admin restricted",
        () => google.restrictByAdmin(WORKSPACE),
        "unauthorised/admin_policy_enforced",
        false,
      ],
      ["events.owned dropped", (t) => google.dropScope(t, OWNED), "unauthorised/scope_lost", false],
      [
        "events.freebusy dropped",
        (t) => google.dropScope(t, FREEBUSY),
        "unauthorised/scope_lost",
        false,
      ],
      [
        "calendarlist.readonly dropped",
        (t) => google.dropScope(t, CALENDARLIST),
        "unauthorised/scope_lost",
        false,
      ],
      ["client deleted", () => google.deleteClient(), oauthClient, false],
      ["invalid_client", token({ status: 401, reason: "invalid_client" }), oauthClient, false],
      [
        "unauthorized_client",
        token({ status: 400, reason: "unauthorized_client" }),
        oauthClient,
        false,
      ],
      ["a 401 with no word", token({ status: 401, body: {} }), oauthClient, false],
      ["server error", token({ status: 503 }), "unavailable/server_error", true],
      ["rate limited", token({ status: 429, retryAfter: 7 }), "rate_limited/server_error", true],
      ["hang", () => google.hangNext("token"), "unavailable/timeout", true],
      ["network", token({ network: true }), "unavailable/network", true],
    ];

    for (const [name, arrange, expected, retryable] of rows) {
      google = fakeGoogleCalendar();
      google.addAccount({
        sub: WORKSPACE,
        email: "bookings@practice.example",
        hd: "practice.example",
      });
      setGoogleFetch(google.fetch);
      const { refreshToken } = google.grant({ sub: WORKSPACE });
      arrange(refreshToken);

      const error = failed(await refreshGoogleAccessToken({ client: google.client, refreshToken }));
      expect({ name, got: `${error.code}/${error.reason}`, retryable: error.retryable }).toEqual({
        name,
        got: expected,
        retryable,
      });
      if (name === "rate limited") expect(error.retryAfter).toBe(7);
      // Google's own sentences, and the token, never reach the message.
      expect(error.message, name).not.toMatch(
        /expired or revoked|Synthetic failure|administrator|was deleted/,
      );
      expect(error.message, name).not.toContain(refreshToken);
    }
  });

  test("a lost email scope is not a lost calendar, and a response with no scope field is not read as a loss", async () => {
    const { refreshToken } = google.grant({ sub: WORKSPACE });
    google.dropScope(refreshToken, EMAIL);
    expect((await refreshGoogleAccessToken({ client: google.client, refreshToken })).ok).toBe(true);

    google.respondNext("token", {
      access_token: "ya29.synthetic",
      expires_in: 3599,
      token_type: "Bearer",
    });
    const minted = succeeded(
      await refreshGoogleAccessToken({ client: google.client, refreshToken }),
    );
    expect(minted.scopes).toEqual([]);
  });

  test("a scope field that is present is evidence: empty, or short of a calendar scope, is scope_lost", async () => {
    const { refreshToken } = google.grant({ sub: WORKSPACE });
    for (const scope of [
      "",
      [OPENID, EMAIL, FREEBUSY, OWNED].join(" "),
      [OPENID, CALENDARLIST, OWNED].join(" "),
    ]) {
      google.respondNext("token", {
        access_token: "ya29.synthetic",
        expires_in: 3599,
        scope,
        token_type: "Bearer",
      });
      const error = failed(await refreshGoogleAccessToken({ client: google.client, refreshToken }));
      expect({ scope, code: error.code, reason: error.reason }).toEqual({
        scope,
        code: "unauthorised",
        reason: "scope_lost",
      });
    }

    // A scope field Google could not have meant is unreadable, not a loss.
    google.respondNext("token", {
      access_token: "ya29.synthetic",
      expires_in: 3599,
      scope: [OWNED],
    });
    expect(
      failed(await refreshGoogleAccessToken({ client: google.client, refreshToken })).code,
    ).toBe("malformed_response");
  });

  test("no client, or no refresh token, is refused without a request", async () => {
    expect(
      failed(await refreshGoogleAccessToken({ client: undefined, refreshToken: "1//x" })).reason,
    ).toBe("oauth_client");
    expect(
      failed(await refreshGoogleAccessToken({ client: google.client, refreshToken: "" })).reason,
    ).toBe("missing_refresh_token");
    expect(google.requests).toHaveLength(0);
  });
});

describe("revoke", () => {
  test("revokes with the token in the form body; 200 and 400 are both done", async () => {
    const { refreshToken } = google.grant({ sub: WORKSPACE });
    expect(await revokeGoogleToken(refreshToken)).toEqual({ ok: true, value: "revoked" });
    expect(google.grantOf(refreshToken)?.revoked).toBe(true);

    const request = google.lastRequest();
    expect(request.endpoint).toBe("revoke");
    expect(request.url.search).toBe("");
    expect(request.form?.get("token")).toBe(refreshToken);
    expect(request.url.href).not.toContain(refreshToken);

    expect(await revokeGoogleToken(refreshToken)).toEqual({ ok: true, value: "already_invalid" });
  });

  test("ends every grant that Google user gave the client, which is why the app keys revocation by subject", async () => {
    const first = google.grant({ sub: WORKSPACE }).refreshToken;
    const second = google.grant({ sub: WORKSPACE }).refreshToken;
    const someoneElse = google.grant({ sub: CONSUMER }).refreshToken;
    await revokeGoogleToken(first);
    expect(google.grantOf(second)?.revoked).toBe(true);
    expect(google.grantOf(someoneElse)?.revoked).toBe(false);
  });

  test("a transient failure is retried once, and only once", async () => {
    setGoogleTimeouts({ revoke: 30 });
    const { refreshToken } = google.grant({ sub: WORKSPACE });
    google.failNext({ on: "revoke", status: 503 });
    expect(await revokeGoogleToken(refreshToken)).toEqual({ ok: true, value: "revoked" });
    expect(google.revokeCalls).toBe(2);

    google.clearRequests();
    const other = google.grant({ sub: CONSUMER }).refreshToken;
    google.hangNext("revoke", 2);
    expect(failed(await revokeGoogleToken(other)).reason).toBe("timeout");
    expect(google.revokeCalls).toBe(2);

    google.clearRequests();
    google.failNext({ on: "revoke", status: 401, reason: "invalid_client" });
    expect(failed(await revokeGoogleToken(other)).reason).toBe("oauth_client");
    expect(google.revokeCalls).toBe(1);
  });
});

describe("grantedCalendarScopes", () => {
  test("compares full URLs, case and all, and infers nothing from a scope healdesk never asked for", () => {
    expect(grantedCalendarScopes(ALL.join(" "))).toEqual({
      granted: ALL,
      missing: [],
      complete: true,
      email: true,
    });

    const shortForms = grantedCalendarScopes(
      "openid calendar.calendarlist.readonly calendar.events.freebusy calendar.events.owned",
    );
    expect(shortForms.complete).toBe(false);
    expect(shortForms.missing).toEqual([CALENDARLIST, FREEBUSY, OWNED]);

    expect(
      grantedCalendarScopes(`${CALENDARLIST} ${FREEBUSY.toUpperCase()} ${OWNED}`).missing,
    ).toEqual([FREEBUSY]);
    expect(grantedCalendarScopes("https://www.googleapis.com/auth/calendar").complete).toBe(false);

    const noEmail = grantedCalendarScopes([OPENID, CALENDARLIST, FREEBUSY, OWNED]);
    expect(noEmail.complete).toBe(true);
    expect(noEmail.email).toBe(false);

    expect(grantedCalendarScopes(undefined)).toEqual({
      granted: [],
      missing: [CALENDARLIST, FREEBUSY, OWNED],
      complete: false,
      email: false,
    });
  });

  test("a person who unticks a calendar permission at Google gets a grant the check refuses", async () => {
    const { grant } = await connect(WORKSPACE, { scopes: [OPENID, EMAIL, CALENDARLIST, FREEBUSY] });
    expect(grantedCalendarScopes(grant.scopes)).toMatchObject({
      complete: false,
      missing: [OWNED],
    });

    const twoUnticked = await connect(WORKSPACE, { scopes: [OPENID, EMAIL, FREEBUSY] });
    expect(grantedCalendarScopes(twoUnticked.grant.scopes)).toMatchObject({
      complete: false,
      missing: [CALENDARLIST, OWNED],
    });
  });

  test("unticking only the calendar list is an incomplete grant too", async () => {
    const { grant } = await connect(WORKSPACE, { scopes: [OPENID, EMAIL, FREEBUSY, OWNED] });
    expect(grantedCalendarScopes(grant.scopes)).toEqual({
      granted: [OPENID, EMAIL, FREEBUSY, OWNED],
      missing: [CALENDARLIST],
      complete: false,
      email: true,
    });
  });
});

describe("the ID token", () => {
  const NOW = new Date("2026-10-06T12:00:00Z");
  const nowSeconds = NOW.getTime() / 1000;
  const CLIENT = "client-123.apps.googleusercontent.com";
  const NONCE = deriveGoogleOAuthSecrets(KEY, STATE).nonce;
  const SUB = "109876543210987654321";
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: SUB,
    email: "bookings@practice.example",
    email_verified: true,
    hd: "practice.example",
    nonce: NONCE,
    iat: nowSeconds - 10,
    exp: nowSeconds + 3590,
    ...over,
  });
  const parse = (over: Record<string, unknown> = {}) =>
    parseGoogleIdToken(fakeGoogleIdToken(claims(over)), {
      clientId: CLIENT,
      nonce: NONCE,
      now: NOW,
    });

  test("keeps a hash of the subject, the verified email and the account kind, and never the raw subject", () => {
    const identity = parse();
    expect(identity).toEqual({
      ok: true,
      value: {
        accountRef: createHash("sha256").update(`google:${SUB}`).digest("hex"),
        email: "bookings@practice.example",
        managed: true,
        hostedDomain: "practice.example",
      },
    });
    expect(JSON.stringify(identity)).not.toContain(SUB);
    expect(parse({ iss: "accounts.google.com" }).ok).toBe(true);
  });

  test("hd decides only managed or personal; an unverified email is not kept", () => {
    expect(parse({ hd: undefined })).toMatchObject({
      ok: true,
      value: { managed: false, hostedDomain: null },
    });
    expect(parse({ email_verified: false })).toMatchObject({ ok: true, value: { email: null } });
    expect(parse({ email: undefined, email_verified: undefined })).toMatchObject({
      ok: true,
      value: { email: null },
    });
  });

  test("the claim checks: issuer, audience, expiry with 60 s of skew, issue time within 300 s, nonce, subject", () => {
    expect(failed(parse({ iss: "https://accounts.example.com" })).reason).toBe("id_token_issuer");
    expect(failed(parse({ aud: "someone-else.apps.googleusercontent.com" })).reason).toBe(
      "id_token_audience",
    );
    expect(failed(parse({ aud: [CLIENT] })).reason).toBe("id_token_audience");
    expect(failed(parse({ exp: nowSeconds - 61 })).reason).toBe("id_token_expired");
    expect(parse({ exp: nowSeconds - 59 }).ok).toBe(true);
    expect(failed(parse({ iat: nowSeconds + 301 })).reason).toBe("id_token_issued_ahead");
    expect(parse({ iat: nowSeconds + 299 }).ok).toBe(true);
    expect(
      failed(parse({ nonce: deriveGoogleOAuthSecrets(KEY, "another-state").nonce })).reason,
    ).toBe("id_token_nonce");
    expect(failed(parse({ nonce: undefined })).reason).toBe("id_token_nonce");
    expect(failed(parse({ sub: "" })).reason).toBe("id_token_subject");
    for (const error of [failed(parse({ iss: "nope" })), failed(parse({ sub: "" }))]) {
      expect(error.code).toBe("unauthorised");
      expect(error.retryable).toBe(false);
    }
  });

  test("an expected nonce shorter than 22 characters matches nothing, an empty one above all", () => {
    const withNonce = (nonce: string) =>
      parseGoogleIdToken(fakeGoogleIdToken(claims({ nonce })), {
        clientId: CLIENT,
        nonce,
        now: NOW,
      });
    expect(failed(withNonce("")).reason).toBe("id_token_nonce");
    expect(failed(withNonce("a".repeat(21))).reason).toBe("id_token_nonce");
    expect(withNonce("a".repeat(22)).ok).toBe(true);
  });

  test("something that is not a JWT is malformed, not a crash", () => {
    for (const token of [
      "",
      "not-a-jwt",
      "a.b",
      "a.%%%.c",
      `x.${Buffer.from("[1]").toString("base64url")}.y`,
    ]) {
      const error = failed(parseGoogleIdToken(token, { clientId: CLIENT, nonce: NONCE, now: NOW }));
      expect(error.code).toBe("malformed_response");
      expect(error.reason).toBe("id_token_malformed");
    }
  });

  test("the exchange's own ID token reads back: the nonce from the derivation, the kind from hd", async () => {
    const workspace = await connect(WORKSPACE);
    expect(
      parseGoogleIdToken(workspace.grant.idToken ?? "", {
        clientId: google.client.clientId,
        nonce: workspace.secrets.nonce,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        managed: true,
        hostedDomain: "practice.example",
        email: "bookings@practice.example",
      },
    });

    // A personal account that also refused the email scope: no hd, and no email.
    const personal = await connect(CONSUMER, { scopes: [OPENID, CALENDARLIST, FREEBUSY, OWNED] });
    expect(
      parseGoogleIdToken(personal.grant.idToken ?? "", {
        clientId: google.client.clientId,
        nonce: personal.secrets.nonce,
      }),
    ).toMatchObject({ ok: true, value: { managed: false, hostedDomain: null, email: null } });
  });
});
