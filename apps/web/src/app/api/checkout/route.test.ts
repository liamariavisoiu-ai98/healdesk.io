import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "./route";

/**
 * The checkout route's own validation, before Stripe or apps/app is involved.
 *
 * The interval and the chat-channel choice decide what the card is charged and
 * what provisioning enables, so a value the catalog does not know has to be
 * refused here, on both the paid and the unpaid path, and so does a checkout
 * with no signed agreement. These tests run the unpaid development path (no
 * STRIPE_SECRET_KEY, NODE_ENV "test") with `fetch` stubbed, so a request that
 * passes validation can be inspected on its way to apps/app without a server.
 * The last block pins that the same path is refused in production.
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

  test("refuses a checkout with no signed agreement before anything is created", async () => {
    // apps/app refuses the same thing at provisioning, but on the paid path
    // that is after the card was charged. The field name is what lets the form
    // send the buyer back to the signature step.
    const { agreementId: _unsigned, ...withoutAgreement } = VALID;
    const missing = await post(withoutAgreement);
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { field: string }).field).toBe("agreementId");

    const malformed = await post({ ...VALID, agreementId: "agr-123" });
    expect(malformed.status).toBe(422);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The unpaid development path must be unreachable on a production deployment.
 *
 * With STRIPE_SECRET_KEY unset, the paid path is skipped entirely, so the only
 * thing left for the route to do would be to provision an account nobody paid
 * for. Both variables that mark production are covered: NODE_ENV, which every
 * Vercel build sets (previews included), and VERCEL_ENV, in case a production
 * deployment ever runs under another NODE_ENV.
 */
describe("POST /api/checkout never provisions without payment in production", () => {
  const fetchMock = vi.fn(
    async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({ clinicSlug: "radiance" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
  );

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

  test("NODE_ENV=production with Stripe unconfigured answers 503 and never reaches apps/app", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await post(VALID);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Nothing has been charged/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("VERCEL_ENV=production is refused the same way under any NODE_ENV", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const response = await post(VALID);
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a preview deployment is refused too, because its build sets NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await post(VALID);
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
