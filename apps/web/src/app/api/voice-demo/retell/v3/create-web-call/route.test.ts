import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "./route";

/**
 * The homepage's browser call spends voice minutes on our Retell account, so
 * it must be off without its key and agent, must build the call itself
 * whatever the browser sends, and must stop at its per-IP limit.
 */

const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
let ip = 0;

function post(body: unknown = {}, from = `203.0.113.${(ip += 1)}`) {
  return POST(
    new Request("http://localhost/api/voice-demo/retell/v3/create-web-call", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("RETELL_API_KEY", "key_test");
  vi.stubEnv("RETELL_DEMO_INBOUND_AGENT_ID", "agent_aya_inbound");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ call_id: "call_1", access_token: "tok" }), { status: 201 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/voice-demo/retell/v3/create-web-call", () => {
  test("is off, without asking Retell, when the key or the agent is missing", async () => {
    vi.stubEnv("RETELL_DEMO_INBOUND_AGENT_ID", "");
    const response = await post();
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("creates the call for AYA's inbound agent, whatever the browser asked for", async () => {
    const response = await post({ agent_id: "agent_somebody_else", metadata: { x: "y" } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ call_id: "call_1", access_token: "tok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.retellai.com/v3/create-web-call");
    expect(calls[0]!.auth).toBe("Bearer key_test");
    expect(calls[0]!.body.agent_id).toBe("agent_aya_inbound");
    expect(calls[0]!.body.metadata).toEqual({ source: "healdesk.io homepage demo" });
  });

  test("stops one visitor at the per-IP limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post({}, "198.51.100.7")).status);
    expect(statuses.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(statuses[6]).toBe(429);
    expect(calls).toHaveLength(6);
  });

  test("tells the visitor nothing about why Retell refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("insufficient balance on acct_123", { status: 402 })));
    const response = await post();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("acct_123");
  });
});
