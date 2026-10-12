import { createHash, randomBytes } from "node:crypto";

import { GOOGLE_SCOPES } from "./oauth";

/**
 * An in-memory Google, for this package's tests and apps/app's: the OAuth
 * endpoints (consent, token, revoke) and the six Calendar endpoints the
 * adapter uses (calendarList, freeBusy, and events insert, get, list and
 * delete).
 *
 * Shapes follow Google's reference pages for calendarList.list,
 * freeBusy.query and events.insert/get/list/delete, and the OAuth 2.0
 * web-server flow. Each Calendar endpoint accepts exactly the scopes its
 * reference page lists, so a grant that lost `calendar.events.owned` cannot
 * insert here either, and freeBusy refuses `calendar.events.owned` alone, as
 * Google does. A `fields` mask is applied as Google applies one, so the
 * adapter sees only what it asked for. Revoking one token ends every grant
 * that Google user gave the client, as Google's revoke does, which is why
 * apps/app keys revocation by the Google subject.
 *
 * Each account has a calendar list: its primary calendar, plus any added
 * with `addCalendar`, each with the account's role on it. Writing under
 * `calendar.events.owned` alone is refused on a calendar the account does not
 * own. The exact reason word Google gives for that is unverified, and does
 * not matter: the adapter reads every 403 that is not a rate limit or a
 * disabled API as the same definitive refusal.
 *
 * Every request is logged before it is answered, so a test can assert on the
 * wire: which endpoint, how often, and that a token travelled in a form body
 * and never in a URL. Install it with `setGoogleFetch(fake.fetch)`.
 *
 * It is not Google. It is the narrowest thing that lets the adapter, the
 * connect flow and the watch run without a live call; when Google's
 * documented behaviour moves, this file moves with it. Everything in it is
 * synthetic: the client secret is a placeholder and every token is random.
 */

/** The client the fake knows unless told otherwise. A placeholder, not a credential. */
export const FAKE_GOOGLE_CLIENT = Object.freeze({
  clientId: "fake-client-id.apps.googleusercontent.com",
  clientSecret: "fake-client-secret",
});

export type FakeGoogleEndpoint =
  "token" | "revoke" | "calendarList" | "freeBusy" | "insert" | "get" | "list" | "delete";

export type FakeGoogleRequest = {
  endpoint: FakeGoogleEndpoint | "unknown";
  method: string;
  url: URL;
  headers: Headers;
  /** The body exactly as sent, so a test can assert what did and did not travel. */
  body: string | undefined;
  /** The form fields, for the token and revoke endpoints. */
  form: URLSearchParams | undefined;
  /** The JSON body, for freeBusy and insert. */
  json: unknown;
};

export type FakeGoogleEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** ISO instants. */
  start: string;
  end: string;
  transparency: "opaque" | "transparent";
  /** extendedProperties.private as stored. */
  privateProperties: Record<string, string>;
  /** The whole body a client inserted, as sent. Absent on an event the clinic made itself. */
  inserted?: Record<string, unknown>;
};

/** The account's roles, weakest first, as calendarList's minAccessRole orders them. */
export const FAKE_GOOGLE_ROLES = [
  "freeBusyReader",
  "reader",
  "writerWithoutPrivateAccess",
  "writer",
  "owner",
] as const;
export type FakeGoogleRole = (typeof FAKE_GOOGLE_ROLES)[number];

export type FakeGoogleAccountInput = {
  /** Google's subject id. */
  sub: string;
  email?: string;
  /** Default true. */
  emailVerified?: boolean;
  /** Set for a Workspace or Cloud Identity account; absent for a consumer one. */
  hd?: string;
  /** The primary calendar's zone. Default America/New_York. */
  timeZone?: string;
};

export type FakeGoogleCalendarInput = {
  /** Default: a generated group-calendar id. */
  id?: string;
  /** The calendar's name. */
  summary: string;
  /** The account's role on it. Default owner. */
  accessRole?: FakeGoogleRole;
  /** Default America/New_York. */
  timeZone?: string;
  /** Hidden from the calendar list unless showHidden is asked for. */
  hidden?: boolean;
  /**
   * The Workspace domain the calendar belongs to, which is what
   * calendarList's showOwnOrganizationOnly filters on: by default the
   * account's own (its `hd`, or none for a consumer account); another
   * domain for a calendar shared in from another organisation; null for one
   * a consumer account shares in.
   */
  organization?: string | null;
};

/**
 * A canned answer for the next matching request, instead of routing it.
 * With a 2xx status and a body it stands in for a success Google might give.
 */
export type FakeGoogleFailure = {
  /** The endpoint it applies to; the next request of any kind when omitted. */
  on?: FakeGoogleEndpoint;
  /** Default 500, or 200 with `calendarError`. */
  status?: number;
  /** The API error's errors[0].reason, or the token endpoint's `error` word. */
  reason?: string;
  /** An exact JSON body instead of the generated one. */
  body?: unknown;
  /** An exact raw body, JSON or not, instead of the generated one. */
  rawBody?: string;
  /** freeBusy only: answer 200 with this per-calendar error (notFound, internalError). */
  calendarError?: string;
  /** Seconds, sent as Retry-After. */
  retryAfter?: number;
  /** Throw as a DNS or TLS failure would, instead of answering. */
  network?: boolean;
  /** How many matching requests it applies to. Default 1. */
  times?: number;
};

export type FakeGoogleGrant = { sub: string; clientId: string; scopes: string[]; revoked: boolean };

type Calendar = {
  id: string;
  summary: string;
  primary: boolean;
  timeZone: string;
  accessRole: FakeGoogleRole;
  hidden: boolean;
  organization: string | null;
  events: Map<string, FakeGoogleEvent>;
  busy: Array<{ start: number; end: number }>;
};

type Account = {
  sub: string;
  email: string | undefined;
  emailVerified: boolean;
  hd: string | undefined;
  restricted: boolean;
  primary: Calendar;
  /** The account's calendar list, in the order calendars were added, keyed by id. */
  calendars: Map<string, Calendar>;
};

type Grant = FakeGoogleGrant & { refreshToken: string };
type AccessToken = {
  sub: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  refreshToken: string | null;
};
type Code = {
  sub: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  nonce: string | null;
  challenge: string | null;
  used: boolean;
  withholdRefreshToken: boolean;
};

const SCOPE = "https://www.googleapis.com/auth/";
const EMAIL_SCOPES = new Set(["email", `${SCOPE}userinfo.email`]);
/** calendarList.list's reference page. */
const CALENDAR_LIST_SCOPES = [
  "calendar.readonly",
  "calendar",
  "calendar.calendarlist",
  "calendar.calendarlist.readonly",
].map((s) => SCOPE + s);
/** freeBusy.query's reference page. */
const FREEBUSY_SCOPES = [
  "calendar.readonly",
  "calendar",
  "calendar.events.freebusy",
  "calendar.freebusy",
].map((s) => SCOPE + s);
/** events.get and events.list list the same scopes. */
const READ_SCOPES = [
  "calendar.readonly",
  "calendar",
  "calendar.events.readonly",
  "calendar.events",
  "calendar.app.created",
  "calendar.events.freebusy",
  "calendar.events.owned",
  "calendar.events.owned.readonly",
  "calendar.events.public.readonly",
].map((s) => SCOPE + s);
/** events.insert and events.delete list the same scopes. */
const WRITE_SCOPES = [
  "calendar",
  "calendar.events",
  "calendar.app.created",
  "calendar.events.owned",
].map((s) => SCOPE + s);
/** The write scopes that reach a calendar the account can write to but does not own. */
const WRITE_ANY_SCOPES = new Set(["calendar", "calendar.events"].map((s) => SCOPE + s));

const ACCESS_TOKEN_SECONDS = 3599;
const SYNTHETIC_MESSAGE = "Synthetic failure from the fake Google";

/** An unsigned ID token with the given claims, shaped as Google's. The adapter never checks the signature. */
export function fakeGoogleIdToken(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${segment({ alg: "RS256", kid: "fake", typ: "JWT" })}.${segment(claims)}.${Buffer.from("fake-signature").toString("base64url")}`;
}

export function fakeGoogleCalendar(
  options: { client?: { clientId: string; clientSecret: string } } = {},
) {
  const client = options.client ?? FAKE_GOOGLE_CLIENT;
  const clients = new Map<string, { secret: string; deleted: boolean }>([
    [client.clientId, { secret: client.clientSecret, deleted: false }],
  ]);
  const accounts = new Map<string, Account>();
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, AccessToken>();
  const codes = new Map<string, Code>();
  const requests: FakeGoogleRequest[] = [];
  const canned: Array<FakeGoogleFailure & { remaining: number }> = [];
  const hangs: Array<{ on: FakeGoogleEndpoint | undefined; remaining: number }> = [];
  let insertHang: { mode: "now" | "later"; armed: boolean; pending: (() => void) | null } | null =
    null;

  function accountOf(sub: string): Account {
    const account = accounts.get(sub);
    if (!account) throw new Error(`fakeGoogleCalendar: no account "${sub}"; addAccount it first.`);
    return account;
  }

  /** A calendar on the account's list: "primary", the primary's own id in any case, or another id exactly. */
  function calendarFor(account: Account, calendarId: string): Calendar | undefined {
    if (calendarId === "primary" || calendarId.toLowerCase() === account.primary.id.toLowerCase()) {
      return account.primary;
    }
    return account.calendars.get(calendarId);
  }

  function calendarOf(sub: string, calendarId: string): Calendar {
    const calendar = calendarFor(accountOf(sub), calendarId);
    if (!calendar) throw new Error(`fakeGoogleCalendar: "${sub}" has no calendar "${calendarId}".`);
    return calendar;
  }

  function issueAccessToken(
    sub: string,
    clientId: string,
    scopes: string[],
    refreshToken: string | null,
  ): string {
    const token = mint("ya29.fake-");
    accessTokens.set(token, {
      sub,
      clientId,
      scopes: [...scopes],
      expiresAt: Date.now() + ACCESS_TOKEN_SECONDS * 1000,
      refreshToken,
    });
    return token;
  }

  /** Google's revoke, and a person removing healdesk in their Google Account: every grant that user gave the client ends. */
  function revokeAllFor(sub: string, clientId: string): void {
    for (const grant of grants.values()) {
      if (grant.sub === sub && grant.clientId === clientId) grant.revoked = true;
    }
    for (const [token, record] of accessTokens) {
      if (record.sub === sub && record.clientId === clientId) accessTokens.delete(token);
    }
  }

  function idTokenFor(account: Account, clientId: string, code: Code): string {
    const now = Math.floor(Date.now() / 1000);
    const withEmail =
      account.email !== undefined && code.scopes.some((scope) => EMAIL_SCOPES.has(scope));
    return fakeGoogleIdToken({
      iss: "https://accounts.google.com",
      azp: clientId,
      aud: clientId,
      sub: account.sub,
      ...(withEmail ? { email: account.email, email_verified: account.emailVerified } : {}),
      ...(account.hd !== undefined ? { hd: account.hd } : {}),
      ...(code.nonce !== null ? { nonce: code.nonce } : {}),
      iat: now,
      exp: now + 3600,
    });
  }

  // ---- OAuth endpoints -------------------------------------------------------

  function tokenEndpoint(form: URLSearchParams): Response {
    const clientId = form.get("client_id") ?? "";
    const known = clients.get(clientId);
    if (known?.deleted) return tokenError(401, "deleted_client", "The OAuth client was deleted.");
    if (!known || form.get("client_secret") !== known.secret) {
      return tokenError(401, "invalid_client", "Unauthorized");
    }

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      if (!code || code.used || code.clientId !== clientId) {
        return tokenError(400, "invalid_grant", "Malformed auth code.");
      }
      if (form.get("redirect_uri") !== code.redirectUri) {
        return tokenError(400, "redirect_uri_mismatch", "Bad Request");
      }
      if (code.challenge !== null) {
        const verifier = form.get("code_verifier");
        if (!verifier) return tokenError(400, "invalid_grant", "Missing code verifier.");
        if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge) {
          return tokenError(400, "invalid_grant", "Invalid code verifier.");
        }
      }
      code.used = true;
      const account = accountOf(code.sub);
      let refreshToken: string | null = null;
      if (!code.withholdRefreshToken) {
        refreshToken = mint("1//fake-");
        grants.set(refreshToken, {
          refreshToken,
          sub: code.sub,
          clientId,
          scopes: [...code.scopes],
          revoked: false,
        });
      }
      return jsonResponse(200, {
        access_token: issueAccessToken(code.sub, clientId, code.scopes, refreshToken),
        expires_in: ACCESS_TOKEN_SECONDS,
        ...(refreshToken !== null ? { refresh_token: refreshToken } : {}),
        scope: code.scopes.join(" "),
        token_type: "Bearer",
        id_token: idTokenFor(account, clientId, code),
      });
    }

    if (grantType === "refresh_token") {
      const grant = grants.get(form.get("refresh_token") ?? "");
      if (!grant || grant.revoked) {
        return tokenError(400, "invalid_grant", "Token has been expired or revoked.");
      }
      if (grant.clientId !== clientId) {
        return tokenError(400, "unauthorized_client", "Unauthorized");
      }
      if (accountOf(grant.sub).restricted) {
        return tokenError(
          400,
          "admin_policy_enforced",
          "The administrator restricted access to this app.",
        );
      }
      return jsonResponse(200, {
        access_token: issueAccessToken(grant.sub, clientId, grant.scopes, grant.refreshToken),
        expires_in: ACCESS_TOKEN_SECONDS,
        scope: grant.scopes.join(" "),
        token_type: "Bearer",
      });
    }

    return tokenError(400, "unsupported_grant_type", "Invalid grant_type");
  }

  function revokeEndpoint(form: URLSearchParams): Response {
    const token = form.get("token") ?? "";
    const grant = grants.get(token);
    const access = accessTokens.get(token);
    const owner = grant && !grant.revoked ? grant : access;
    if (!owner) return tokenError(400, "invalid_token", "Token expired or revoked");
    revokeAllFor(owner.sub, owner.clientId);
    return jsonResponse(200, {});
  }

  // ---- Calendar endpoints ----------------------------------------------------

  function authorise(
    headers: Headers,
    allowed: readonly string[],
  ): { account: Account; scopes: string[] } | Response {
    const auth = headers.get("authorization") ?? "";
    const token = accessTokens.get(auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "");
    if (!token || token.expiresAt <= Date.now()) {
      return apiError(401, "authError", "Invalid Credentials");
    }
    if (!token.scopes.some((scope) => allowed.includes(scope))) {
      return apiError(
        403,
        "insufficientPermissions",
        "Request had insufficient authentication scopes.",
      );
    }
    return { account: accountOf(token.sub), scopes: token.scopes };
  }

  /** The role and scope a write needs: owner, or writer with a scope that reaches calendars the account does not own. */
  function writeRefusal(calendar: Calendar, scopes: readonly string[]): Response | null {
    if (calendar.accessRole === "owner") return null;
    if (calendar.accessRole !== "writer" && calendar.accessRole !== "writerWithoutPrivateAccess") {
      return apiError(
        403,
        "requiredAccessLevel",
        "You need to have writer access to this calendar.",
      );
    }
    if (!scopes.some((scope) => WRITE_ANY_SCOPES.has(scope))) {
      return apiError(403, "forbidden", "Forbidden");
    }
    return null;
  }

  function calendarListEndpoint(headers: Headers, query: URLSearchParams): Response {
    const auth = authorise(headers, CALENDAR_LIST_SCOPES);
    if (auth instanceof Response) return auth;

    const minRole = query.get("minAccessRole");
    const floor = minRole === null ? 0 : FAKE_GOOGLE_ROLES.indexOf(minRole as FakeGoogleRole);
    if (floor < 0) return apiError(400, "invalidParameter", "Invalid value for: minAccessRole");
    const showHidden = query.get("showHidden") === "true";
    // Google applies showOwnOrganizationOnly to Workspace users only.
    const ownOrganization =
      query.get("showOwnOrganizationOnly") === "true" && auth.account.hd !== undefined
        ? auth.account.hd
        : undefined;
    const requested = Number(query.get("maxResults") ?? 100);
    const pageSize = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 250) : 100;
    const offset = Number(query.get("pageToken") ?? 0);
    if (!Number.isInteger(offset) || offset < 0) {
      return apiError(400, "invalid", "Invalid page token.");
    }

    const entries = [...auth.account.calendars.values()]
      .filter((calendar) => FAKE_GOOGLE_ROLES.indexOf(calendar.accessRole) >= floor)
      .filter((calendar) => showHidden || !calendar.hidden)
      .filter(
        (calendar) => ownOrganization === undefined || calendar.organization === ownOrganization,
      );
    const page = entries.slice(offset, offset + pageSize);
    const next = offset + pageSize < entries.length ? String(offset + pageSize) : undefined;
    return masked(query, {
      kind: "calendar#calendarList",
      etag: '"fake"',
      ...(next !== undefined ? { nextPageToken: next } : { nextSyncToken: "fake-sync" }),
      items: page.map((calendar) => ({
        kind: "calendar#calendarListEntry",
        etag: '"fake"',
        id: calendar.id,
        summary: calendar.summary,
        timeZone: calendar.timeZone,
        colorId: "1",
        backgroundColor: "#9fe1e7",
        foregroundColor: "#000000",
        selected: true,
        accessRole: calendar.accessRole,
        defaultReminders: [],
        ...(calendar.primary ? { primary: true } : {}),
        ...(calendar.hidden ? { hidden: true } : {}),
      })),
    });
  }

  function busyOf(
    calendar: Calendar,
    from: number,
    to: number,
  ): Array<{ start: string; end: string }> {
    const blocks = [
      ...calendar.busy,
      ...[...calendar.events.values()]
        .filter((event) => event.status !== "cancelled" && event.transparency === "opaque")
        .map((event) => ({ start: Date.parse(event.start), end: Date.parse(event.end) })),
    ]
      .map((block) => ({ start: Math.max(block.start, from), end: Math.min(block.end, to) }))
      .filter((block) => block.end > block.start)
      .sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const block of blocks) {
      const last = merged[merged.length - 1];
      if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
      else merged.push({ ...block });
    }
    return merged.map((block) => ({ start: iso(block.start), end: iso(block.end) }));
  }

  function freeBusyEndpoint(headers: Headers, body: unknown): Response {
    const auth = authorise(headers, FREEBUSY_SCOPES);
    if (auth instanceof Response) return auth;
    const query = isRecord(body) ? body : undefined;
    const from = parseTime(query?.timeMin);
    const to = parseTime(query?.timeMax);
    if (from === undefined || to === undefined || !Array.isArray(query?.items)) {
      return apiError(400, "badRequest", "Bad Request");
    }
    if (to < from) return apiError(400, "timeRangeEmpty", "The specified time range is empty.");

    const calendars: Record<string, unknown> = {};
    for (const item of query.items) {
      const id = isRecord(item) && typeof item.id === "string" ? item.id : "";
      const target = calendarFor(auth.account, id);
      calendars[id] = target
        ? { busy: busyOf(target, from, to) }
        : { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
    }
    return jsonResponse(200, {
      kind: "calendar#freeBusy",
      timeMin: iso(from),
      timeMax: iso(to),
      calendars,
    });
  }

  function insertEndpoint(
    headers: Headers,
    calendarId: string,
    body: unknown,
    signal: AbortSignal | null | undefined,
  ): Response | Promise<Response> {
    const auth = authorise(headers, WRITE_SCOPES);
    if (auth instanceof Response) return auth;
    const calendar = calendarFor(auth.account, calendarId);
    if (!calendar) return apiError(404, "notFound", "Not Found");
    const refusal = writeRefusal(calendar, auth.scopes);
    if (refusal) return refusal;
    if (!isRecord(body)) return apiError(400, "badRequest", "Bad Request");

    const start = isRecord(body.start) ? parseTime(body.start.dateTime) : undefined;
    const end = isRecord(body.end) ? parseTime(body.end.dateTime) : undefined;
    if (start === undefined || end === undefined || end <= start) {
      return apiError(400, "timeRangeEmpty", "Bad Request");
    }
    const id = body.id === undefined ? randomBytes(10).toString("hex") : body.id;
    if (typeof id !== "string" || !/^[a-v0-9]{5,1024}$/.test(id)) {
      return apiError(400, "invalid", "Invalid resource id value.");
    }
    if (calendar.events.has(id)) {
      return apiError(409, "duplicate", "The requested identifier already exists.");
    }

    const props =
      isRecord(body.extendedProperties) && isRecord(body.extendedProperties.private)
        ? body.extendedProperties.private
        : {};
    const event: FakeGoogleEvent = {
      id,
      status: "confirmed",
      start: iso(start),
      end: iso(end),
      transparency: body.transparency === "transparent" ? "transparent" : "opaque",
      privateProperties: Object.fromEntries(
        Object.entries(props).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      inserted: structuredClone(body),
    };

    if (insertHang?.armed) {
      const held = insertHang;
      held.armed = false;
      if (held.mode === "now") calendar.events.set(id, event);
      else {
        held.pending = () => {
          if (!calendar.events.has(id)) calendar.events.set(id, event);
        };
      }
      return hang(signal);
    }

    calendar.events.set(id, event);
    return jsonResponse(200, resourceOf(event, calendar));
  }

  function getEndpoint(
    headers: Headers,
    calendarId: string,
    eventId: string,
    query: URLSearchParams,
  ): Response {
    const auth = authorise(headers, READ_SCOPES);
    if (auth instanceof Response) return auth;
    const calendar = calendarFor(auth.account, calendarId);
    const event = calendar?.events.get(eventId);
    if (!calendar || !event) return apiError(404, "notFound", "Not Found");
    return masked(query, resourceOf(event, calendar));
  }

  function listEndpoint(headers: Headers, calendarId: string, query: URLSearchParams): Response {
    const auth = authorise(headers, READ_SCOPES);
    if (auth instanceof Response) return auth;
    const calendar = calendarFor(auth.account, calendarId);
    if (!calendar) return apiError(404, "notFound", "Not Found");

    const filters = query.getAll("privateExtendedProperty").map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    });
    const from = parseTime(query.get("timeMin"));
    const to = parseTime(query.get("timeMax"));
    const max = Number(query.get("maxResults") ?? 250);
    const items = [...calendar.events.values()]
      .filter((event) => event.status !== "cancelled")
      .filter((event) => filters.every(([key, value]) => event.privateProperties[key] === value))
      .filter((event) => from === undefined || Date.parse(event.end) > from)
      .filter((event) => to === undefined || Date.parse(event.start) < to)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, Number.isFinite(max) && max > 0 ? max : 250)
      .map((event) => resourceOf(event, calendar));

    return masked(query, {
      kind: "calendar#events",
      summary: calendar.summary,
      timeZone: calendar.timeZone,
      accessRole: calendar.accessRole,
      defaultReminders: [],
      items,
    });
  }

  function deleteEndpoint(headers: Headers, calendarId: string, eventId: string): Response {
    const auth = authorise(headers, WRITE_SCOPES);
    if (auth instanceof Response) return auth;
    const calendar = calendarFor(auth.account, calendarId);
    const event = calendar?.events.get(eventId);
    if (!calendar || !event) return apiError(404, "notFound", "Not Found");
    const refusal = writeRefusal(calendar, auth.scopes);
    if (refusal) return refusal;
    if (event.status === "cancelled") return apiError(410, "deleted", "Resource has been deleted");
    event.status = "cancelled";
    return new Response(null, { status: 204 });
  }

  // ---- The fetch -------------------------------------------------------------

  function takeCanned(endpoint: FakeGoogleRequest["endpoint"]): FakeGoogleFailure | undefined {
    const at = canned.findIndex((spec) => spec.on === undefined || spec.on === endpoint);
    if (at < 0) return undefined;
    const spec = canned[at]!;
    spec.remaining -= 1;
    if (spec.remaining <= 0) canned.splice(at, 1);
    return spec;
  }

  function takeHang(endpoint: FakeGoogleRequest["endpoint"]): boolean {
    const at = hangs.findIndex((spec) => spec.on === undefined || spec.on === endpoint);
    if (at < 0) return false;
    const spec = hangs[at]!;
    spec.remaining -= 1;
    if (spec.remaining <= 0) hangs.splice(at, 1);
    return true;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? rawBody
        : rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : undefined;
    const endpoint = routeOf(method, url);
    const form =
      endpoint === "token" || endpoint === "revoke" ? new URLSearchParams(body ?? "") : undefined;
    let json: unknown;
    if (body !== undefined && (endpoint === "freeBusy" || endpoint === "insert")) {
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
    }
    requests.push({ endpoint, method, url, headers, body, form, json });

    const answer = takeCanned(endpoint);
    if (answer?.network) throw new TypeError("fetch failed");
    if (answer) return cannedResponse(answer, endpoint, json);
    if (takeHang(endpoint)) return hang(init?.signal);

    const path = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    const calendarId = path?.[1] ? decodeURIComponent(path[1]) : "";
    const eventId = path?.[2] ? decodeURIComponent(path[2]) : "";
    switch (endpoint) {
      case "token":
        return tokenEndpoint(form ?? new URLSearchParams());
      case "revoke":
        return revokeEndpoint(form ?? new URLSearchParams());
      case "calendarList":
        return calendarListEndpoint(headers, url.searchParams);
      case "freeBusy":
        return freeBusyEndpoint(headers, json);
      case "insert":
        return insertEndpoint(headers, calendarId, json, init?.signal);
      case "get":
        return getEndpoint(headers, calendarId, eventId, url.searchParams);
      case "list":
        return listEndpoint(headers, calendarId, url.searchParams);
      case "delete":
        return deleteEndpoint(headers, calendarId, eventId);
      default:
        return new Response("Not Found", { status: 404 });
    }
  };

  const count = (endpoint: FakeGoogleEndpoint) =>
    requests.filter((request) => request.endpoint === endpoint).length;

  function newCalendar(
    input: FakeGoogleCalendarInput & { id: string; primary: boolean; organization: string | null },
  ): Calendar {
    return {
      id: input.id,
      summary: input.summary,
      primary: input.primary,
      timeZone: input.timeZone ?? "America/New_York",
      accessRole: input.accessRole ?? "owner",
      hidden: input.hidden ?? false,
      organization: input.organization,
      events: new Map(),
      busy: [],
    };
  }

  return {
    /** Install with setGoogleFetch(fake.fetch). */
    fetch: fetchImpl,
    /** The OAuth client this fake accepts; hand it to the adapter as `oauthClient`. */
    client: { clientId: client.clientId, clientSecret: client.clientSecret },
    /** Every request, oldest first. */
    requests,
    lastRequest(): FakeGoogleRequest {
      const last = requests[requests.length - 1];
      if (!last) throw new Error("fakeGoogleCalendar: no request was made");
      return last;
    },
    /** Forget the request log, so a test can assert on what happens next only. */
    clearRequests(): void {
      requests.length = 0;
    },

    get tokenCalls(): number {
      return count("token");
    },
    get calendarListCalls(): number {
      return count("calendarList");
    },
    get freeBusyCalls(): number {
      return count("freeBusy");
    },
    get insertCount(): number {
      return count("insert");
    },
    get eventsListCalls(): number {
      return count("list");
    },
    get getCalls(): number {
      return count("get");
    },
    get deleteCalls(): number {
      return count("delete");
    },
    get revokeCalls(): number {
      return count("revoke");
    },

    // ---- Accounts and grants -------------------------------------------------

    /**
     * A Google account whose calendar list holds its primary calendar, empty.
     * The primary's id is the account's email, as Google's is, or the subject
     * when it has none.
     */
    addAccount(input: FakeGoogleAccountInput): void {
      const primary = newCalendar({
        id: input.email ?? input.sub,
        summary: input.email ?? input.sub,
        primary: true,
        timeZone: input.timeZone,
        organization: input.hd ?? null,
      });
      accounts.set(input.sub, {
        sub: input.sub,
        email: input.email,
        emailVerified: input.emailVerified ?? true,
        hd: input.hd,
        restricted: false,
        primary,
        calendars: new Map([[primary.id, primary]]),
      });
    },

    /**
     * Another calendar on the account's list: one it owns, or one shared with
     * it, in the account's own organisation unless `organization` says
     * otherwise. Returns its id.
     */
    addCalendar(sub: string, input: FakeGoogleCalendarInput): string {
      const account = accountOf(sub);
      const id = input.id ?? `c_${randomBytes(12).toString("hex")}@group.calendar.fake.test`;
      if (calendarFor(account, id)) {
        throw new Error(`fakeGoogleCalendar: "${sub}" already lists "${id}".`);
      }
      const organization =
        input.organization !== undefined ? input.organization : (account.hd ?? null);
      account.calendars.set(id, newCalendar({ ...input, id, primary: false, organization }));
      return id;
    },

    /**
     * A refresh token for the account, as if it had consented and the code had
     * been exchanged: for seeding a stored connection without the browser leg.
     * Default scopes are the five healdesk asks for.
     */
    grant(input: { sub: string; scopes?: readonly string[]; clientId?: string }): {
      refreshToken: string;
    } {
      accountOf(input.sub);
      const refreshToken = mint("1//fake-");
      grants.set(refreshToken, {
        refreshToken,
        sub: input.sub,
        clientId: input.clientId ?? client.clientId,
        scopes: [...(input.scopes ?? GOOGLE_SCOPES)],
        revoked: false,
      });
      return { refreshToken };
    },

    /**
     * The browser leg: the person at Google's consent screen picks `sub` and
     * agrees (or not). Reads the consent URL as Google would and answers what
     * Google would redirect back with: a code, or an error word. `scopes`
     * overrides what was granted, as granular consent lets a person untick
     * one; `withholdRefreshToken` makes the exchange answer without one.
     */
    authorize(
      authUrl: string | URL,
      consent: {
        sub: string;
        scopes?: readonly string[];
        decline?: boolean;
        withholdRefreshToken?: boolean;
      },
    ):
      | { code: string; state: string | null; redirectUri: string }
      | { error: string; state: string | null } {
      const query = new URL(authUrl).searchParams;
      const state = query.get("state");
      const known = clients.get(query.get("client_id") ?? "");
      if (!known) return { error: "invalid_client", state };
      if (known.deleted) return { error: "deleted_client", state };
      const redirectUri = query.get("redirect_uri");
      if (!redirectUri) return { error: "redirect_uri_mismatch", state };
      if (query.get("response_type") !== "code") {
        return { error: "unsupported_response_type", state };
      }
      const account = accountOf(consent.sub);
      if (consent.decline) return { error: "access_denied", state };
      if (account.restricted) return { error: "admin_policy_enforced", state };
      const challenge = query.get("code_challenge");
      if (challenge !== null && query.get("code_challenge_method") !== "S256") {
        return { error: "invalid_request", state };
      }

      const code = mint("4/fake-");
      codes.set(code, {
        sub: account.sub,
        clientId: query.get("client_id") ?? "",
        redirectUri,
        scopes: [...(consent.scopes ?? (query.get("scope") ?? "").split(" ").filter(Boolean))],
        nonce: query.get("nonce"),
        challenge,
        used: false,
        withholdRefreshToken: consent.withholdRefreshToken ?? false,
      });
      return { code, state, redirectUri };
    },

    /** A grant's state, for asserting a revocation or a lost scope. */
    grantOf(refreshToken: string): FakeGoogleGrant | undefined {
      const grant = grants.get(refreshToken);
      return grant
        ? {
            sub: grant.sub,
            clientId: grant.clientId,
            scopes: [...grant.scopes],
            revoked: grant.revoked,
          }
        : undefined;
    },

    // ---- Calendars -----------------------------------------------------------

    /** Every event in one of the account's calendars, cancelled ones included, oldest first. */
    events(sub: string, calendarId = "primary"): FakeGoogleEvent[] {
      return [...calendarOf(sub, calendarId).events.values()].sort(
        (a, b) => Date.parse(a.start) - Date.parse(b.start),
      );
    },
    event(sub: string, id: string, calendarId = "primary"): FakeGoogleEvent | undefined {
      return calendarOf(sub, calendarId).events.get(id);
    },
    /** Time the calendar shows busy without an event healdesk could read: the clinic's own bookings. */
    addBusy(sub: string, start: Date, end: Date, calendarId = "primary"): void {
      calendarOf(sub, calendarId).busy.push({ start: start.getTime(), end: end.getTime() });
    },
    /** An event the clinic made itself, which healdesk must never touch. */
    addEvent(
      sub: string,
      input: {
        start: Date;
        end: Date;
        id?: string;
        calendarId?: string;
        transparency?: "opaque" | "transparent";
        privateProperties?: Record<string, string>;
      },
    ): FakeGoogleEvent {
      const event: FakeGoogleEvent = {
        id: input.id ?? randomBytes(10).toString("hex"),
        status: "confirmed",
        start: iso(input.start.getTime()),
        end: iso(input.end.getTime()),
        transparency: input.transparency ?? "opaque",
        privateProperties: { ...input.privateProperties },
      };
      calendarOf(sub, input.calendarId ?? "primary").events.set(event.id, event);
      return event;
    },
    /** The clinic deletes an event in Google Calendar: it stays, cancelled, as Google keeps it in the trash. */
    deleteEventAsClinic(sub: string, id: string, calendarId = "primary"): void {
      const event = calendarOf(sub, calendarId).events.get(id);
      if (!event) throw new Error(`fakeGoogleCalendar: no event "${id}" for "${sub}".`);
      event.status = "cancelled";
    },
    /** The account's role on one of its calendars changes, as when the calendar is reshared. */
    setAccessRole(sub: string, accessRole: FakeGoogleRole, calendarId = "primary"): void {
      calendarOf(sub, calendarId).accessRole = accessRole;
    },
    /** The organisation a calendar belongs to changes, as when another domain takes it over. */
    setOrganization(sub: string, organization: string | null, calendarId = "primary"): void {
      calendarOf(sub, calendarId).organization = organization;
    },

    // ---- Switches ------------------------------------------------------------

    /** The next matching request (or `times` of them) gets this answer instead of being routed. */
    failNext(spec: FakeGoogleFailure): void {
      canned.push({ ...spec, remaining: spec.times ?? 1 });
    },
    /** The next matching request gets this success instead of being routed: for shapes the fake never makes itself. */
    respondNext(on: FakeGoogleEndpoint, body: unknown, status = 200): void {
      canned.push({ on, status, body, remaining: 1 });
    },
    /** The next matching request (or `times` of them) never answers until its signal aborts. */
    hangNext(on?: FakeGoogleEndpoint, times = 1): void {
      hangs.push({ on, remaining: times });
    },
    /**
     * The next insert hangs until the caller gives up. With `land: "now"`
     * (the default) the event is stored before the hang, as a write that
     * happened but whose reply was lost. With `land: "later"` it is stored
     * only when `land()` is called, as an insert Google completes after the
     * caller has moved on; if that id was written meanwhile, nothing changes.
     */
    insertThenHang(options: { land?: "now" | "later" } = {}): { land(): void } {
      const held = {
        mode: options.land ?? "now",
        armed: true,
        pending: null as (() => void) | null,
      };
      insertHang = held;
      return {
        land() {
          held.pending?.();
          held.pending = null;
        },
      };
    },
    /** The person removes healdesk in their Google Account: every grant of that user to the client ends. */
    revokeRefreshToken(refreshToken: string): void {
      const grant = grants.get(refreshToken);
      if (!grant) throw new Error("fakeGoogleCalendar: no such refresh token");
      revokeAllFor(grant.sub, grant.clientId);
    },
    /** A Workspace administrator restricts Calendar access for the app: refresh answers admin_policy_enforced. */
    restrictByAdmin(sub: string, restricted = true): void {
      accountOf(sub).restricted = restricted;
    },
    /** The grant, and every live token of it, loses one scope. */
    dropScope(refreshToken: string, scope: string): void {
      const grant = grants.get(refreshToken);
      if (!grant) throw new Error("fakeGoogleCalendar: no such refresh token");
      grant.scopes = grant.scopes.filter((granted) => granted !== scope);
      for (const record of accessTokens.values()) {
        if (record.refreshToken === refreshToken) {
          record.scopes = record.scopes.filter((granted) => granted !== scope);
        }
      }
    },
    /** healdesk's OAuth client is deleted in Google Cloud: the token endpoint answers deleted_client. */
    deleteClient(clientId: string = client.clientId): void {
      const known = clients.get(clientId);
      if (known) known.deleted = true;
    },
  };
}

export type FakeGoogleCalendar = ReturnType<typeof fakeGoogleCalendar>;

function routeOf(method: string, url: URL): FakeGoogleRequest["endpoint"] {
  if (url.origin === "https://oauth2.googleapis.com" && method === "POST") {
    if (url.pathname === "/token") return "token";
    if (url.pathname === "/revoke") return "revoke";
  }
  if (url.origin !== "https://www.googleapis.com") return "unknown";
  if (url.pathname === "/calendar/v3/users/me/calendarList" && method === "GET") {
    return "calendarList";
  }
  if (url.pathname === "/calendar/v3/freeBusy" && method === "POST") return "freeBusy";
  const path = /^\/calendar\/v3\/calendars\/[^/]+\/events(\/[^/]+)?$/.exec(url.pathname);
  if (!path) return "unknown";
  if (!path[1]) return method === "POST" ? "insert" : method === "GET" ? "list" : "unknown";
  return method === "GET" ? "get" : method === "DELETE" ? "delete" : "unknown";
}

function cannedResponse(
  spec: FakeGoogleFailure,
  endpoint: FakeGoogleRequest["endpoint"],
  requestJson: unknown,
): Response {
  const headers: Record<string, string> =
    spec.retryAfter !== undefined ? { "retry-after": String(spec.retryAfter) } : {};
  if (spec.calendarError !== undefined) {
    const items =
      isRecord(requestJson) && Array.isArray(requestJson.items) ? requestJson.items : [];
    const first = items[0];
    const id = isRecord(first) && typeof first.id === "string" ? first.id : "primary";
    return jsonResponse(
      spec.status ?? 200,
      {
        kind: "calendar#freeBusy",
        calendars: { [id]: { errors: [{ domain: "global", reason: spec.calendarError }] } },
      },
      headers,
    );
  }
  const status = spec.status ?? 500;
  if (spec.rawBody !== undefined) return new Response(spec.rawBody, { status, headers });
  if (spec.body !== undefined) return jsonResponse(status, spec.body, headers);
  if (endpoint === "token" || endpoint === "revoke") {
    return jsonResponse(
      status,
      { error: spec.reason ?? "server_error", error_description: SYNTHETIC_MESSAGE },
      headers,
    );
  }
  return jsonResponse(
    status,
    {
      error: {
        errors: [
          { domain: "global", reason: spec.reason ?? "backendError", message: SYNTHETIC_MESSAGE },
        ],
        code: status,
        message: SYNTHETIC_MESSAGE,
      },
    },
    headers,
  );
}

/** The event as Google's events resource describes it. */
function resourceOf(event: FakeGoogleEvent, calendar: Calendar): Record<string, unknown> {
  const inserted = event.inserted ?? {};
  return {
    kind: "calendar#event",
    id: event.id,
    status: event.status,
    ...(typeof inserted.summary === "string" ? { summary: inserted.summary } : {}),
    ...(typeof inserted.description === "string" ? { description: inserted.description } : {}),
    ...(typeof inserted.visibility === "string" ? { visibility: inserted.visibility } : {}),
    transparency: event.transparency,
    start: { dateTime: event.start, timeZone: calendar.timeZone },
    end: { dateTime: event.end, timeZone: calendar.timeZone },
    ...(Object.keys(event.privateProperties).length > 0
      ? { extendedProperties: { private: { ...event.privateProperties } } }
      : {}),
  };
}

// ---- Partial responses -------------------------------------------------------

/** A parsed `fields` mask: each named field, kept whole (true) or narrowed further. */
type Selection = Map<string, Selection | true>;

/**
 * Google's partial-response syntax, as much of it as the adapter uses:
 * comma-separated fields, `a/b` to reach into an object, and `a(b,c)` to keep
 * only some fields of each element of a list or of an object. Null when the
 * mask does not parse, which Google answers with a 400.
 */
function parseFields(mask: string): Selection | null {
  let at = 0;

  function list(): Selection | null {
    const selection: Selection = new Map();
    for (;;) {
      const path: string[] = [];
      for (;;) {
        const name = /^[A-Za-z0-9_]+/.exec(mask.slice(at))?.[0];
        if (!name) return null;
        path.push(name);
        at += name.length;
        if (mask[at] !== "/") break;
        at += 1;
      }
      let leaf: Selection | true = true;
      if (mask[at] === "(") {
        at += 1;
        const inner = list();
        if (!inner || mask[at] !== ")") return null;
        at += 1;
        leaf = inner;
      }
      merge(selection, path, leaf);
      if (mask[at] !== ",") return selection;
      at += 1;
    }
  }

  const parsed = list();
  return parsed && at === mask.length ? parsed : null;
}

function merge(selection: Selection, path: readonly string[], leaf: Selection | true): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const existing = selection.get(head);
  if (rest.length === 0) {
    if (leaf === true || existing === true) selection.set(head, true);
    else {
      const target = existing ?? new Map();
      for (const [name, sub] of leaf) merge(target, [name], sub);
      selection.set(head, target);
    }
    return;
  }
  if (existing === true) return;
  const target = existing ?? new Map();
  selection.set(head, target);
  merge(target, rest, leaf);
}

function select(value: unknown, selection: Selection): unknown {
  if (Array.isArray(value)) return value.map((item) => select(item, selection));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of selection) {
    if (!(name in value)) continue;
    out[name] = sub === true ? value[name] : select(value[name], sub);
  }
  return out;
}

/** The body under the request's `fields` mask, if it has one. */
function masked(query: URLSearchParams, body: Record<string, unknown>): Response {
  const mask = query.get("fields");
  if (mask === null) return jsonResponse(200, body);
  const selection = parseFields(mask);
  if (!selection) return apiError(400, "invalidParameter", "Invalid field selection");
  return jsonResponse(200, select(body, selection));
}

// ---- Wire helpers ------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function apiError(status: number, reason: string, message: string): Response {
  return jsonResponse(status, {
    error: { errors: [{ domain: "global", reason, message }], code: status, message },
  });
}

function tokenError(status: number, error: string, description: string): Response {
  return jsonResponse(status, { error, error_description: description });
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const abort = () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function mint(prefix: string): string {
  return `${prefix}${randomBytes(18).toString("base64url")}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
