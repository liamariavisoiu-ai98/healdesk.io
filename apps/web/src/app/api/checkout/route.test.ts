import { META_SOLD_ALONE } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

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
  plan: "chat-web",
  contactName: "Alex Chen",
  contactEmail: "alex@example.com",
  phoneSystemType: "unknown",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
} as const;

/**
 * apps/app, as the purchase routes see it: the intent answers with a ref and
 * the success URL, and provisioning (the development path) with the clinic.
 */
async function appAnswers(url: URL | RequestInfo, _init?: RequestInit): Promise<Response> {
  const path = new URL(String(url)).pathname;
  const json =
    path === "/api/checkout/intents"
      ? {
          ref: "11111111-2222-4333-8444-555555555555",
          attempt: 1,
          previousOpenSessionId: null,
          successUrl: "http://localhost:3001/welcome?h=11111111-2222-4333-8444-555555555555&cs={CHECKOUT_SESSION_ID}",
        }
      : { clinicSlug: "radiance" };
  return new Response(JSON.stringify(json), { status: 201, headers: { "Content-Type": "application/json" } });
}

/** The bodies sent to one apps/app path, in order. */
function sentTo(mock: ReturnType<typeof vi.fn>, path: string): Record<string, unknown>[] {
  return mock.mock.calls
    .filter(([url]) => new URL(String(url)).pathname === path)
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, unknown>);
}

describe("POST /api/checkout validates the billing terms", () => {
  const fetchMock = vi.fn(appAnswers);

  /** The n-th purchase the route handed apps/app as a checkout intent. */
  function forwarded(call = 0): Record<string, unknown> {
    return sentTo(fetchMock, "/api/checkout/intents")[call]!;
  }

  beforeEach(() => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
    vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    // Open checkout: these blocks are about the order itself. The setup-link
    // gate in front of it has its own block below.
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
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

  test("a package id is required; a pricing card's id is not a package", async () => {
    // The browser resolves the "Web OR Meta" card to one of its two packages
    // before posting. A card id reaching the route is a stale page or a hand-
    // made request, and guessing which twin it meant would guess a channel.
    const card = await post({ ...VALID, plan: "chat-single" });
    expect(card.status).toBe(422);
    expect(((await card.json()) as { field: string }).field).toBe("plan");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("both Meta packages are on sale, Meta Chatbot included", async () => {
    // The catalog flag, opened by the owner on 5 October 2026. Closed again,
    // Meta Chatbot becomes a 422 with field "plan" before Stripe hears of it.
    expect(META_SOLD_ALONE).toBe(true);

    const alone = await post({ ...VALID, plan: "chat-meta" });
    expect(alone.status).toBe(201);
    expect(forwarded(0).plan).toBe("chat-meta");

    const withPhone = await post({ ...VALID, plan: "meta-voice" });
    expect(withPhone.status).toBe(201);
    expect(forwarded(1).plan).toBe("meta-voice");
  });

  test("a stray chat channel from an old page is dropped, never forwarded", async () => {
    // The package id alone says which channels a clinic has; a field beside it
    // could only ever disagree with it.
    const response = await post({ ...VALID, plan: "web-voice", chatChannelChoice: "meta" });
    expect(response.status).toBe(201);
    const sent = forwarded(0);
    expect(sent.chatChannelChoice).toBeUndefined();
    expect(sent.plan).toBe("web-voice");
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
  const fetchMock = vi.fn(appAnswers);

  beforeEach(() => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
    vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    // Open checkout: these blocks are about the order itself. The setup-link
    // gate in front of it has its own block below.
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
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

/**
 * While the purchase is by invitation (HEALDESK_CHECKOUT_MODE unset), only a
 * browser holding the latest setup link for an unpaid request may pay, and
 * only under the address the link was sent to. M1's done-when: missing,
 * forged, expired and used links are refused, before apps/app is called.
 */
describe("POST /api/checkout, while the purchase is by setup link", () => {
  const fetchMock = vi.fn(appAnswers);

  beforeEach(() => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
    vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    __setSheetsClientForTests(new FakeSheets());
    __resetSheetSchemaForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __setSheetsClientForTests(null);
    __resetSheetSchemaForTests();
  });

  /** A request an operator has sent a link to, `sentAt` ago by default now. */
  async function invite(email = "alex@example.com", sentAt = new Date()) {
    const created = await createSetupRequest({
      name: "Alex Chen",
      clinicName: "Radiance Med Spa",
      website: "radiancemedspa.com",
      email,
      channels: ["web"],
      leadId: null,
      ipAddress: null,
    });
    if (!created.ok) throw new Error("the fake Sheet refused a request");
    const expiresAt = setupLinkExpiry(sentAt);
    await updateSetupRequest(created.request.id, { status: "invited", invitedAt: sentAt, linkExpiresAt: expiresAt });
    return { id: created.request.id, token: issueSetupToken(created.request.id, email, expiresAt) };
  }

  function postWith(token: string | null, body: Record<string, unknown> = VALID): Promise<Response> {
    counter += 1;
    return POST(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `10.1.0.${counter}`,
          ...(token ? { cookie: `hd_setup=${encodeURIComponent(token)}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function refusal(response: Response) {
    return (await response.json()) as { error: string; field: string; link?: string };
  }

  test("a browser with no setup link is refused, whatever it sends", async () => {
    const response = await postWith(null);
    expect(response.status).toBe(403);
    expect(await refusal(response)).toMatchObject({ field: "setupLink", link: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a forged link is refused", async () => {
    const { token } = await invite();
    const forged = `${token.slice(0, -4)}AAAA`;
    const response = await postWith(forged);
    expect(response.status).toBe(403);
    expect((await refusal(response)).link).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an expired link is refused", async () => {
    const { token } = await invite("alex@example.com", new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));
    const response = await postWith(token);
    expect(response.status).toBe(403);
    expect((await refusal(response)).link).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a used link is refused once the request is paid", async () => {
    const { id, token } = await invite();
    await updateSetupRequest(id, { status: "paid", paidAt: new Date() });
    const response = await postWith(token);
    expect(response.status).toBe(409);
    expect((await refusal(response)).link).toBe("used");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a link replaced by a newer one is refused", async () => {
    const first = await invite();
    const later = new Date(Date.now() + 60_000);
    const expiresAt = setupLinkExpiry(later);
    await updateSetupRequest(first.id, { invitedAt: later, linkExpiresAt: expiresAt });
    const response = await postWith(first.token);
    expect(response.status).toBe(403);
    expect((await refusal(response)).link).toBe("replaced");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a valid link pays only under the address it was sent to, and the intent carries it", async () => {
    const { id, token } = await invite("Alex@Example.com");
    const other = await postWith(token, { ...VALID, contactEmail: "someone@else.com" });
    expect(other.status).toBe(422);
    expect((await refusal(other)).field).toBe("contactEmail");
    expect(fetchMock).not.toHaveBeenCalled();

    const own = await postWith(token, { ...VALID, contactEmail: "alex@example.com" });
    expect(own.status).toBe(201);
    const [intent] = sentTo(fetchMock, "/api/checkout/intents");
    expect(intent).toMatchObject({ inviteRef: id, contactEmail: "alex@example.com" });
    expect(intent!.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    // The development path provisions from that intent, as the webhook would.
    expect(sentTo(fetchMock, "/api/provision")).toEqual([
      { ref: "11111111-2222-4333-8444-555555555555", idempotencyKey: "dev:11111111-2222-4333-8444-555555555555" },
    ]);
  });
});
