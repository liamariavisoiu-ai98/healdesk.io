import { openDemoCallContext } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The personalised demo's browser call picks its engine on the server: AYA's
 * own (a sealed `demo_context`) when the engine agent is set and apps/app
 * answers, the Retell-hosted clinic agent exactly as before otherwise. The
 * visitor's first name rides along in the body, is cleaned, and is never a
 * reason to refuse the call.
 */

const SECRET = "test-provision-secret";
const SLUG = "peachy-studio-k7q2mz9xwa";

const appAnswers = vi.fn();
vi.mock("@/lib/admin/ops-client", () => ({ appAnswers: (...args: unknown[]) => appAnswers(...args) }));
/**
 * A minimal row by default, so every test but the offer's own keeps working
 * without a real demo row: `demoOfferFor` (lib/demo/offer.ts) catches what a
 * row this bare throws on and reports no discount, same as a real read that
 * came back short. `demoOfferEndsAt`/`demoSetupCredit` are the real
 * functions (spread from actual), so the one test that gives a full row
 * below exercises the real clock.
 */
let sessionOverride: Record<string, unknown> = { slug: SLUG, profile: true };
vi.mock("@/lib/demo/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/sessions")>()),
  isDemoSlug: () => true,
  getDemoSession: async () => sessionOverride,
  isDemoActive: () => true,
  profileOf: () => ({
    clinicName: "Peachy Studio",
    summary: "A med spa in Austin.",
    specialty: "med-spa",
    phone: "(512) 555-0100",
    address: "1 Congress Ave, Austin",
    hours: [{ days: "Mon-Fri", hours: "9am-5pm" }],
    hoursSource: "google",
    hoursPlace: "Peachy West SoHo",
    services: [{ name: "Botox", description: null, price: "$12/unit", duration: null }],
    providers: [],
    faqs: [],
    policies: [],
    booking: null,
    highlights: [],
  }),
}));

import { POST } from "./route";

const calls: { body: Record<string, unknown> }[] = [];
let ip = 0;

function post(body?: unknown | string) {
  return POST(
    new Request(`http://localhost/api/demo/${SLUG}/retell/v3/create-web-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${(ip += 1)}` },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: SLUG }) },
  );
}

function variables(): Record<string, string> {
  return calls[0]!.body.retell_llm_dynamic_variables as Record<string, string>;
}

beforeEach(() => {
  calls.length = 0;
  sessionOverride = { slug: SLUG, profile: true };
  appAnswers.mockReset().mockResolvedValue(true);
  vi.stubEnv("RETELL_API_KEY", "key_test");
  vi.stubEnv("RETELL_CLINIC_DEMO_AGENT_ID", "agent_clinic");
  vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "agent_engine");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ call_id: "call_1", access_token: "tok" }), { status: 201 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/demo/[slug]/retell/v3/create-web-call, the engine", () => {
  test("starts AYA's engine with a sealed context for this clinic, this mode and this name", async () => {
    const response = await post({ agent_id: "server-chosen", firstName: "Sam" });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.agent_id).toBe("agent_engine");
    expect(Object.keys(variables())).toEqual(["demo_context"]);

    const context = openDemoCallContext(variables().demo_context, SECRET);
    expect(context).not.toBeNull();
    expect(context!.mode).toBe("browser");
    expect(context!.slug).toBe(SLUG);
    expect(context!.firstName).toBe("Sam");
    expect(context!.clinic.clinicName).toBe("Peachy Studio");
    expect(context!.clinic.services[0]!.name).toBe("Botox");
    // Where the hours came from is the demo's own business, not the engine's.
    expect(JSON.stringify(context!.clinic)).not.toContain("SoHo");
    expect(calls[0]!.body.metadata).toMatchObject({ demo_slug: SLUG, engine: "aya" });
  });

  test("carries the demo's live setup discount, real and server-computed, never a made-up one", async () => {
    const readyAt = new Date("2026-10-24T12:00:00Z");
    sessionOverride = {
      slug: SLUG,
      profile: true,
      status: "ready",
      createdBy: "ops-operator@healdesk.io",
      createdAt: readyAt,
      readyAt,
      expiresAt: new Date(readyAt.getTime() + 7 * 24 * 60 * 60_000),
    };
    vi.useFakeTimers().setSystemTime(new Date(readyAt.getTime() + 10 * 60 * 60_000)); // 10 h in: still live
    try {
      await post({ firstName: "Sam" });
      const context = openDemoCallContext(variables().demo_context, SECRET, Date.now());
      // An operator-built demo (not "homepage"): the 50% credit, not the 30% self-serve one.
      expect(context!.offer).toEqual({ percentOfSetupFee: 50, endsAt: readyAt.getTime() + 48 * 60 * 60_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("carries no discount once it has ended", async () => {
    const readyAt = new Date("2026-10-20T12:00:00Z");
    sessionOverride = {
      slug: SLUG,
      profile: true,
      status: "ready",
      createdBy: "homepage",
      createdAt: readyAt,
      readyAt,
      expiresAt: new Date(readyAt.getTime() + 7 * 24 * 60 * 60_000),
    };
    vi.useFakeTimers().setSystemTime(new Date(readyAt.getTime() + 72 * 60 * 60_000)); // 72 h in: well past 48 h
    try {
      await post({ firstName: "Sam" });
      const context = openDemoCallContext(variables().demo_context, SECRET, Date.now());
      expect(context!.offer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not open with another secret", async () => {
    await post({ firstName: "Sam" });
    expect(openDemoCallContext(variables().demo_context, "another-secret")).toBeNull();
  });

  test("ignores a first name that is not a name, and still places the call", async () => {
    for (const bad of ["<b>x</b>", "Sam123", "Sam; drop table", 42, { a: 1 }, ""]) {
      calls.length = 0;
      const response = await post({ firstName: bad });
      expect(response.status).toBe(201);
      expect(openDemoCallContext(variables().demo_context, SECRET)!.firstName).toBeNull();
    }
  });

  test("keeps one word of a longer name, and starts with no name when there is no body", async () => {
    await post({ firstName: "Anna Maria" });
    expect(openDemoCallContext(variables().demo_context, SECRET)!.firstName).toBe("Anna");
    calls.length = 0;
    expect((await post()).status).toBe(201);
    expect(openDemoCallContext(variables().demo_context, SECRET)!.firstName).toBeNull();
    calls.length = 0;
    expect((await post("not json")).status).toBe(201);
    expect(calls[0]!.body.agent_id).toBe("agent_engine");
  });
});

describe("POST /api/demo/[slug]/retell/v3/create-web-call, the fallback", () => {
  test("is the clinic demo agent, as before, when the engine agent is not set", async () => {
    vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "");
    const response = await post({ firstName: "Sam" });
    expect(response.status).toBe(201);
    expect(calls[0]!.body.agent_id).toBe("agent_clinic");
    expect(variables().clinic_name).toBe("Peachy Studio");
    expect(variables().opening_line).toMatch(/AI assistant, and this call is transcribed/);
    expect(variables().demo_context).toBeUndefined();
    expect(calls[0]!.body.metadata).toEqual({ demo_slug: SLUG, source: "healdesk.io personalised demo" });
    expect(appAnswers).not.toHaveBeenCalled();
  });

  test("is the clinic demo agent when apps/app does not answer", async () => {
    appAnswers.mockResolvedValue(false);
    const response = await post({ firstName: "Sam" });
    expect(response.status).toBe(201);
    expect(calls[0]!.body.agent_id).toBe("agent_clinic");
    expect(variables().clinic_name).toBe("Peachy Studio");
    expect(variables().demo_context).toBeUndefined();
  });

  test("is the clinic demo agent without the provision secret, which sealing needs", async () => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    await post({ firstName: "Sam" });
    expect(calls[0]!.body.agent_id).toBe("agent_clinic");
  });
});
