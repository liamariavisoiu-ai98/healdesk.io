import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { attachMetaChannel } from "@/lib/meta/channels";
import { readMetaConnectView } from "@/lib/meta/reconnect";
import { publicOrigin } from "@/lib/public-url";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * POST /api/meta/whatsapp, the portal's branch: the signed-in session is the
 * authority (no link), the request must come from our own page, and swapping
 * the connected number for another asks for a passkey step-up. Meta itself is
 * faked at `prepareWhatsApp`; the database is real.
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
vi.mock("@/lib/meta/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/connect")>()),
  prepareWhatsApp: async () => ({
    ok: true,
    displayNumber: "+1 555 0100",
    channel: { platform: "whatsapp", externalId: session.number, accessToken: "EAAB-wa-not-real", label: "x" },
  }),
}));

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

describeDb("POST /api/meta/whatsapp from the portal", () => {
  let clinic: PortalClinic;
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
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    clinic: clinic.clinicSlug,
    code: "c",
    wabaId: "1",
    phoneNumberId: "2",
    ...extra,
  });
  const whatsapp = () =>
    withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readMetaConnectView(tx.db, tx.clinicId)).then((v) => v.whatsapp.state);

  test("a foreign or missing Origin is refused, and so is a signed-out browser", async () => {
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    expect((await POST(post(body(), { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post(body(), {}))).status).toBe(403);
    session.portal = null;
    const out = await POST(post(body()));
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ ok: false, error: "signed_out" });
    expect(await whatsapp()).toBe("none");
  });

  test("a first connect needs no step-up; the same number again needs none; a different number does, and says where to go", async () => {
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    const first = await POST(post(body()));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });
    expect(await whatsapp()).toBe("connected");

    expect((await POST(post(body()))).status).toBe(200);

    session.number = "100000000000002";
    const swap = await POST(post(body({ from: "settings" })));
    expect(swap.status).toBe(403);
    const refused = (await swap.json()) as { error: string; stepUpHref: string };
    expect(refused.error).toBe("needs_step_up");
    expect(refused.stepUpHref).toBe(
      `/c/${clinic.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${clinic.clinicSlug}/whatsapp?from=settings`)}`,
    );
    // Nothing changed: the first number is still the one connected.
    expect(await POST(post(body())).then((r) => r.status)).toBe(403);

    session.steppedUp = true;
    expect((await POST(post(body()))).status).toBe(200);
  });

  test("a reconnect clears a dropped mark", async () => {
    // A clinic of its own: the attempt limit is per clinic and address.
    clinic = await provisionPortalClinic("wa-route-2", { plan: "voice-metachat-1000-1000" });
    session.portal = { userId: clinic.userId, clinicId: clinic.clinicId, clinicSlug: clinic.clinicSlug };
    const { POST } = await import("@/app/api/meta/whatsapp/route");
    const { markMetaConnectionBroken, settleMetaMarks } = await import("@/lib/meta/reconnect");
    session.steppedUp = true;
    await POST(post(body()));
    const id = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      attachMetaChannel(tx, { platform: "whatsapp", externalId: session.number, accessToken: "EAAB-wa-not-real" }),
    );
    markMetaConnectionBroken(clinic.clinicId, id, "token_invalid");
    await settleMetaMarks();
    expect(await whatsapp()).toBe("needs_reconnect");
    expect((await POST(post(body()))).status).toBe(200);
    expect(await whatsapp()).toBe("connected");
  });
});
