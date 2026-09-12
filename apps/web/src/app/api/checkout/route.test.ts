import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "./route";

/**
 * The checkout route's own validation, before Stripe or apps/app is involved.
 *
 * The interval and the chat-channel choice decide what the card is charged and
 * what provisioning enables, so a value the catalog does not know has to be
 * refused here, on both the paid and the unpaid path. These tests run the
 * unpaid path (no STRIPE_SECRET_KEY) with `fetch` stubbed, so a request that
 * passes validation can be inspected on its way to apps/app without a server.
 */

let counter = 0;

/** A fresh client per request, so the route's hourly rate limit never trips. */
function post(body: Record<string, unknown>): Promise<Response> {
  counter += 1;
  return POST(
    new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `10.0.0.${counter}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = {
  clinicName: "Radiance Med Spa",
  specialty: "medspa",
  platform: "none",
  attributionMode: "estimated",
  averageTreatmentValueUsd: 550,
  plan: "chat-single",
  contactName: "Alex Chen",
  contactEmail: "alex@example.com",
  phoneSystemType: "unknown",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
} as const;

describe("POST /api/checkout validates the billing terms", () => {
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({ clinicSlug: "radiance" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
  );

  /** The body the route signed and forwarded on its n-th call to apps/app. */
  function forwarded(call = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[call]?.[1];
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
    vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("rejects an interval the catalog does not know", async () => {
    const response = await post({ ...VALID, interval: "week" });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; field: string };
    expect(body.field).toBe("interval");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects an interval of the wrong type", async () => {
    const response = await post({ ...VALID, interval: 12 });
    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown plan before anything else", async () => {
    const response = await post({ ...VALID, plan: "not-a-plan" });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { field: string };
    expect(body.field).toBe("plan");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a missing interval means monthly", async () => {
    const response = await post(VALID);
    expect(response.status).toBe(201);
    const sent = forwarded(0);
    expect(sent.billingInterval).toBe("month");
    expect(sent.interval).toBeUndefined();
  });

  test("annual is passed through under the name provisioning reads", async () => {
    const response = await post({ ...VALID, interval: "year" });
    expect(response.status).toBe(201);
    const sent = forwarded(0);
    expect(sent.billingInterval).toBe("year");
  });

  test("a Web OR Meta package validates the chat channel and defaults to web", async () => {
    const bad = await post({ ...VALID, chatChannelChoice: "sms" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { field: string }).field).toBe(
      "chatChannelChoice",
    );

    const defaulted = await post(VALID);
    expect(defaulted.status).toBe(201);
    const sent = forwarded(0);
    expect(sent.chatChannelChoice).toBe("web");

    const meta = await post({ ...VALID, chatChannelChoice: "meta" });
    expect(meta.status).toBe(201);
    const sentMeta = forwarded(1);
    expect(sentMeta.chatChannelChoice).toBe("meta");
  });

  test("a package without the choice drops a stray chat channel", async () => {
    const response = await post({
      ...VALID,
      plan: "complete",
      chatChannelChoice: "meta",
    });
    expect(response.status).toBe(201);
    const sent = forwarded(0);
    expect(sent.chatChannelChoice).toBeUndefined();
    expect(sent.plan).toBe("complete");
  });
});
