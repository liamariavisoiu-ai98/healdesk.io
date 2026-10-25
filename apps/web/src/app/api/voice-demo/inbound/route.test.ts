import { createHmac } from "node:crypto";

import { openDemoCallContext } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The demo line's inbound webhook decides who answers a real phone call, so
 * it must never steal a call it cannot vouch for: an unsigned request, an
 * unknown caller or an unreadable register all get the empty answer, and the
 * number's own agent (AYA) picks up as it always has.
 */

const findActiveDemoByCaller = vi.fn();
vi.mock("@/lib/demo/sessions", () => ({
  isSelfServeDemo: () => false,
  findActiveDemoByCaller: (...args: unknown[]) => findActiveDemoByCaller(...args),
  profileOf: (s: { profile: unknown }) => (s.profile ? { clinicName: "Peachy Studio", services: [], hours: [], providers: [], faqs: [], policies: [], highlights: [], summary: null, specialty: null, phone: null, address: null, booking: null } : null),
}));

const appAnswers = vi.fn();
vi.mock("@/lib/admin/ops-client", () => ({ appAnswers: (...args: unknown[]) => appAnswers(...args) }));

const KEY = "key_test_123";

function signed(body: unknown, key = KEY) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const digest = createHmac("sha256", key).update(raw + ts).digest("hex");
  return new Request("https://healdesk.io/api/voice-demo/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Retell-Signature": `v=${ts},d=${digest}` },
    body: raw,
  });
}

const CALL = { event: "call_inbound", call_inbound: { from_number: "+15127841234", to_number: "+18885550100" } };

describe("POST /api/voice-demo/inbound", () => {
  beforeEach(() => {
    vi.resetModules();
    findActiveDemoByCaller.mockReset();
    appAnswers.mockReset().mockResolvedValue(true);
    vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "");
    vi.stubEnv("RETELL_API_KEY", KEY);
    vi.stubEnv("RETELL_WEBHOOK_KEY", "");
    vi.stubEnv("RETELL_CLINIC_DEMO_AGENT_ID", "agent_clinic");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets AYA answer when the signature does not verify", async () => {
    const { POST } = await import("./route");
    const response = await POST(signed(CALL, "wrong-key"));
    expect(await response.json()).toEqual({ call_inbound: {} });
    expect(findActiveDemoByCaller).not.toHaveBeenCalled();
  });

  it("lets AYA answer a caller with no live demo", async () => {
    findActiveDemoByCaller.mockResolvedValue(null);
    const { POST } = await import("./route");
    expect(await (await POST(signed(CALL))).json()).toEqual({ call_inbound: {} });
    expect(findActiveDemoByCaller).toHaveBeenCalledWith("+15127841234");
  });

  it("lets AYA answer when the register cannot be read", async () => {
    findActiveDemoByCaller.mockRejectedValue(new Error("sheet down"));
    const { POST } = await import("./route");
    expect(await (await POST(signed(CALL))).json()).toEqual({ call_inbound: {} });
  });

  it("answers as the clinic for a registered caller, opening with the disclosure", async () => {
    findActiveDemoByCaller.mockResolvedValue({ slug: "peachy-studio-k7q2mz9xwa", profile: {} });
    const { POST } = await import("./route");
    const body = (await (await POST(signed(CALL))).json()) as {
      call_inbound: { override_agent_id: string; dynamic_variables: Record<string, string>; metadata: Record<string, string> };
    };
    expect(body.call_inbound.override_agent_id).toBe("agent_clinic");
    expect(body.call_inbound.dynamic_variables.clinic_name).toBe("Peachy Studio");
    expect(body.call_inbound.dynamic_variables.opening_line).toMatch(/AI assistant, and this call is transcribed/);
    expect(body.call_inbound.metadata.demo_slug).toBe("peachy-studio-k7q2mz9xwa");
  });

  describe("with the demo engine agent set", () => {
    type Answer = {
      call_inbound: { override_agent_id: string; dynamic_variables: Record<string, string>; metadata: Record<string, string> };
    };

    beforeEach(() => {
      vi.stubEnv("RETELL_DEMO_ENGINE_AGENT_ID", "agent_engine");
      vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
      findActiveDemoByCaller.mockResolvedValue({ slug: "peachy-studio-k7q2mz9xwa", profile: {} });
    });

    it("answers on AYA's engine in inbound mode, with no name, for a registered caller", async () => {
      const { POST } = await import("./route");
      const body = (await (await POST(signed(CALL))).json()) as Answer;
      expect(body.call_inbound.override_agent_id).toBe("agent_engine");
      expect(Object.keys(body.call_inbound.dynamic_variables)).toEqual(["demo_context"]);
      const context = openDemoCallContext(body.call_inbound.dynamic_variables.demo_context, "test-provision-secret");
      expect(context).toMatchObject({ mode: "inbound", slug: "peachy-studio-k7q2mz9xwa", firstName: null });
      expect(context!.clinic.clinicName).toBe("Peachy Studio");
      expect(body.call_inbound.metadata.demo_slug).toBe("peachy-studio-k7q2mz9xwa");
    });

    it("answers on the clinic demo agent, as before, when apps/app does not answer", async () => {
      appAnswers.mockResolvedValue(false);
      const { POST } = await import("./route");
      const body = (await (await POST(signed(CALL))).json()) as Answer;
      expect(body.call_inbound.override_agent_id).toBe("agent_clinic");
      expect(body.call_inbound.dynamic_variables.clinic_name).toBe("Peachy Studio");
      expect(body.call_inbound.dynamic_variables.demo_context).toBeUndefined();
    });

    it("does not ask whether apps/app answers for a caller who is no demo's", async () => {
      findActiveDemoByCaller.mockResolvedValue(null);
      const { POST } = await import("./route");
      expect(await (await POST(signed(CALL))).json()).toEqual({ call_inbound: {} });
      expect(appAnswers).not.toHaveBeenCalled();
    });
  });
});
