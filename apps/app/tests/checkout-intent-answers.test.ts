import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BAA_ASSENT_LABEL,
  type BookingSystemId,
  type CalendarAccount,
  type ClinicProfile,
  CURRENT_BAA_VERSION,
  SIGNATURE_HEADER,
  sign,
  TIMESTAMP_HEADER,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as postIntent } from "@/app/api/checkout/intents/route";
import { signAgreement } from "@/lib/agreements";
import { IntentError, validateIntentRequest } from "@/lib/checkout/intents";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * The four-step funnel's answers on a checkout intent (plan Part A3 and A4):
 * where bookings live and which Google account, the website or none, and the
 * read of that website. apps/web checks them before it asks; this checks them
 * again, because a browser carried them, and stores them for provisioning and
 * setup: the answers in the payload, the read in its own column.
 */

const SECRET = "checkout-intent-answers-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

const describeDb = hasTestDatabase ? describe : describe.skip;

function profile(overrides: Partial<ClinicProfile> = {}): ClinicProfile {
  return {
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-10-06T09:30:00.000Z",
    pages: 4,
    locations: [
      { label: "Glow Med Spa", address: "12 Main St, Austin, TX 78701", phone: null, hours: null },
    ],
    services: [
      {
        name: "Signature facial",
        priceKind: "exact",
        priceUsd: 199,
        maxUsd: null,
        unit: null,
        durationMinutes: 60,
      },
    ],
    providers: [{ name: "Dr. Maya Patel", title: "Medical Director" }],
    policies: ["A $50 deposit holds your appointment."],
    faqs: [],
    acceptsInsurance: "no",
    practiceKind: "med-spa",
    dropped: 0,
    ...overrides,
  };
}

/** A purchase as the four-step funnel sends it, before the agreement id is known. */
function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // As the agreement signedOrder signs names it, with its covered answer.
    clinicName: "Glow Med Spa LLC",
    specialty: "med-spa",
    platform: "none",
    plan: "voice-webchat-500-300",
    billingInterval: "month",
    contactName: "Laura Owner",
    contactEmail: "info@glowspa.test",
    agreementId: randomUUID(),
    isCoveredEntity: false,
    bookingSystem: "calendly",
    calendarAccount: "workspace_baa",
    website: "glowmedspa.com",
    timezone: "America/Chicago",
    inviteRef: null,
    nonceHash: createHash("sha256").update(randomBytes(24)).digest("hex"),
    profile: profile(),
    profileStatus: "read",
    terms: { version: "2026-10-07.1", acceptedAt: new Date().toISOString(), ip: null },
    ...overrides,
  };
}

function refusal(body: Record<string, unknown>): string | undefined {
  try {
    validateIntentRequest(body);
  } catch (error) {
    if (error instanceof IntentError) return error.field;
    throw error;
  }
  return undefined;
}

describe("the funnel's answers, validated", () => {
  test("a whole order passes, with its read", () => {
    const valid = validateIntentRequest(order());
    expect(valid).toMatchObject({
      bookingSystem: "calendly",
      calendarAccount: "workspace_baa",
      website: "glowmedspa.com",
    });
    expect(valid.profile).toEqual(profile());
  });

  test("an order from before the funnel asked still passes", () => {
    const {
      bookingSystem: _b,
      calendarAccount: _c,
      website: _w,
      ...older
    } = order({
      profile: null,
      profileStatus: "none",
    });
    expect(refusal(older)).toBeUndefined();
  });

  test("the booking system and the Google account are answers the funnel offers, and come together", () => {
    expect(refusal(order({ bookingSystem: "zenoti" }))).toBe("bookingSystem");
    expect(refusal(order({ calendarAccount: "gmail" }))).toBe("calendarAccount");
    expect(refusal(order({ calendarAccount: undefined }))).toBe("calendarAccount");
    expect(refusal(order({ bookingSystem: undefined }))).toBe("bookingSystem");
  });

  test("the agreement's platform is the one the booking system implies", () => {
    expect(refusal(order({ bookingSystem: "mindbody", platform: "none" }))).toBe("platform");
    expect(refusal(order({ bookingSystem: "calendly", platform: "calcom" }))).toBe("platform");
    expect(refusal(order({ bookingSystem: "mindbody", platform: "mindbody" }))).toBeUndefined();
  });

  test("Web Chat is never sold to a practice with no website; Meta Chat needs none", () => {
    for (const plan of ["webchat-300", "webchat-1500", "voice-webchat-500-300"]) {
      expect(
        refusal(order({ plan, website: null, profile: null, profileStatus: "none" })),
        plan,
      ).toBe("plan");
    }
    for (const plan of ["voice-500", "metachat-300", "voice-metachat-500-300"]) {
      expect(
        refusal(order({ plan, website: null, profile: null, profileStatus: "none" })),
        plan,
      ).toBeUndefined();
    }
  });

  test("a website is the cleaned one, or null", () => {
    expect(refusal(order({ website: "glow med spa" }))).toBe("website");
    expect(
      refusal(
        order({ website: "https://glowmedspa.com/", profile: null, profileStatus: "failed" }),
      ),
    ).toBe("website");
    expect(refusal(order({ website: 42 }))).toBe("website");
  });

  test("a read rides only on the website it read, and only as a read", () => {
    expect(refusal(order({ profile: profile({ website: "otherspa.com" }) }))).toBe("profile");
    expect(refusal(order({ profile: { ...profile(), extra: true } }))).toBe("profile");
    expect(refusal(order({ profile: null }))).toBe("profile");
    expect(refusal(order({ profileStatus: "failed" }))).toBe("profile");
    expect(refusal(order({ profile: null, profileStatus: "none" }))).toBe("profileStatus");
    expect(
      refusal(order({ plan: "voice-500", website: null, profile: null, profileStatus: "failed" })),
    ).toBe("profileStatus");
    expect(refusal(order({ profile: null, profileStatus: "failed" }))).toBeUndefined();
  });

  test("the read is screened again under the specialty bought, never the one the site looked like", () => {
    // Screened in apps/web as a veterinary site, where a service's name is
    // checked only for claims; bought as a med spa, where it is checked in full.
    const asVet = profile({
      practiceKind: "veterinary",
      services: [
        ...profile().services,
        {
          name: "Allergy testing",
          priceKind: null,
          priceUsd: null,
          maxUsd: null,
          unit: null,
          durationMinutes: null,
        },
      ],
    });
    const valid = validateIntentRequest(order({ profile: asVet }));
    expect(valid.profile?.services.map((s) => s.name)).toEqual(["Signature facial"]);
    expect(valid.profile?.dropped).toBe(1);
  });

  test("a practice with no agreement to sign cannot buy", () => {
    expect(refusal(order({ specialty: "veterinary" }))).toBe("specialty");
  });

  test("a plan is a package at steps on the grid; the seven packages of 5 October are refused", () => {
    for (const plan of ["voice-100", "metachat-1500", "voice-metachat-1500-100"]) {
      expect(refusal(order({ plan })), plan).toBeUndefined();
    }
    for (const plan of [
      "chat-web",
      "chat-meta",
      "chat-dual",
      "voice",
      "web-voice",
      "meta-voice",
      "complete",
      "voice-150",
      "voice-1600",
      "voice-webchat-500",
      "webchat-300-300",
    ]) {
      expect(refusal(order({ plan })), plan).toBe("plan");
    }
  });

  test("Meta Chat is sold on its own, with no website", () => {
    // The Meta-alone flag went with the chat-channel choice (owner, 13 October
    // 2026): Meta Chat is a product that includes website chat, never Meta alone.
    const metaChat = order({ plan: "metachat-300", website: null, profile: null, profileStatus: "none" });
    expect(refusal(metaChat)).toBeUndefined();
  });
});

describeDb("the funnel's answers, stored", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return new Request("http://app.test/api/checkout/intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
      },
      body: raw,
    });
  }

  async function signedOrder(overrides: Record<string, unknown> = {}) {
    const email = `info-${randomUUID().slice(0, 8)}@glowspa.test`;
    const agreement = await signAgreement({
      clinicLegalName: "Glow Med Spa LLC",
      specialty: "med-spa",
      signatoryName: "Laura Owner",
      signatoryTitle: "Owner",
      signatoryEmail: email,
      isCoveredEntity: false,
      attributionMode: "estimated",
      platform: (overrides.platform as string | undefined) ?? "none",
      // BAA 1.3.0, the current version, reads both answers the order carries.
      bookingSystem: (overrides.bookingSystem as BookingSystemId | undefined) ?? "calendly",
      calendarAccount: (overrides.calendarAccount as CalendarAccount | undefined) ?? "workspace_baa",
      assentLabel: BAA_ASSENT_LABEL,
      templateVersion: CURRENT_BAA_VERSION,
    });
    return order({ contactEmail: email, agreementId: agreement.agreementId, ...overrides });
  }

  test("the answers go into the payload and the screened read into its own column", async () => {
    const asVet = profile({
      practiceKind: "veterinary",
      services: [
        ...profile().services,
        {
          name: "Allergy testing",
          priceKind: null,
          priceUsd: null,
          maxUsd: null,
          unit: null,
          durationMinutes: null,
        },
      ],
    });
    const response = await postIntent(signed(await signedOrder({ profile: asVet })));
    expect(response.status).toBe(201);

    const { rows } = await getMigratorPool().query(
      `select payload, profile, profile_status from checkout_intents`,
    );
    expect(rows[0]!.payload).toMatchObject({
      bookingSystem: "calendly",
      calendarAccount: "workspace_baa",
      website: "glowmedspa.com",
      timezone: "America/Chicago",
      platform: "none",
    });
    expect(rows[0]!.profile_status).toBe("read");
    expect((rows[0]!.profile as ClinicProfile).services.map((s) => s.name)).toEqual([
      "Signature facial",
    ]);
    expect((rows[0]!.profile as ClinicProfile).dropped).toBe(1);
  });

  test("no website is stored as null, with no read", async () => {
    const response = await postIntent(
      signed(
        await signedOrder({
          plan: "voice-metachat-500-300",
          website: null,
          profile: null,
          profileStatus: "none",
        }),
      ),
    );
    expect(response.status).toBe(201);
    const { rows } = await getMigratorPool().query(
      `select payload, profile, profile_status from checkout_intents`,
    );
    expect(rows[0]!.payload.website).toBeNull();
    expect(rows[0]!.profile).toBeNull();
    expect(rows[0]!.profile_status).toBe("none");
  });

  test("a refused answer never becomes a row", async () => {
    const refused = await postIntent(
      signed(
        await signedOrder({
          plan: "webchat-300",
          website: null,
          profile: null,
          profileStatus: "none",
        }),
      ),
    );
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { field: string }).field).toBe("plan");
    const { rows } = await getMigratorPool().query(`select 1 from checkout_intents`);
    expect(rows).toHaveLength(0);
  });
});
