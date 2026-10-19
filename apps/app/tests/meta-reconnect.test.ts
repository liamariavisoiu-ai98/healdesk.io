import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { attachMetaChannel, graphSend, sendMetaReply } from "@/lib/meta/channels";
import { GraphError, isTokenInvalid, probeToken, type FetchLike } from "@/lib/meta/graph";
import { decodeLoginCookie, encodeLoginCookie } from "@/lib/meta/login-state";
import { portalReturnUrl, surfaceOf } from "@/lib/meta/portal-return";
import {
  markBrokenWithin,
  markMetaConnectionBroken,
  metaConnectViewOf,
  readMetaConnectView,
  replacesConnectedAsset,
  retireDroppedFacebookRows,
  settleMetaMarks,
} from "@/lib/meta/reconnect";
import { runMetaTokenWatch } from "@/lib/meta/token-watch";
import { needsAttention, type AttentionFacts } from "@/lib/portal/attention";
import { readSettingsView } from "@/lib/portal/settings-view";
import { readSetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Reconnecting a Meta login (lib/meta/reconnect.ts, token-watch.ts): the states
 * the portal draws, the three ways a dead login is noticed (a send Meta
 * refuses, the periodic check, and nothing else), what does NOT count as dead,
 * and that a fresh login clears the mark. No patient data anywhere: tokens
 * are fake strings, ids are synthetic.
 */

const AVAILABLE = { facebook: true, whatsapp: true };
const ACTOR = { type: "service", serviceName: "meta-reconnect-test" } as const;

function graphError(status: number, code: number): Response {
  return Response.json({ error: { message: "x", code } }, { status });
}

describe("the connection states the portal draws", () => {
  test("nothing connected, connected, and dropped, for Facebook and WhatsApp separately", () => {
    expect(metaConnectViewOf([], AVAILABLE)).toEqual({
      facebook: { state: "none", names: [] },
      whatsapp: { state: "none" },
      available: AVAILABLE,
    });
    const view = metaConnectViewOf(
      [
        { provider: "meta-messenger", brokenAt: null },
        { provider: "meta-instagram", brokenAt: new Date() },
        { provider: "meta-whatsapp", brokenAt: null },
      ],
      AVAILABLE,
    );
    // One Facebook login serves both apps: if either row is dropped, the login is.
    expect(view.facebook).toEqual({ state: "needs_reconnect", names: ["Messenger", "Instagram"] });
    expect(view.whatsapp.state).toBe("connected");
  });
});

describe("what counts as a dead token", () => {
  test("only Meta's OAuth code 190, never a bare 401 and never the codes a send outside the window also uses", () => {
    expect(isTokenInvalid(new GraphError("x", 400, 190))).toBe(true);
    expect(isTokenInvalid(new GraphError("x", 401))).toBe(false);
    expect(isTokenInvalid(new GraphError("x", 400, 10))).toBe(false);
    expect(isTokenInvalid(new GraphError("x", 400, 200))).toBe(false);
    expect(isTokenInvalid(new GraphError("x", 500))).toBe(false);
    expect(isTokenInvalid(new Error("Graph API 400"))).toBe(false);
  });

  test("graphSend carries Meta's code and status, and nothing of its text", async () => {
    vi.stubGlobal("fetch", async () => graphError(400, 190));
    try {
      const error = await graphSend({ platform: "messenger", externalId: "1", accessToken: "t", recipientId: "r", text: "hi" }).catch((e) => e);
      expect(error).toBeInstanceOf(GraphError);
      expect(error.code).toBe(190);
      expect(error.message).toBe("Graph API 400");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("the probe says invalid only for a dead token; a blip or a refusal is unknown; the token rides in the header", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchWith = (respond: () => Response | Promise<Response>): FetchLike => async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return respond();
    };
    expect(await probeToken(fetchWith(() => Response.json({ id: "1" })), "tok-1")).toBe("valid");
    expect(await probeToken(fetchWith(() => graphError(400, 190)), "tok-2")).toBe("invalid");
    expect(await probeToken(fetchWith(() => graphError(500, 2)), "tok-3")).toBe("unknown");
    expect(await probeToken(fetchWith(() => graphError(400, 100)), "tok-4")).toBe("unknown");
    expect(
      await probeToken(
        fetchWith(() => {
          throw new Error("network down");
        }),
        "tok-5",
      ),
    ).toBe("unknown");
    for (const call of seen) {
      expect(call.url).not.toMatch(/tok-\d/);
      expect(call.auth).toMatch(/^Bearer tok-\d$/);
    }
  });
});

describe("where the portal's buttons send the clinic back", () => {
  test("`from` is an enum, and the return is on the public origin with the outcome", () => {
    expect(surfaceOf("settings")).toBe("settings");
    expect(surfaceOf("https://evil.example")).toBe("setup");
    expect(surfaceOf(undefined)).toBe("setup");
    process.env.BETTER_AUTH_URL = "https://app.healdesk.io";
    expect(portalReturnUrl("glow", "settings", "connected")).toBe("https://app.healdesk.io/c/glow/settings?meta=connected#channels");
    expect(portalReturnUrl("glow", "setup", "page_taken")).toBe("https://app.healdesk.io/c/glow/setup?s=channels&meta=page_taken");
  });

  test("the login cookie carries `from` only when it is one of the two screens", () => {
    const encoded = encodeLoginCookie({ token: "t", nonce: "n", from: "settings" });
    expect(decodeLoginCookie(encoded)).toEqual({ token: "t", nonce: "n", from: "settings" });
    expect(decodeLoginCookie(encodeLoginCookie({ token: "t", nonce: "n" }))).toEqual({ token: "t", nonce: "n" });
    const forged = Buffer.from(JSON.stringify({ t: "t", n: "n", r: "https://evil.example" })).toString("base64url");
    expect(decodeLoginCookie(forged)).toEqual({ token: "t", nonce: "n" });
  });
});

describe("Home's Needs attention", () => {
  const facts = (meta: ReturnType<typeof metaConnectViewOf>): AttentionFacts =>
    ({
      slug: "glow",
      state: {
        screens: [],
        progress: new Map(),
        clinic: { isCoveredEntity: false },
        hasPasskey: true,
        hasBackup: true,
        billing: null,
        address: "front@glow.test",
      },
      addressUndeliverable: false,
      meta,
    }) as unknown as AttentionFacts;

  test("a dropped Facebook login and a dropped WhatsApp login are each a line with a Reconnect link; healthy ones are not", () => {
    const dropped = metaConnectViewOf(
      [
        { provider: "meta-messenger", brokenAt: new Date() },
        { provider: "meta-whatsapp", brokenAt: new Date() },
      ],
      AVAILABLE,
    );
    const items = needsAttention(facts(dropped)).filter((i) => i.id.startsWith("meta_"));
    expect(items.map((i) => i.id)).toEqual(["meta_facebook_dropped", "meta_whatsapp_dropped"]);
    expect(items[0]!.text).toContain("Messenger");
    for (const item of items) expect(item.action.href).toBe("/c/glow/settings#meta-connections");

    const healthy = metaConnectViewOf([{ provider: "meta-messenger", brokenAt: null }], AVAILABLE);
    expect(needsAttention(facts(healthy)).filter((i) => i.id.startsWith("meta_"))).toEqual([]);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

let n = 0;
async function connect(clinic: PortalClinic, platform: "messenger" | "instagram" | "whatsapp") {
  n += 1;
  return withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
    attachMetaChannel(tx, {
      platform,
      externalId: `8${String(n).padStart(4, "0")}${Date.now()}`,
      accessToken: `EAAB-${platform}-${randomUUID()}`,
      via: platform === "whatsapp" ? "embedded_signup" : "facebook_login",
    }),
  );
}

const view = (clinic: PortalClinic) =>
  withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readMetaConnectView(tx.db, tx.clinicId));

async function brokenRows(clinic: PortalClinic) {
  return inTenant(clinic.clinicId, async (c) =>
    (
      await c.query<{ provider: string; broken: boolean; last_error: string | null; status: string }>(
        `select provider, broken_at is not null as broken, last_error, status from provider_connections order by provider`,
      )
    ).rows,
  );
}

describeDb("a dropped Meta login", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);
  afterAll(async () => {
    await closePools();
  });

  test("marked once, the status left alone so inbound messages still resolve; a fresh login clears it", async () => {
    const clinic = await provisionPortalClinic("reconnect-clear", { plan: "voice-metachat-1000-1000" });
    const id = await connect(clinic, "messenger");
    expect((await view(clinic)).facebook.state).toBe("connected");

    markMetaConnectionBroken(clinic.clinicId, id, "token_invalid");
    await settleMetaMarks();
    expect((await view(clinic)).facebook.state).toBe("needs_reconnect");
    expect(await brokenRows(clinic)).toEqual([{ provider: "meta-messenger", broken: true, last_error: "token_invalid", status: "pending" }]);

    // A second mark is a no-op: one audit row, however many sends fail.
    markMetaConnectionBroken(clinic.clinicId, id, "token_invalid");
    await settleMetaMarks();
    const audits = await inTenant(clinic.clinicId, (c) =>
      c.query(`select 1 from audit_log where metadata->>'outcome' = 'needs_reconnect'`),
    );
    expect(audits.rows).toHaveLength(1);

    await connect(clinic, "messenger");
    expect((await view(clinic)).facebook.state).toBe("connected");
    expect(await brokenRows(clinic)).toEqual([{ provider: "meta-messenger", broken: false, last_error: null, status: "pending" }]);
  });

  test("a send Meta refuses with a dead token marks the connection, even though the caller's transaction rolls back", async () => {
    const clinic = await provisionPortalClinic("reconnect-send", { plan: "voice-metachat-1000-1000" });
    const connectionId = await connect(clinic, "messenger");
    const owner = { clinicId: clinic.clinicId, connectionId, platform: "messenger" as const, enabled: true, platformEnabled: true };
    const dead = vi.fn(async () => {
      throw new GraphError("Graph API 400", 400, 190);
    });
    await expect(
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        sendMetaReply(tx, owner, "page", "user", "Hello", dead, { lastInboundAt: new Date() }),
      ),
    ).rejects.toBeInstanceOf(GraphError);
    await settleMetaMarks();
    expect((await view(clinic)).facebook.state).toBe("needs_reconnect");
  });

  test("a send that fails for any other reason leaves the login alone", async () => {
    const clinic = await provisionPortalClinic("reconnect-other", { plan: "voice-metachat-1000-1000" });
    const connectionId = await connect(clinic, "messenger");
    const owner = { clinicId: clinic.clinicId, connectionId, platform: "messenger" as const, enabled: true, platformEnabled: true };
    for (const failure of [new GraphError("Graph API 400", 400, 10), new GraphError("Graph API 500", 500), new Error("Graph API 400")]) {
      await expect(
        withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          sendMetaReply(tx, owner, "page", "user", "Hello", async () => { throw failure; }, { lastInboundAt: new Date() }),
        ),
      ).rejects.toBeDefined();
    }
    expect((await view(clinic)).facebook.state).toBe("connected");
  });

  test("the periodic check marks a token Meta calls dead, and only that one", async () => {
    const clinic = await provisionPortalClinic("reconnect-watch", { plan: "voice-metachat-1000-1000" });
    await connect(clinic, "messenger");
    await connect(clinic, "whatsapp");
    // Open the tokens the test itself sealed to know which is which.
    const dead = new Set<string>();
    const fetchImpl: FetchLike = async (_url, init) => {
      const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
      if (token.startsWith("EAAB-messenger")) { dead.add(token); return graphError(400, 190); }
      return Response.json({ id: "1" });
    };
    const result = await runMetaTokenWatch({ fetchImpl });
    expect(result.marked).toBeGreaterThanOrEqual(1);
    const states = await view(clinic);
    expect(states.facebook.state).toBe("needs_reconnect");
    expect(states.whatsapp.state).toBe("connected");
    expect(dead.size).toBeGreaterThanOrEqual(1);

    // A blip marks nothing, and an already-dropped login is not asked about again.
    const second = await connect(clinic, "messenger");
    const blip: FetchLike = async () => graphError(503, 2);
    await runMetaTokenWatch({ fetchImpl: blip });
    expect((await view(clinic)).facebook.state).toBe("connected");
    void second;
  });

  test("Settings reads the same states: Meta not bought has no buttons, bought shows both", async () => {
    const clinic = await provisionPortalClinic("reconnect-settings", { plan: "voice-metachat-1000-1000" });
    const id = await connect(clinic, "instagram");
    markMetaConnectionBroken(clinic.clinicId, id, "token_invalid");
    await settleMetaMarks();
    const setup = (c: PortalClinic) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readSetupState(tx, { userId: c.userId }));
    const settings = await readSettingsView({ slug: clinic.clinicSlug, state: (await setup(clinic))!, actor: ACTOR });
    expect(settings.metaConnect?.facebook).toEqual({ state: "needs_reconnect", names: ["Instagram"] });
    expect(settings.metaConnect?.whatsapp.state).toBe("none");

    const voiceOnly = await provisionPortalClinic("reconnect-voice", { plan: "voice-1000" });
    expect(
      (await readSettingsView({ slug: voiceOnly.clinicSlug, state: (await setup(voiceOnly))!, actor: ACTOR })).metaConnect,
    ).toBeNull();
  });

  test("a swap of the connected asset is a replacement; a first connect and the same asset are not", async () => {
    const clinic = await provisionPortalClinic("reconnect-swap", { plan: "voice-metachat-1000-1000" });
    const db = (fn: (db: Parameters<typeof replacesConnectedAsset>[0]) => Promise<boolean>) =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => fn(tx.db));
    expect(await db((d) => replacesConnectedAsset(d, clinic.clinicId, [{ platform: "messenger", externalId: "111" }]))).toBe(false);
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      attachMetaChannel(tx, { platform: "messenger", externalId: "111", accessToken: "EAAB-x", via: "facebook_login" }),
    );
    expect(await db((d) => replacesConnectedAsset(d, clinic.clinicId, [{ platform: "messenger", externalId: "111" }]))).toBe(false);
    expect(await db((d) => replacesConnectedAsset(d, clinic.clinicId, [{ platform: "messenger", externalId: "222" }]))).toBe(true);
    expect(await db((d) => replacesConnectedAsset(d, clinic.clinicId, [{ platform: "whatsapp", externalId: "333" }]))).toBe(false);
  });

  test("a login that no longer returns Instagram retires a dead Instagram row, and leaves a live one", async () => {
    const clinic = await provisionPortalClinic("reconnect-retire", { plan: "voice-metachat-1000-1000" });
    const ig = await connect(clinic, "instagram");
    await connect(clinic, "messenger");
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => retireDroppedFacebookRows(tx, ["messenger"]));
    expect((await view(clinic)).facebook.names).toEqual(["Messenger", "Instagram"]);

    markMetaConnectionBroken(clinic.clinicId, ig, "token_invalid");
    await settleMetaMarks();
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => retireDroppedFacebookRows(tx, ["messenger"]));
    const after = await view(clinic);
    expect(after.facebook).toEqual({ state: "connected", names: ["Messenger"] });
  });

  test("a mark based on a token read before a reconnect does not mark the fresh login", async () => {
    const clinic = await provisionPortalClinic("reconnect-race", { plan: "voice-metachat-1000-1000" });
    const id = await connect(clinic, "messenger");
    const readAt = new Date(Date.now() - 60_000);
    const marked = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      markBrokenWithin(tx, id, "token_invalid", readAt),
    );
    expect(marked).toBe(false);
    expect((await view(clinic)).facebook.state).toBe("connected");
  });
});
