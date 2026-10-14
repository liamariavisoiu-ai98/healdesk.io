import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __clearPortalConfigurationForTests } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";

import { axeViolations } from "./setup/axe";
import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedGoogleConnection } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";
import { renderPage } from "./setup/render-page";
import { createStripeWorld } from "./setup/stripe-world";

/**
 * The portal's screens as a clinic's browser receives them (plan Part F),
 * rendered from a provisioned clinic with the sign-in and the passkey
 * step-up stood in, for the states the screens' own suites leave out:
 *
 *   - Home after go-live: the header past "AYA isn't answering yet", no
 *     build tracker, the channels live, the plan's start, and a calendar
 *     that stopped working in Needs attention;
 *   - Billing after the plan starts (the start and the next charge from
 *     Stripe's own preview) and after cancellation (the plan has ended,
 *     nothing left to switch or change, the card, invoices and agreement
 *     still there);
 *
 * and axe-core on every screen this build has (Part F8): Home, Settings,
 * Knowledge, Conversations and Billing, before and after go-live. Bookings
 * joins when its page lands (package E). A WCAG 2.2 A or AA failure fails
 * the screen (tests/setup/axe.ts).
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const grants: { clinicId: string; slug: string; name: string }[] = [];
const STEP_UP = {
  passkeyId: randomUUID(),
  deviceLabel: "Front desk Mac",
  at: new Date(),
  stepUpId: randomUUID(),
  expiresAt: new Date(Date.now() + 15 * 60_000),
  checkedAt: new Date(),
  capped: false,
};

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "Front desk Mac", steppedUp: true }),
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
}));
vi.mock("@/lib/portal/step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/step-up")>()),
  requireStepUp: async () => STEP_UP,
  touchStepUp: async () => null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const BOUGHT = "voice-webchat-1000-1000";
const ids = { customerId: "cus_portalpages1", subscriptionId: "sub_portalpages1" };
const s = (date: Date) => Math.floor(date.getTime() / 1000);

let clinic: PortalClinic;

type Screen = "home" | "settings" | "knowledge" | "conversations" | "billing";

async function render(screen: Screen): Promise<string> {
  const params = Promise.resolve({ slug: portal.clinicSlug });
  switch (screen) {
    case "home": {
      const { default: Page } = await import("@/app/c/[slug]/page");
      return renderPage(<Page params={params} />);
    }
    case "settings": {
      const { default: Page } = await import("@/app/c/[slug]/settings/page");
      return renderPage(<Page params={params} searchParams={Promise.resolve({})} />);
    }
    case "knowledge": {
      const { default: Page } = await import("@/app/c/[slug]/knowledge/page");
      return renderPage(<Page params={params} />);
    }
    case "conversations": {
      const { default: Page } = await import("@/app/c/[slug]/conversations/page");
      return renderPage(<Page params={params} />);
    }
    case "billing": {
      const { default: Page } = await import("@/app/c/[slug]/billing/page");
      return renderPage(<Page params={params} />);
    }
  }
}

/** Text as a person reads it: tags out, entities back. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function entitlements(set: string, values: unknown[] = []) {
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update entitlements set ${set} where clinic_id = $1`, [clinic.clinicId, ...values]),
  );
}

async function setChannels(set: string) {
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update clinic_channels set ${set} where clinic_id = $1`, [clinic.clinicId]),
  );
}

const SCREENS: readonly Screen[] = ["home", "settings", "knowledge", "conversations", "billing"];

describeDb("the portal's screens, before and after go-live", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("pages", { plan: BOUGHT });
    Object.assign(portal, {
      userId: clinic.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.clinicSlug,
    });
    grants.splice(0, grants.length, {
      clinicId: clinic.clinicId,
      slug: clinic.clinicSlug,
      name: "pages Med Spa LLC",
    });
    // The billing row as the first paid invoice leaves it.
    await entitlements(`status = 'active', stripe_customer_id = $2, stripe_subscription_id = $3`, [
      ids.customerId,
      ids.subscriptionId,
    ]);
    // Each page's module graph, imported once outside any test's clock.
    await import("@/app/c/[slug]/page");
    await import("@/app/c/[slug]/settings/page");
    await import("@/app/c/[slug]/knowledge/page");
    await import("@/app/c/[slug]/conversations/page");
    await import("@/app/c/[slug]/billing/page");
  }, 300_000);

  beforeEach(() => {
    __clearPriceCacheForTests();
    __clearPortalConfigurationForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("axe is awake: a page with an unnamed button and an unlabelled field fails", async () => {
    const problems = await axeViolations(`<main><button></button><input type="text"></main>`);
    expect(problems.some((p) => p.startsWith("button-name"))).toBe(true);
    expect(problems.some((p) => p.startsWith("label"))).toBe(true);
  });

  test("before go-live: every screen passes axe, and every link on it goes somewhere", async () => {
    for (const screen of SCREENS) {
      const html = await render(screen);
      expect(brokenLinks(html, portal.clinicSlug), screen).toEqual([]);
      expect(await axeViolations(html, screen), screen).toEqual([]);
    }
  });

  describe("after go-live", () => {
    beforeAll(async () => {
      // Both channels live since yesterday, the plan started when AYA first
      // answered, and the calendar connection broken since this morning.
      await setChannels(
        `ready_at = now() - interval '2 days', live_at = now() - interval '1 day', first_answer_at = now() - interval '1 day'`,
      );
      await entitlements(
        `plan_started_at = now() - interval '1 day', plan_code = $2, current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days'`,
        [BOUGHT],
      );
      await seedGoogleConnection(clinic.clinicId, { status: "error" });
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update provider_connections set broken_at = now() - interval '3 hours', last_error = 'invalid_grant'
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinic.clinicId],
        ),
      );
    });

    function worldAfterStart() {
      const now = new Date();
      const world = createStripeWorld({
        customerId: ids.customerId,
        subscriptionId: ids.subscriptionId,
        items: [{ lookupKey: "healdesk_voice-webchat-1000-1000_month_120000", quantity: 1 }],
        periodStart: s(new Date(now.getTime() - 86_400_000)),
        periodEnd: s(new Date(now.getTime() + 29 * 86_400_000)),
        customerDefaultPm: null,
        subscriptionDefaultPm: "pm_from_checkout",
        nowSeconds: s(now),
      });
      // Stripe's preview of the next invoice: the package's month, at renewal.
      const renews = s(new Date(now.getTime() + 29 * 86_400_000));
      world.fake.on("invoices.createPreview", () => ({
        amount_due: 120_000,
        next_payment_attempt: null,
        period_end: renews,
        lines: {
          data: [
            {
              amount: 120_000,
              period: { start: renews, end: renews + 30 * 86_400 },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      }));
      __setStripeForTests(world.stripe);
      return world;
    }

    test("Home: AYA is answering, no tracker, the channels live, the plan's start, and the broken calendar first to fix", async () => {
      const html = await render("home");
      const words = text(html);
      expect(words).not.toContain("AYA isn’t answering patients yet");
      expect(words).not.toContain("Building your AYA");
      expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Talk to your AYA<\/button>/);
      expect(words).toMatch(/Website chat Live/);
      expect(words).toMatch(/Phone Live/);
      expect(words).toMatch(
        /Your plan started on [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+, when AYA first answered/,
      );
      const attention = words.slice(words.indexOf("Needs attention"));
      expect(attention).toContain(
        "Your calendar stopped working, so bookings arrive as requests your team confirms. Reconnect it in Settings",
      );
      expect(html).toContain(`href="/c/${portal.clinicSlug}/settings#calendar"`);
      // The menu follows the live state: Conversations is a link now.
      expect(html).toContain(`href="/c/${portal.clinicSlug}/conversations"`);
      expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
      expect(await axeViolations(html, "Home")).toEqual([]);
    });

    test("Billing after the plan starts: when it started, the next charge from Stripe, and what Auto-renew off does now", async () => {
      worldAfterStart();
      const html = await render("billing");
      const words = text(html);
      expect(words).toMatch(/Your plan started on [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\./);
      expect(words).toMatch(/Next charge: \$1,200(\.00)? on [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\./);
      expect(words).not.toContain("starts the day AYA first answers");
      expect(words).toContain(
        "Off cancels at the end of the period you've paid for, and can be turned back on until then.",
      );
      expect(words).toContain("Change your plan");
      expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
      expect(await axeViolations(html, "Billing")).toEqual([]);
    });

    test("Billing after cancellation: the plan has ended, nothing to switch or change; the card, invoices and agreement stay", async () => {
      worldAfterStart();
      await entitlements(`status = 'canceled'`);
      try {
        const html = await render("billing");
        const words = text(html);
        expect(words).toContain("This plan has ended.");
        expect(html).not.toContain('id="switches"');
        expect(html).not.toContain('id="change"');
        expect(words).not.toContain("Next charge");
        expect(words).toContain("See invoices");
        expect(html).toContain(`href="/c/${portal.clinicSlug}/billing/agreement"`);
        expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
        expect(await axeViolations(html, "Billing")).toEqual([]);
      } finally {
        await entitlements(`status = 'active'`);
      }
    });

    test("every screen passes axe, and every link on it goes somewhere", async () => {
      for (const screen of SCREENS) {
        if (screen === "billing") worldAfterStart();
        const html = await render(screen);
        expect(brokenLinks(html, portal.clinicSlug), screen).toEqual([]);
        expect(await axeViolations(html, screen), screen).toEqual([]);
      }
    });
  });
});
