import { openDemoCallContext } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * "Have AYA call me" on a personalised demo hands the call to AYA's own
 * engine, with the name the visitor gave, when the engine agent is set and
 * apps/app answers; otherwise to the clinic demo agent exactly as before.
 * The consent, volume and shape checks in front of the dial are the route's
 * own and are not under test here beyond reaching them.
 */

const SECRET = "test-provision-secret";
const SLUG = "peachy-studio-k7q2mz9xwa";

const appAnswers = vi.fn();
vi.mock("@/lib/admin/ops-client", () => ({ appAnswers: (...args: unknown[]) => appAnswers(...args) }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => null }));
vi.mock("@/lib/leads", () => ({
  recordCallConsent: async () => "consent_1",
  markCallPlaced: async () => {},
}));
vi.mock("@/lib/demo/sessions", () => ({
  isDemoSlug: () => true,
  getDemoSession: async () => ({ slug: SLUG, profile: true }),
  isDemoActive: () => true,
  profileOf: () => ({
    clinicName: "Peachy Studio",
    summary: null,
    specialty: null,
    phone: null,
    address: null,
    hours: [],
    hoursSource: null,
    hoursPlace: null,
    services: [{ name: "Botox", description: null, price: "$12/unit", duration: null }],
    providers: [],
    faqs: [],
    policies: [],
    booking: null,
    highlights: [],
  }),
}));

import { CALL_CONSENT } from "@/lib/consent";

import { POST } from "./route";

const calls: { url: string; body: Record<string, unknown> }[] = [];
let ip = 0;
let number = 0;

function post(extra: Record<string, unknown> = {}) {
  return POST(
    new Request("http://localhost/api/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `192.0.2.${(ip += 1)}` },
      body: JSON.stringify({
        phone: `+1212867${String(1000 + (number += 1))}`,
        consent: true,
        consentVersion: CALL_CONSENT.version,
        demoSlug: SLUG,
        ...extra,
      }),
    }),
  );
}

function variables(): Record<string, string> {
  return calls[0]!.body.retell_llm_dynamic_variables as Record<string, string>;
}

beforeEach(() => {
  calls.length = 0;
  appAnswers.mockReset().mockResolvedValue(true);
  vi.stubEnv("RETELL_API_KEY", "key_test");
  vi.stubEnv("RETELL_CLINIC_DEMO_AGENT_ID", "agent_clinic");
  vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "agent_engine");
  vi.stubEnv("RETELL_DEMO_FROM_NUMBER", "+18885550100");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ call_id: "call_1" }), { status: 201 });
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/callback on a personalised demo", () => {
  test("rings through AYA's engine with the name the visitor gave", async () => {
    const response = await post({ name: "Sam Lee" });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.retellai.com/v2/create-phone-call");
    expect(calls[0]!.body.override_agent_id).toBe("agent_engine");
    expect(calls[0]!.body.honor_internal_dnc).toBe(true);
    expect(Object.keys(variables())).toEqual(["demo_context"]);

    const context = openDemoCallContext(variables().demo_context, SECRET);
    expect(context).toMatchObject({ mode: "phone", slug: SLUG, firstName: "Sam", test: false });
    expect(context!.clinic.clinicName).toBe("Peachy Studio");
  });

  test("rings with no name when the one given is not a name", async () => {
    expect((await post({ name: "<script>" })).status).toBe(200);
    expect(openDemoCallContext(variables().demo_context, SECRET)!.firstName).toBeNull();
  });

  test("falls back to the clinic demo agent, greeting by name as before, when the engine agent is not set", async () => {
    vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "");
    expect((await post({ name: "Sam Lee" })).status).toBe(200);
    expect(calls[0]!.body.override_agent_id).toBe("agent_clinic");
    expect(variables().opening_line).toMatch(/^Hello Sam, this is Peachy Studio's AI assistant/);
    expect(variables().demo_context).toBeUndefined();
  });

  test("falls back to the clinic demo agent when apps/app does not answer", async () => {
    appAnswers.mockResolvedValue(false);
    expect((await post({ name: "Sam" })).status).toBe(200);
    expect(calls[0]!.body.override_agent_id).toBe("agent_clinic");
    expect(variables().clinic_name).toBe("Peachy Studio");
  });

  test("never asks the engine about a call that is not for a personalised demo", async () => {
    vi.stubEnv("RETELL_DEMO_AGENT_ID", "agent_aya");
    expect((await post({ demoSlug: undefined, name: "Sam" })).status).toBe(200);
    expect(calls[0]!.body.override_agent_id).toBe("agent_aya");
    expect(appAnswers).not.toHaveBeenCalled();
  });
});
