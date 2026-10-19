import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { issueConnectionLink } from "@/lib/connections/links";
import { readMetaConnectView } from "@/lib/meta/reconnect";
import { publicOrigin } from "@/lib/public-url";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * POST /api/meta/whatsapp: the portal's branch, where the signed-in session
 * is the authority (no link), the request must come from our own page, and
 * swapping the connected number for another asks for a passkey step-up
 * before Meta is called; and both branches' reconnect of the same number.
 *
 * Meta is a fake Graph behind the global fetch, so the real prepareWhatsApp
 * runs. Its /register keeps the first PIN a number is registered with and
 * refuses any other, as Meta does once two-step verification is on (error
 * 133005). The database is real.
 */

const session = vi.hoisted(() => ({
  portal: null as null | { userId: string; clinicId: string; clinicSlug: string },
  steppedUp: false,
  number: "100000000000001",
}));

vi.mock("@/lib/portal/access", () => ({ portalOrNull: async () => session.portal }));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "Front desk Mac", steppedUp: session.steppedUp }),
}));

/** What the fake Graph was asked, and each number's two-step PIN once registered. */
let graphCalls: string[];
let pins: Map<string, string>;

async function fakeGraph(url: string, init?: RequestInit): Promise<Response> {
  const { pathname, searchParams } = new URL(url);
  graphCalls.push(pathname);
  if (pathname.endsWith("/oauth/access_token")) return Response.json({ access_token: "EAAB-wa-not-real" });
  if (pathname.endsWith("/subscribed_apps")) return Response.json({ success: true });
  const register = /\/(\d+)\/register$/.exec(pathname);
  if (register) {
    const { pin } = JSON.parse(String(init?.body)) as { pin: string };
    const held = pins.get(register[1]!);
    if (held !== undefined && held !== pin) {
      return Response.json({ error: { message: "Two-step verification PIN mismatch.", code: 133005 } }, { status: 400 });
    }
    pins.set(register[1]!, pin);
    return Response.json({ success: true });
  }
  if (searchParams.get("fields") === "display_phone_number") return Response.json({ display_phone_number: "+1 555 0100" });
  return Response.json({ error: { message: "Not faked.", code: 100 } }, { status: 400 });
}

const ACTOR = { type: "service", serviceName: "meta-whatsapp-route-test" } as const;
const describeDb = hasTestDatabase ? describe : describe.skip;

function post(body: Record<string, unknown>, headers: Record<string, string> = { origin: publicOrigin() }): Request {
  return new Request("https://app.healdesk.test/api/meta/whatsapp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "user-agent": "vitest", ...headers },
  });
}

describe("the route exists", () => {
  test("it exports POST, so a truncated file cannot ship unnoticed", async () => {
    const route = await import("@/app/api/meta/whatsapp/route");
    expect(typeof route.POST).toBe("function");
  });
});

describeDb("POST /api/meta/whatsapp", () => {
  let clinic: PortalClinic;
  const signIn = (c: PortalClinic) => {
    clinic = c;
    session.portal = { userId: c.userId, clinicId: c.clinicId, clinicSlug: c.clinicSlug };
  };
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("wa-route", { plan: "voice-metachat-1000-1000" });
  }, 180_000);
  afterAll(async () => {
    await closePools();
  });
  beforeEach(() => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "meta-secret";
    session.portal = { userId: clinic.userId, clinicId: clinic.clinicId, clinicSlug: clinic.clinicSlug };
    session.steppedUp = false;
    session.number = "100000000000001";
    graphCalls = [];
    pins = new Map();
    vi.stubGlobal("fetch", fakeGraph);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    clinic: clinic.clinicSlug,
    code: "c",
    wabaId: "1",
    phoneNumberId: session.number,
    ...extra,
  });
  const whatsapp = () =>
    withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readMetaConnectView(tx.db, tx.clinicId)).then((v) => v.whatsapp.state);
  const connected = () =>
    inTenant(clinic.clinicId, async (c) =>
      (
        await c.query<{ id: string; number: string }>(
          `select id, metadata->>'externalId' as number from provider_connections where provider = 'meta-whatsapp'`,
        )
      ).rows,
    );

  test("a foreign or missing Origin is refused, and so is a signed-out browser", async () => {
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    expect((await POST(post(body(), { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post(body(), {}))).status).toBe(403);
    session.portal = null;
    const out = await POST(post(body()));
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ ok: false, error: "signed_out" });
    expect(await whatsapp()).toBe("none");
    expect(graphCalls).toEqual([]);
  });

  test("a first connect needs no step-up; the same number again re-registers under its own PIN; a different number asks for the step-up before Meta is called", async () => {
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    const first = await POST(post(body()));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });
    expect(await whatsapp()).toBe("connected");
    const pin = pins.get(session.number);
    expect(pin).toMatch(/^\d{6}$/);

    // A fresh PIN here would be refused: the stored one is sent again.
    const again = await POST(post(body()));
    expect(await again.json()).toMatchObject({ ok: true });
    expect(pins.get(session.number)).toBe(pin);

    session.number = "100000000000002";
    const asked = graphCalls.length;
    const swap = await POST(post(body({ from: "settings" })));
    expect(swap.status).toBe(403);
    const refused = (await swap.json()) as { error: string; stepUpHref: string };
    expect(refused.error).toBe("needs_step_up");
    expect(refused.stepUpHref).toBe(
      `/c/${clinic.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${clinic.clinicSlug}/whatsapp?from=settings`)}`,
    );
    // Refused before Meta: the code is unspent and the new number unregistered.
    expect(graphCalls.length).toBe(asked);
    expect(pins.has(session.number)).toBe(false);
    // Nothing changed: the first number is still the one connected.
    expect(await POST(post(body())).then((r) => r.status)).toBe(403);
    expect((await connected()).map((r) => r.number)).toEqual(["100000000000001"]);

    // Stepped up, the new number registers for the first time, so it works.
    session.steppedUp = true;
    const swapped = await POST(post(body()));
    expect(await swapped.json()).toMatchObject({ ok: true });
    expect((await connected()).map((r) => r.number)).toEqual(["100000000000002"]);
  });

  test("a malformed number is refused before anything is asked", async () => {
    signIn(await provisionPortalClinic("wa-route-shape", { plan: "voice-metachat-1000-1000" }));
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    const out = await POST(post(body({ phoneNumberId: "../me" })));
    expect(out.status).toBe(400);
    expect(await out.json()).toMatchObject({ ok: false, error: "bad_request" });
    expect(graphCalls).toEqual([]);
  });

  test("a reconnect after Meta dropped the login re-registers under the stored PIN and clears the mark", async () => {
    // A clinic of its own: the attempt limit is per clinic and address.
    signIn(await provisionPortalClinic("wa-route-2", { plan: "voice-metachat-1000-1000" }));
    session.number = "100000000000008";
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    const { markMetaConnectionBroken, settleMetaMarks } = await import("@/lib/meta/reconnect");
    expect((await POST(post(body()))).status).toBe(200);
    const [row] = await connected();
    markMetaConnectionBroken(clinic.clinicId, row!.id, "token_invalid");
    await settleMetaMarks();
    expect(await whatsapp()).toBe("needs_reconnect");

    const reconnect = await POST(post(body()));
    expect(await reconnect.json()).toMatchObject({ ok: true });
    expect(await whatsapp()).toBe("connected");
  });

  test("a mailed link's sign-up of the number already connected re-registers under the stored PIN", async () => {
    signIn(await provisionPortalClinic("wa-route-link", { plan: "voice-metachat-1000-1000" }));
    // One number, one clinic: a number another test's clinic holds is refused.
    session.number = "100000000000009";
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    expect((await POST(post(body()))).status).toBe(200);
    const pin = pins.get(session.number);

    const link = await issueConnectionLink(clinic.clinicId, { purpose: "whatsapp", expiresInDays: 1 }, { actor: ACTOR });
    const out = await POST(post({ token: link.token, code: "c", wabaId: "1", phoneNumberId: session.number }));
    expect(await out.json()).toMatchObject({ ok: true });
    expect(pins.get(session.number)).toBe(pin);
  });
});
