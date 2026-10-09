import { type ClinicProfile, META_SOLD_ALONE } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LEGAL_VERSION } from "@/lib/legal";
import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { POST } from "./route";

/**
 * The checkout route's own validation, before Stripe or apps/app is involved.
 *
 * The package and its interval decide what the card is charged and what
 * provisioning enables; the website rule decides whether web chat may be sold
 * at all; the booking system, the Google account and the website read decide
 * what setup starts from. So a value the catalog does not know is refused
 * here, on both the paid and the unpaid path, and so is a checkout with no
 * signed agreement or no ticked terms. These tests run the unpaid development
 * path (no STRIPE_SECRET_KEY, NODE_ENV "test") with `fetch` stubbed, so a
 * request that passes validation can be inspected on its way to apps/app
 * without a server. A later block pins that the same path is refused in
 * production.
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

/** What Review and pay posts for a clinic whose website could not be read. */
const VALID = {
  plan: "chat-web",
  clinicName: "Radiance Med Spa LLC",
  specialty: "med-spa",
  website: "radiancemedspa.com",
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  contactName: "Alex Chen",
  contactEmail: "alex@example.com",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
  covered: "no",
  profile: null,
  profileStatus: "failed",
  timezone: "America/Chicago",
  termsAccepted: true,
  termsVersion: LEGAL_VERSION,
} as const;

/** A read of radiancemedspa.com, as /api/clinic-site returns one. */
function readProfile(overrides: Partial<ClinicProfile> = {}): ClinicProfile {
  return {
    version: 1,
    website: "radiancemedspa.com",
    readAt: "2026-10-06T09:30:00.000Z",
    pages: 3,
    locations: [{ label: "Radiance Med Spa", address: "12 Main St, Austin, TX 78701", phone: null, hours: null }],
    services: [
      { name: "Signature facial", priceKind: "exact", priceUsd: 199, maxUsd: null, unit: null, durationMinutes: 60 },
    ],
    providers: [{ name: "Dr. Maya Patel", title: "Medical Director" }],
    policies: [],
    faqs: [],
    acceptsInsurance: "no",
    practiceKind: "med-spa",
    dropped: 0,
    ...overrides,
  };
}

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

  test("both Meta packages are on sale, AYA Meta Chat included", async () => {
    // The catalog flag, opened by the owner on 5 October 2026. Closed again,
    // AYA Meta Chat becomes a 422 with field "plan" before Stripe hears of it.
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

  test("a website-free package can be bought with no website, and the order says so", async () => {
    const response = await post({ ...VALID, plan: "voice", website: null, profileStatus: "none" });
    expect(response.status).toBe(201);
    expect(forwarded(0)).toMatchObject({ plan: "voice", website: null, profile: null, profileStatus: "none" });
  });

  test("website chat is never sold to a practice with no website", async () => {
    for (const plan of ["chat-web", "chat-dual", "web-voice", "complete"]) {
      const response = await post({ ...VALID, plan, website: null, profileStatus: "none" });
      expect(response.status, plan).toBe(422);
      expect(((await response.json()) as { field: string }).field, plan).toBe("plan");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the website must be answered: a website, or null for none", async () => {
    const { website: _unanswered, ...silent } = VALID;
    for (const body of [silent, { ...VALID, website: "radiance med spa" }, { ...VALID, website: 42 }]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { field: string }).field).toBe("website");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the booking system and the Google account must be answers the funnel offers", async () => {
    const system = await post({ ...VALID, bookingSystem: "zenoti" });
    expect(((await system.json()) as { field: string }).field).toBe("bookingSystem");
    const account = await post({ ...VALID, calendarAccount: "gmail" });
    expect(((await account.json()) as { field: string }).field).toBe("calendarAccount");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the practice's legal name is capped, and a specialty that cannot buy yet is refused", async () => {
    const long = await post({ ...VALID, clinicName: "A".repeat(121) });
    expect(((await long.json()) as { field: string }).field).toBe("clinicName");
    const vet = await post({ ...VALID, specialty: "veterinary" });
    expect(((await vet.json()) as { field: string }).field).toBe("specialty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the terms must be ticked, under the version this server publishes", async () => {
    const unticked = await post({ ...VALID, termsAccepted: false });
    expect(((await unticked.json()) as { field: string }).field).toBe("terms");
    const stale = await post({ ...VALID, termsVersion: "2026-10-01.1" });
    expect(((await stale.json()) as { field: string }).field).toBe("terms");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a website read rides on the purchase only when it parses and is of this very website", async () => {
    const read = await post({ ...VALID, profile: readProfile(), profileStatus: "read" });
    expect(read.status).toBe(201);
    expect(forwarded(0)).toMatchObject({ profileStatus: "read", profile: readProfile(), website: "radiancemedspa.com" });

    const refusals = [
      { profile: readProfile({ website: "otherspa.com" }), profileStatus: "read" },
      { profile: { ...readProfile(), injected: true }, profileStatus: "read" },
      { profile: null, profileStatus: "read" },
      { profile: readProfile(), profileStatus: "failed" },
      { profile: null, profileStatus: "none" },
      { profile: null, profileStatus: "unknown" },
    ];
    for (const overrides of refusals) {
      const response = await post({ ...VALID, ...overrides });
      expect(response.status, JSON.stringify(overrides.profileStatus)).toBe(422);
      expect(((await response.json()) as { field: string }).field).toBe("profile");
    }
    // No website, so no read: anything but "none" is refused.
    const noSite = await post({ ...VALID, plan: "voice", website: null, profileStatus: "failed" });
    expect(((await noSite.json()) as { field: string }).field).toBe("profile");
    expect(sentTo(fetchMock, "/api/checkout/intents")).toHaveLength(1);
  });

  test("only the allowlisted order reaches apps/app, with the platform derived from the booking system", async () => {
    const response = await post({
      ...VALID,
      bookingSystem: "mindbody",
      // None of these may travel: a client-chosen platform, a dedupe key,
      // the phase-two questions the funnel no longer asks, and anything new.
      platform: "zenoti",
      idempotencyKey: "replay-me",
      averageTreatmentValueUsd: 550,
      callRouting: "always",
      attributionMode: "verified",
      // The demo a buyer came from is read from its cookie, never the body.
      demo: "glow-med-spa",
      favouriteColour: "red",
    });
    expect(response.status).toBe(201);
    const sent = forwarded(0);
    expect(Object.keys(sent).sort()).toEqual(
      [
        "agreementId",
        "billingInterval",
        "bookingSystem",
        "calendarAccount",
        "clinicName",
        "contactEmail",
        "contactName",
        "inviteRef",
        "isCoveredEntity",
        "nonceHash",
        "plan",
        "platform",
        "profile",
        "profileStatus",
        "specialty",
        "terms",
        "timezone",
        "website",
      ].sort(),
    );
    expect(sent).toMatchObject({ platform: "mindbody", bookingSystem: "mindbody", calendarAccount: "workspace_baa" });
    expect((sent.terms as { version: string }).version).toBe(LEGAL_VERSION);
  });

  test("the covered-entity answer travels as the agreement records it, and must be given where it is asked", async () => {
    // apps/app matches it against the signed agreement before anyone pays.
    const answers = [
      ["yes", true],
      ["no", false],
      ["not_sure", null],
    ] as const;
    for (const [covered, recorded] of answers) {
      fetchMock.mockClear();
      expect((await post({ ...VALID, covered })).status, covered).toBe(201);
      expect(forwarded(0).isCoveredEntity, covered).toBe(recorded);
      expect(forwarded(0).covered, covered).toBeUndefined();
    }

    fetchMock.mockClear();
    const { covered: _unanswered, ...silent } = VALID;
    for (const body of [silent, { ...VALID, covered: "maybe" }, { ...VALID, covered: true }]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { field: string }).field).toBe("covered");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the browser's time zone is kept when it is one, and dropped when it is not", async () => {
    await post(VALID);
    expect(forwarded(0).timezone).toBe("America/Chicago");
    await post({ ...VALID, timezone: "Mars/Olympus" });
    expect(forwarded(1).timezone).toBeUndefined();
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
    // The development path provisions from that intent, as the webhook would,
    // naming the press of Pay and the terms it was for.
    expect(sentTo(fetchMock, "/api/provision")).toEqual([
      {
        ref: "11111111-2222-4333-8444-555555555555",
        idempotencyKey: "dev:11111111-2222-4333-8444-555555555555",
        attempt: 1,
        plan: "chat-web",
        billingInterval: "month",
      },
    ]);
  });
});
