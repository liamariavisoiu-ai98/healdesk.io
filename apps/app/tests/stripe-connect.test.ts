import { createHash, randomBytes, randomUUID } from "node:crypto";

import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Stripe Connect (BD28, R23): single-use states bound to their user, an
 * exchange made once, an account never overwritten and revoked only when
 * unshared, redirects that never reach /admin, and the disconnect cascade.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  class NotFoundSignal extends Error {
    constructor() {
      super("NEXT_NOT_FOUND");
    }
  }
  return {
    NavigationSignal,
    NotFoundSignal,
    session: { userId: null as string | null, token: null as string | null },
    headers: new Headers(),
    alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, string | boolean> }>,
  };
});

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new mocks.NotFoundSignal();
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        mocks.session.userId
          ? { user: { id: mocks.session.userId }, session: { token: mocks.session.token } }
          : null,
    },
  },
}));
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (
    tx: { clinicId: string },
    kind: string,
    ref: Record<string, string | boolean>,
  ) => {
    mocks.alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));

import { GET as callbackRoute } from "@/app/api/connect/stripe/route";
import { GET as startRoute } from "@/app/api/connect/stripe/start/route";
import {
  accountRef,
  completeConnect,
  connectReturnPath,
  CONNECT_STATE_TTL_MS,
  disconnectStripeConnect,
  mintConnectState,
  OAUTH_TOKEN_URL,
  safeAccountLabel,
  stripeKeyMode,
  type ConnectCallbackResult,
  type PortalBinding,
} from "@/lib/billing/connect";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { hashSessionToken } from "@/lib/factors/step-ups";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";
import { createStripeFake, stripeError, type StripeFake } from "./setup/stripe-fake";

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 30_000 };
const NOW = new Date("2026-10-06T15:00:00Z");
const DEVICE = "Front desk Mac";

describe("the pure parts", () => {
  test("the key's mode decides which events and tokens are ours", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    expect(stripeKeyMode()).toBe("live");
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_abc");
    expect(stripeKeyMode()).toBe("test");
    vi.stubEnv("STRIPE_SECRET_KEY", "pk_live_abc");
    expect(stripeKeyMode()).toBeNull();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(stripeKeyMode()).toBeNull();
    vi.unstubAllEnvs();
  });

  test("no callback result is ever sent to /admin", () => {
    const target = { clinicId: randomUUID(), slug: "glow-a1b2c3", returnTo: "ops" as const };
    const results: ConnectCallbackResult[] = [
      { status: "invalid_state" },
      { status: "unbound" },
      ...(["settings", "setup", "ops"] as const).flatMap((returnTo): ConnectCallbackResult[] => [
        { status: "connected", target: { ...target, returnTo }, accountLabel: "Glow" },
        { status: "declined", target: { ...target, returnTo } },
        { status: "already_connected", target: { ...target, returnTo } },
        { status: "failed", target: { ...target, returnTo }, reason: "exchange_failed" },
      ]),
    ];
    for (const result of results) {
      const path = connectReturnPath(result);
      expect(path).not.toMatch(/admin/);
      expect(path).toMatch(
        /^\/(c\/glow-a1b2c3\/(settings|setup)\?connect=(ok|declined|failed)|connect\/stripe\/done\?result=)/,
      );
      expect(path).not.toContain(target.clinicId);
    }
  });

  test("an account's display name is shown only in plain words", () => {
    expect(safeAccountLabel("Glow Aesthetics, LLC")).toBe("Glow Aesthetics, LLC");
    expect(safeAccountLabel("  Glow\n<b>Spa</b>  ")).toBe("Glow b Spa b");
    expect(safeAccountLabel("Call +1 (415) 555-0100 now")).toBeNull();
    expect(safeAccountLabel("x".repeat(81))).toBeNull();
    expect(safeAccountLabel(null)).toBeNull();
    expect(safeAccountLabel("Clinic 360")).toBe("Clinic 360");
  });
});

describeDb("Connect against the database", DB_TEST_OPTIONS, () => {
  let fake: StripeFake;
  let token: ReturnType<typeof vi.fn>;
  let tokenReplies: Array<{ status?: number; body: unknown } | Error> = [];

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.alerts.length = 0;
    mocks.session.userId = null;
    mocks.session.token = null;
    mocks.headers = new Headers();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_connect");
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_connect");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    tokenReplies = [];
    token = vi.fn(async () => {
      const next = tokenReplies.shift() ?? {
        body: { stripe_user_id: "acct_1Glow", livemode: false },
      };
      if (next instanceof Error) throw next;
      return Response.json(next.body, { status: next.status ?? 200 });
    });
    vi.stubGlobal("fetch", token);
    fake = createStripeFake({
      "accounts.retrieve": () => ({
        settings: { dashboard: { display_name: "Glow Aesthetics" } },
        business_profile: { name: "Glow LLC" },
      }),
      "oauth.deauthorize": (params: unknown) => ({
        stripe_user_id: (params as { stripe_user_id: string }).stripe_user_id,
      }),
    });
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closePools();
  });

  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const bound =
    (userId: string): ((b: { userId: string }) => Promise<PortalBinding | null>) =>
    async (b) =>
      b.userId === userId ? { userId, deviceLabel: DEVICE } : null;

  async function account(clinicId: string): Promise<string | null> {
    const { rows } = await getMigratorPool().query<{ acct: string | null }>(
      `select stripe_connect_account_id as acct from clinics where id = $1`,
      [clinicId],
    );
    return rows[0]!.acct;
  }

  // billing_notices forces row-level security, so even the migrator reads it inside a tenant.
  async function notices(clinicId: string) {
    return (
      await inTenant(clinicId, (client) =>
        client.query<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }>(
          `select kind, dedupe_key, payload from billing_notices order by created_at`,
        ),
      )
    ).rows;
  }

  async function connectVia(
    clinic: SeededClinic,
    accountId: string,
    at: Date = NOW,
  ): Promise<ConnectCallbackResult> {
    const minted = await mintConnectState({ clinicId: clinic.clinicId, returnTo: "ops", now: at });
    tokenReplies.push({
      body: {
        stripe_user_id: accountId,
        livemode: false,
        access_token: "sk_test_should_never_be_stored",
        refresh_token: "rt_never",
      },
    });
    return completeConnect(
      { state: stateOf(minted.url), code: "ac_code", error: null },
      { now: at },
    );
  }

  test("a minted link stores only the hash of a 15-minute state, and an operator's new link retires the old one", async () => {
    const c = await seedClinic("mint");
    const first = await mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW });
    const url = new URL(first.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://connect.stripe.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "ca_test_connect",
      scope: "read_write",
      redirect_uri: "https://app.healdesk.test/api/connect/stripe",
    });
    const state = stateOf(first.url);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.expiresAt.getTime()).toBe(NOW.getTime() + CONNECT_STATE_TTL_MS);
    const { rows } = await getMigratorPool().query<{
      state_hash: Buffer;
      user_id: string | null;
      return_to: string;
      expires_at: Date;
    }>(
      `select state_hash, user_id, return_to, expires_at from stripe_connect_states where target_clinic_id = $1`,
      [c.clinicId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state_hash.equals(createHash("sha256").update(state).digest())).toBe(true);
    expect(rows[0]!.state_hash.toString("utf8")).not.toContain(state);
    expect(rows[0]).toMatchObject({ user_id: null, return_to: "ops" });

    const second = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "ops",
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(
      await completeConnect(
        { state, code: "ac_x", error: null },
        { now: new Date(NOW.getTime() + 61_000) },
      ),
    ).toEqual({ status: "invalid_state" });
    expect(
      await completeConnect(
        { state: stateOf(second.url), code: "ac_x", error: null },
        { now: new Date(NOW.getTime() + 61_000) },
      ),
    ).toMatchObject({ status: "connected" });
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'stripe_connect_state'`,
      ),
    );
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { returnTo: "ops", expiresInMinutes: 15 },
      { returnTo: "ops", expiresInMinutes: 15 },
    ]);
  });

  test("minting is refused while connected, without configuration or a public origin, and a portal link must name its user", async () => {
    const c = await seedClinic("mint-refused");
    await expect(
      mintConnectState({ clinicId: c.clinicId, returnTo: "settings", now: NOW }),
    ).rejects.toThrow(/bound to the signed-in user/);
    await expect(
      mintConnectState({ clinicId: c.clinicId, returnTo: "ops", userId: c.staffUserId, now: NOW }),
    ).rejects.toThrow(/not bound/);
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "");
    await expect(
      mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW }),
    ).rejects.toMatchObject({ code: "not_configured" });
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_connect");
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.test");
    await expect(
      mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW }),
    ).rejects.toMatchObject({ code: "no_public_origin" });
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_1Already' where id = $1`,
      [c.clinicId],
    );
    await expect(
      mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW }),
    ).rejects.toMatchObject({ code: "already_connected" });
    const { rows } = await getMigratorPool().query(`select 1 from stripe_connect_states`);
    expect(rows).toHaveLength(0);
  });

  test("a state works once and for 15 minutes, and a decline burns it without exchanging anything", async () => {
    const c = await seedClinic("single-use");
    const declined = await mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW });
    expect(
      await completeConnect(
        { state: stateOf(declined.url), code: null, error: "access_denied" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "declined", target: { returnTo: "ops" } });
    expect(
      await completeConnect(
        { state: stateOf(declined.url), code: "ac_late", error: null },
        { now: NOW },
      ),
    ).toEqual({ status: "invalid_state" });

    const stale = await mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW });
    expect(
      await completeConnect(
        { state: stateOf(stale.url), code: "ac_x", error: null },
        { now: new Date(NOW.getTime() + CONNECT_STATE_TTL_MS) },
      ),
    ).toEqual({ status: "invalid_state" });
    expect(
      await completeConnect({ state: "not-a-state", code: "ac_x", error: null }, { now: NOW }),
    ).toEqual({ status: "invalid_state" });
    expect(token).not.toHaveBeenCalled();
    expect(await account(c.clinicId)).toBeNull();
  });

  test("a portal state completes only in its own user's browser with a live step-up; any other browser burns it", async () => {
    const c = await seedClinic("bound");
    const stolen = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "settings",
      userId: c.staffUserId,
      now: NOW,
    });
    expect(
      await completeConnect(
        { state: stateOf(stolen.url), code: "ac_x", error: null },
        { now: NOW, portalBinding: bound("usr_someone_else") },
      ),
    ).toEqual({ status: "unbound" });
    expect(
      await completeConnect(
        { state: stateOf(stolen.url), code: "ac_x", error: null },
        { now: NOW, portalBinding: bound(c.staffUserId) },
      ),
    ).toEqual({ status: "invalid_state" });
    expect(token).not.toHaveBeenCalled();

    const own = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "setup",
      userId: c.staffUserId,
      now: NOW,
    });
    const result = await completeConnect(
      { state: stateOf(own.url), code: "ac_own", error: null },
      { now: NOW, portalBinding: bound(c.staffUserId) },
    );
    expect(result).toEqual({
      status: "connected",
      target: { clinicId: c.clinicId, slug: c.slug, returnTo: "setup" },
      accountLabel: "Glow Aesthetics",
    });
    expect(connectReturnPath(result)).toBe(`/c/${c.slug}/setup?connect=ok`);
    // The device that stepped up is who the audit and the security event name.
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{
        actor_label: string;
        actor_user_id: string;
        metadata: Record<string, unknown>;
      }>(
        `select actor_label, actor_user_id, metadata from audit_log where resource_type = 'clinic_stripe_connect'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        actor_label: DEVICE,
        actor_user_id: c.staffUserId,
        metadata: { connected: true, source: "portal" },
      },
    ]);
    const events = await getMigratorPool().query<{
      actor_label: string;
      user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select actor_label, user_id, metadata from security_events where event = 'stripe_connect_linked'`,
    );
    expect(events.rows).toEqual([
      {
        actor_label: DEVICE,
        user_id: c.staffUserId,
        metadata: { clinicId: c.clinicId, accountRef: accountRef("acct_1Glow"), source: "portal" },
      },
    ]);
  });

  test("the code is exchanged once by a plain POST, and only the account id is kept", async () => {
    const c = await seedClinic("exchange");
    const result = await connectVia(c, "acct_1Exchange");
    expect(result).toMatchObject({ status: "connected" });
    expect(token).toHaveBeenCalledTimes(1);
    const [url, init] = token.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OAUTH_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "ac_code",
      client_secret: "sk_test_connect",
    });
    expect(await account(c.clinicId)).toBe("acct_1Exchange");
    // The deprecated tokens in the response, and the raw account id, are
    // written nowhere but the clinic's own column. audit_log and
    // billing_notices force row-level security, so they are read inside the
    // clinic's tenant; security_events has none.
    const tenantRows = await inTenant(c.clinicId, async (client) => [
      (await client.query(`select * from audit_log`)).rows,
      (await client.query(`select * from billing_notices`)).rows,
    ]);
    expect(tenantRows[0]!.length).toBeGreaterThan(0);
    expect(tenantRows[1]!.length).toBe(1);
    const everything = JSON.stringify([
      ...tenantRows,
      (await getMigratorPool().query(`select * from security_events`)).rows,
    ]);
    expect(everything).not.toMatch(/sk_test_should_never_be_stored|rt_never|acct_1Exchange/);

    const other = await seedClinic("exchange-refused");
    const minted = await mintConnectState({ clinicId: other.clinicId, returnTo: "ops", now: NOW });
    tokenReplies.push({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "Authorization code does not exist: ac_code",
      },
    });
    expect(
      await completeConnect(
        { state: stateOf(minted.url), code: "ac_code", error: null },
        { now: NOW },
      ),
    ).toMatchObject({ status: "failed", reason: "code_rejected" });
    const dropped = await mintConnectState({ clinicId: other.clinicId, returnTo: "ops", now: NOW });
    tokenReplies.push(new TypeError("fetch failed"));
    expect(
      await completeConnect(
        { state: stateOf(dropped.url), code: "ac_code", error: null },
        { now: NOW },
      ),
    ).toMatchObject({ status: "failed", reason: "exchange_failed" });
    // One attempt each, never a retry of the same code.
    expect(token).toHaveBeenCalledTimes(3);
    expect(await account(other.clinicId)).toBeNull();
  });

  test("a token whose mode differs from the key's is refused and nothing is stored", async () => {
    const c = await seedClinic("mode");
    const minted = await mintConnectState({ clinicId: c.clinicId, returnTo: "ops", now: NOW });
    tokenReplies.push({ body: { stripe_user_id: "acct_1Live", livemode: true } });
    expect(
      await completeConnect(
        { state: stateOf(minted.url), code: "ac_code", error: null },
        { now: NOW },
      ),
    ).toMatchObject({ status: "failed", reason: "mode_mismatch" });
    expect(await account(c.clinicId)).toBeNull();
    expect(fake.callsTo("oauth.deauthorize")).toHaveLength(0);
  });

  test("the same account again is a no-op; a different one is refused, and revoked only when no other clinic uses it", async () => {
    const c = await seedClinic("overwrite");
    // Four links started before any finished: tabs, or a link forwarded from a shared inbox.
    const links = await Promise.all(
      [0, 1, 2, 3].map(() =>
        mintConnectState({
          clinicId: c.clinicId,
          returnTo: "settings",
          userId: c.staffUserId,
          now: NOW,
        }),
      ),
    );
    const finish = (index: number, accountId: string, at: Date = NOW) => {
      tokenReplies.push({ body: { stripe_user_id: accountId, livemode: false } });
      return completeConnect(
        { state: stateOf(links[index]!.url), code: "ac_code", error: null },
        { now: at, portalBinding: bound(c.staffUserId) },
      );
    };
    expect(await finish(0, "acct_1First")).toMatchObject({ status: "connected" });
    expect(await finish(1, "acct_1First", new Date(NOW.getTime() + 60_000))).toMatchObject({
      status: "connected",
    });
    expect(await notices(c.clinicId)).toHaveLength(1);

    // A stranger's account through a leaked link: refused, and our stray connection to it revoked.
    expect(await finish(2, "acct_1Stranger")).toMatchObject({ status: "already_connected" });
    expect(await account(c.clinicId)).toBe("acct_1First");
    expect(fake.callsTo("oauth.deauthorize").map((call) => call.args[0])).toEqual([
      { client_id: "ca_test_connect", stripe_user_id: "acct_1Stranger" },
    ]);

    // An account a sibling location already uses is never revoked: revocation is account-wide.
    const sibling = await seedClinic("overwrite-sibling");
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_1Shared' where id = $1`,
      [sibling.clinicId],
    );
    expect(await finish(3, "acct_1Shared")).toMatchObject({ status: "already_connected" });
    expect(fake.callsTo("oauth.deauthorize")).toHaveLength(1);
    expect(await account(sibling.clinicId)).toBe("acct_1Shared");
    const refused = await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = 'stripe_connect_refused' order by occurred_at`,
    );
    expect(refused.rows.map((r) => r.metadata.deauthorized)).toEqual([true, false]);
  });

  test("connecting enqueues connect_connected on the billing clinic, deduped per connection", async () => {
    const billing = await seedClinic("billing-root");
    const { rows } = await getMigratorPool().query<{ id: string; slug: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id) values ($1, $2, 'Second location', 'med-spa', $3) returning id, slug`,
      [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
    );
    const location = { ...billing, clinicId: rows[0]!.id, slug: rows[0]!.slug };
    expect(await connectVia(location, "acct_1Location")).toMatchObject({ status: "connected" });
    expect(await notices(location.clinicId)).toEqual([]);
    expect(await notices(billing.clinicId)).toEqual([
      {
        kind: "connect_connected",
        dedupe_key: `connected:${accountRef("acct_1Location")}:${NOW.toISOString()}`,
        payload: { connectedAt: NOW.toISOString(), source: "ops" },
      },
    ]);
  });

  test("the callback route redirects every outcome with no referrer, and never to /admin", async () => {
    const c = await seedClinic("route");
    const request = (query: string) =>
      new Request(`https://app.healdesk.test/api/connect/stripe?${query}`);
    const unknown = await callbackRoute(
      request("state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code=ac_x"),
    );
    expect(unknown.status).toBe(303);
    expect(unknown.headers.get("location")).toBe(
      "https://app.healdesk.test/connect/stripe/done?result=expired",
    );
    expect(unknown.headers.get("referrer-policy")).toBe("no-referrer");

    const minted = await mintConnectState({ clinicId: c.clinicId, returnTo: "ops" });
    const ok = await callbackRoute(
      request(`state=${stateOf(minted.url)}&code=ac_x&scope=read_write`),
    );
    // The account's name stays off the public page: the panel and the portal read it on the server.
    expect(ok.headers.get("location")).toBe(
      "https://app.healdesk.test/connect/stripe/done?result=ok",
    );

    // A portal state comes back to the portal, checked against the signed-in browser.
    const tokenValue = randomBytes(24).toString("base64url");
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up) values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
      [c.staffUserId, DEVICE, randomBytes(16).toString("base64url")],
    );
    await getMigratorPool().query(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at) values ($1, $2, $3, $4, now(), now())`,
      [hashSessionToken(tokenValue), c.staffUserId, rows[0]!.id, DEVICE],
    );
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = null where id = $1`,
      [c.clinicId],
    );
    const portal = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "settings",
      userId: c.staffUserId,
    });
    const strangerBrowser = await callbackRoute(request(`state=${stateOf(portal.url)}&code=ac_x`));
    expect(strangerBrowser.headers.get("location")).toBe(
      "https://app.healdesk.test/connect/stripe/done?result=failed",
    );

    mocks.session.userId = c.staffUserId;
    mocks.session.token = tokenValue;
    const again = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "settings",
      userId: c.staffUserId,
    });
    const declined = await callbackRoute(
      request(`error=access_denied&error_description=The+user+denied&state=${stateOf(again.url)}`),
    );
    expect(declined.headers.get("location")).toBe(
      `https://app.healdesk.test/c/${c.slug}/settings?connect=declined`,
    );
    const own = await mintConnectState({
      clinicId: c.clinicId,
      returnTo: "settings",
      userId: c.staffUserId,
    });
    const connected = await callbackRoute(request(`state=${stateOf(own.url)}&code=ac_x`));
    expect(connected.headers.get("location")).toBe(
      `https://app.healdesk.test/c/${c.slug}/settings?connect=ok`,
    );
    for (const response of [unknown, ok, strangerBrowser, declined, connected]) {
      expect(response.headers.get("location")).not.toMatch(/admin/);
    }
  });

  test("the portal's start route needs the clinic's sign-in and a live step-up, and binds the state to that user", async () => {
    const c = await seedClinic("start");
    const start = (query: string) =>
      startRoute(new Request(`https://app.healdesk.test/api/connect/stripe/start?${query}`));
    const outcome = async (query: string) => {
      try {
        return { response: await start(query) };
      } catch (error) {
        if (error instanceof mocks.NavigationSignal) return { redirect: error.url };
        if (error instanceof mocks.NotFoundSignal) return { notFound: true };
        throw error;
      }
    };

    expect((await outcome(`clinic=${c.slug}&from=admin`)).response?.status).toBe(404);
    expect(await outcome(`clinic=${c.slug}&from=settings`)).toEqual({
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${c.slug}`)}`,
    });
    const tokenValue = randomBytes(24).toString("base64url");
    mocks.session.userId = c.staffUserId;
    mocks.session.token = tokenValue;
    expect(await outcome(`clinic=someone-else&from=settings`)).toEqual({ notFound: true });
    // Signed in, no step-up: off to step up, and back to the page it started from.
    expect(await outcome(`clinic=${c.slug}&from=setup`)).toEqual({
      redirect: `/c/${c.slug}/step-up?next=${encodeURIComponent(`/c/${c.slug}/setup`)}`,
    });
    expect(
      (await getMigratorPool().query(`select 1 from stripe_connect_states`)).rows,
    ).toHaveLength(0);

    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up) values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
      [c.staffUserId, DEVICE, randomBytes(16).toString("base64url")],
    );
    await getMigratorPool().query(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at) values ($1, $2, $3, $4, now(), now())`,
      [hashSessionToken(tokenValue), c.staffUserId, rows[0]!.id, DEVICE],
    );
    const started = await outcome(`clinic=${c.slug}&from=settings`);
    expect(started.response?.status).toBe(303);
    const location = started.response!.headers.get("location")!;
    expect(location).toMatch(/^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
    const states = await getMigratorPool().query<{ user_id: string; return_to: string }>(
      `select user_id, return_to from stripe_connect_states where target_clinic_id = $1`,
      [c.clinicId],
    );
    expect(states.rows).toEqual([{ user_id: c.staffUserId, return_to: "settings" }]);
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ actor_label: string }>(
        `select actor_label from audit_log where resource_type = 'stripe_connect_state'`,
      ),
    );
    expect(audit.rows).toEqual([{ actor_label: DEVICE }]);

    // Already connected: back to the page with connect=failed, never an error page.
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_1Done' where id = $1`,
      [c.clinicId],
    );
    const refused = await outcome(`clinic=${c.slug}&from=settings`);
    expect(refused.response!.headers.get("location")).toBe(
      `https://app.healdesk.test/c/${c.slug}/settings?connect=failed`,
    );
  });

  describe("disconnecting", () => {
    const ACCOUNT = "acct_1Leaving";

    async function connectedClinic(label: string, accountId = ACCOUNT) {
      const c = await seedClinic(label);
      await getMigratorPool().query(
        `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
        [c.clinicId, accountId, NOW],
      );
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, deposits_enabled) values ($1, true)`,
          [c.clinicId],
        ),
      );
      return c;
    }

    let n = 0;
    async function link(
      clinicId: string,
      status: "open" | "creating",
      sessionId: string | null,
      accountId = ACCOUNT,
    ) {
      n += 1;
      return inTenant(clinicId, async (client) => {
        const contact = (
          await client.query<{ id: string }>(
            `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
            [clinicId, `+1555020${String(1000 + n)}`],
          )
        ).rows[0]!.id;
        const appointment = (
          await client.query<{ id: string }>(
            `insert into appointments (clinic_id, contact_id, scheduled_for, deposit_usd, deposit_status) values ($1, $2, now() + interval '2 days', 50, $3) returning id`,
            [clinicId, contact, status === "open" ? "pending_link" : "none"],
          )
        ).rows[0]!.id;
        const deposit = (
          await client.query<{ id: string }>(
            `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, checkout_session_id, status, expires_at) values ($1, $2, 'web', 5000, $3, $4, $5, now() + interval '1 hour') returning id`,
            [clinicId, appointment, accountId, sessionId, status],
          )
        ).rows[0]!.id;
        return { appointment, deposit };
      });
    }

    async function state(clinicId: string, ids: { appointment: string; deposit: string }) {
      return inTenant(clinicId, async (client) => ({
        deposit: (
          await client.query<{ status: string }>(
            `select status from deposit_payments where id = $1`,
            [ids.deposit],
          )
        ).rows[0]!.status,
        appointment: (
          await client.query<{ deposit_status: string }>(
            `select deposit_status from appointments where id = $1`,
            [ids.appointment],
          )
        ).rows[0]!.deposit_status,
      }));
    }

    test("deposits go off first; open links are expired, a paid one is recorded as paid, an unreadable one goes to the desk as possibly paid", async () => {
      const c = await connectedClinic("leave");
      const expirable = await link(c.clinicId, "open", "cs_expirable");
      const paid = await link(c.clinicId, "open", "cs_paid");
      const unreadable = await link(c.clinicId, "open", "cs_unreadable");
      const creating = await link(c.clinicId, "creating", null);
      const seenWhileExpiring: boolean[] = [];
      fake.on("checkout.sessions.expire", async (id: unknown) => {
        const { rows } = await inTenant(c.clinicId, (client) =>
          client.query<{ on: boolean }>(`select deposits_enabled as on from clinic_settings`),
        );
        seenWhileExpiring.push(rows[0]!.on);
        if (id === "cs_expirable") return { id, status: "expired" };
        throw stripeError("invalid_request", {
          message: 'Only Checkout Sessions with a status in ["open"] can be expired.',
        });
      });
      fake.on("checkout.sessions.retrieve", (id: unknown) => {
        if (id === "cs_paid") return { id, status: "complete", payment_status: "paid" };
        throw stripeError("connection");
      });

      const result = await disconnectStripeConnect({
        clinicId: c.clinicId,
        actorLabel: "ops@healdesk.test",
        now: NOW,
      });
      expect(result).toEqual({
        status: "disconnected",
        deauthorized: true,
        shared: false,
        cancelledLinks: 1,
        paidLinks: 1,
        uncheckedLinks: 1,
      });
      expect(seenWhileExpiring).toEqual([false, false, false]);
      for (const call of fake.callsTo("checkout.sessions.expire"))
        expect(call.args[2]).toMatchObject({ stripeAccount: ACCOUNT });
      expect(fake.callsTo("oauth.deauthorize").map((call) => call.args[0])).toEqual([
        { client_id: "ca_test_connect", stripe_user_id: ACCOUNT },
      ]);

      expect(await state(c.clinicId, expirable)).toEqual({
        deposit: "cancelled",
        appointment: "pending_front_desk",
      });
      expect(await state(c.clinicId, paid)).toEqual({ deposit: "paid", appointment: "paid" });
      expect(await state(c.clinicId, unreadable)).toEqual({
        deposit: "open",
        appointment: "pending_front_desk",
      });
      expect((await state(c.clinicId, creating)).deposit).toBe("cancelled");
      expect(mocks.alerts.map((a) => a.ref.appointmentId).sort()).toEqual(
        [expirable.appointment, unreadable.appointment].sort(),
      );
      expect(mocks.alerts.every((a) => a.kind === "deposit_to_collect")).toBe(true);
      // The link nobody could check is flagged as possibly paid, so the alert
      // says to look in Stripe before collecting; the one Stripe expired is not.
      expect(mocks.alerts.map((a) => a.ref)).toEqual(
        expect.arrayContaining([
          { appointmentId: expirable.appointment },
          { appointmentId: unreadable.appointment, mayBePaid: true },
        ]),
      );

      const { rows } = await getMigratorPool().query<{
        acct: string | null;
        disconnected: Date | null;
      }>(
        `select stripe_connect_account_id as acct, stripe_connect_disconnected_at as disconnected from clinics where id = $1`,
        [c.clinicId],
      );
      expect(rows[0]).toEqual({ acct: null, disconnected: NOW });
      expect(await notices(c.clinicId)).toEqual([
        {
          kind: "connect_disconnected",
          dedupe_key: `disconnected:${accountRef(ACCOUNT)}:${NOW.toISOString()}`,
          // The link nobody could check may still be paid: the email must say so.
          payload: {
            disconnectedAt: NOW.toISOString(),
            wasByWebhook: false,
            source: "ops",
            hasUncheckedLinks: true,
          },
        },
      ]);
      const unchecked = await inTenant(c.clinicId, (client) =>
        client.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where resource_type = 'deposit_payment' and resource_id = $1`,
          [unreadable.deposit],
        ),
      );
      expect(unchecked.rows.map((r) => r.metadata)).toEqual([
        { outcome: "unchecked", reason: "link_may_be_paid" },
      ]);
      // Not connected any more: nothing to do, and nothing sent twice.
      expect(
        await disconnectStripeConnect({
          clinicId: c.clinicId,
          actorLabel: "ops@healdesk.test",
          now: NOW,
        }),
      ).toEqual({ status: "not_connected" });
      expect(await notices(c.clinicId)).toHaveLength(1);
    });

    test("an account another clinic still uses is not revoked: only this clinic lets go of it", async () => {
      const leaving = await connectedClinic("shared-leaving", "acct_1Group");
      const staying = await connectedClinic("shared-staying", "acct_1Group");
      // The portal passes the step-up's device, which the audit and the security event name.
      const result = await disconnectStripeConnect({
        clinicId: leaving.clinicId,
        actorLabel: DEVICE,
        actor: { type: "user", userId: leaving.staffUserId, label: DEVICE },
        source: "portal",
        now: NOW,
      });
      expect(result).toMatchObject({ status: "disconnected", deauthorized: false, shared: true });
      const audit = await inTenant(leaving.clinicId, (client) =>
        client.query<{ actor_label: string; metadata: Record<string, unknown> }>(
          `select actor_label, metadata from audit_log where resource_type = 'clinic_stripe_connect'`,
        ),
      );
      expect(audit.rows).toEqual([
        {
          actor_label: DEVICE,
          metadata: {
            connected: false,
            source: "portal",
            wasByWebhook: false,
            deauthorized: false,
          },
        },
      ]);
      const unlinked = await getMigratorPool().query<{
        actor_label: string;
        metadata: Record<string, unknown>;
      }>(
        `select actor_label, metadata from security_events where event = 'stripe_connect_unlinked'`,
      );
      expect(unlinked.rows).toEqual([
        {
          actor_label: DEVICE,
          metadata: {
            clinicId: leaving.clinicId,
            accountRef: accountRef("acct_1Group"),
            source: "portal",
            wasByWebhook: false,
            deauthorized: false,
          },
        },
      ]);
      expect(fake.callsTo("oauth.deauthorize")).toHaveLength(0);
      expect(await account(leaving.clinicId)).toBeNull();
      expect(await account(staying.clinicId)).toBe("acct_1Group");
      expect((await notices(leaving.clinicId))[0]!.payload).toEqual({
        disconnectedAt: NOW.toISOString(),
        wasByWebhook: false,
        source: "portal",
        hasUncheckedLinks: false,
      });
    });

    test("Stripe refusing to revoke emails the reset as still connected, never as disconnected", async () => {
      const c = await connectedClinic("refuse-revoke-email");
      // A deposit amount, so "Take deposits" was on by the rules and the
      // disconnect's reset is what turns it off.
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into agent_configs (clinic_id, greeting, services)
             values ($1, 'Thanks for calling.', '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30,"depositUsd":50}]'::jsonb)`,
          [c.clinicId],
        ),
      );
      fake.on("oauth.deauthorize", () => {
        throw stripeError("api");
      });
      expect(
        await disconnectStripeConnect({ clinicId: c.clinicId, actorLabel: "ops@healdesk.test", now: NOW }),
      ).toEqual({ status: "deauthorize_failed" });
      expect(await account(c.clinicId)).toBe(ACCOUNT);
      const sent = await notices(c.clinicId);
      // No disconnect email, and one reset email, worded for a kept account.
      expect(sent.map((n) => n.kind)).toEqual(["setting_changed"]);
      expect(sent[0]!.payload).toMatchObject({
        field: "payment_switches_reset",
        switchIds: ["deposits"],
        code: "connect_stripe",
        isStripeStillConnected: true,
      });
      // The reset itself was real, so its change row stays, as healdesk's.
      const feed = await inTenant(c.clinicId, (client) =>
        client.query<{ source: string; summary: Record<string, unknown> }>(
          `select source, summary from clinic_change_events where kind = 'setting'`,
        ),
      );
      expect(feed.rows).toEqual([
        { source: "system", summary: { setting: "deposits_enabled", before: "on", after: "off" } },
      ]);
    });

    test("Stripe refusing to revoke keeps the account recorded with deposits off; one that already revoked us counts as revoked", async () => {
      const c = await connectedClinic("refuse-revoke");
      fake.on("oauth.deauthorize", () => {
        throw stripeError("api");
      });
      expect(
        await disconnectStripeConnect({
          clinicId: c.clinicId,
          actorLabel: "ops@healdesk.test",
          now: NOW,
        }),
      ).toEqual({ status: "deauthorize_failed" });
      expect(await account(c.clinicId)).toBe(ACCOUNT);
      const settings = await inTenant(c.clinicId, (client) =>
        client.query<{ deposits_enabled: boolean }>(`select deposits_enabled from clinic_settings`),
      );
      expect(settings.rows[0]!.deposits_enabled).toBe(false);
      expect(await notices(c.clinicId)).toEqual([]);

      fake.on("oauth.deauthorize", () => {
        throw new Stripe.errors.StripeInvalidClientError({
          message: `This application is not connected to stripe account ${ACCOUNT}, or that account does not exist.`,
        });
      });
      expect(
        await disconnectStripeConnect({
          clinicId: c.clinicId,
          actorLabel: "ops@healdesk.test",
          now: NOW,
        }),
      ).toMatchObject({ status: "disconnected", deauthorized: true });
      expect(await account(c.clinicId)).toBeNull();
    });
  });
});
