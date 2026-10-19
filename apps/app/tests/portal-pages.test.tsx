import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __clearPortalConfigurationForTests } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { markExportDelivered, startOffboarding } from "@/lib/offboarding/offboarding";
import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import { withTenant } from "@/lib/tenant";

import { axeViolations } from "./setup/axe";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
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
 *     still there; once the service has ended, read-only with the export's
 *     deadline and the destruction's date, then the delivery, then the
 *     destruction);
 *
 * and axe-core on every screen this build has (Part F8): Home, Settings,
 * Knowledge, Conversations and Billing, and the add-a-device and step-up
 * pages a patient screen sends the browser to, before and after go-live.
 * Bookings joins when its page lands (package E). A WCAG 2.2 A or AA
 * failure fails the screen (tests/setup/axe.ts).
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
  // A session with no step-up of its own, for the device and step-up pages.
  sessionBinding: async () => ({ userId: portal.userId, sessionTokenHash: randomBytes(32) }),
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

type Screen =
  "home" | "settings" | "knowledge" | "conversations" | "billing" | "protect" | "step-up";

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
    case "protect": {
      const { default: Page } = await import("@/app/c/[slug]/protect/page");
      return renderPage(<Page params={params} searchParams={Promise.resolve({})} />);
    }
    case "step-up": {
      const { default: Page } = await import("@/app/c/[slug]/step-up/page");
      return renderPage(<Page params={params} searchParams={Promise.resolve({})} />);
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

/** The six screens this build has (Bookings is package E's), and the two a patient page sends a device to. */
const SCREENS: readonly Screen[] = [
  "home",
  "settings",
  "knowledge",
  "conversations",
  "billing",
  "protect",
  "step-up",
];

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
    await import("@/app/c/[slug]/protect/page");
    await import("@/app/c/[slug]/step-up/page");
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

  test("before go-live: Home's tracker says where going live stands, and Settings says a chat on the clinic's site is a real one (WP2)", async () => {
    // Go-live is automatic, so once the line is on the live site, staff
    // trying the chat there start the plan: Settings says so beside it.
    expect(text(await render("settings"))).toContain(WEB_CHAT_COUNTS_LINE);
    const home = text(await render("home"));
    expect(home).toContain("Going live");
  });

  test("website chat open: Settings → Channels keeps its line with Copy and Email to my web person, and Home links there while it waits", async () => {
    const web = (set: string) =>
      inTenant(clinic.clinicId, (c) =>
        c.query(`update clinic_channels set ${set} where clinic_id = $1 and channel = 'web'`, [
          clinic.clinicId,
        ]),
      );
    // Before the channel opens, the line is promised, never shown.
    const before = text(await render("settings"));
    expect(before).toContain(
      "The line to paste on your website appears here when website chat is ready",
    );
    expect(before).not.toContain("data-clinic=");
    expect(text(await render("home"))).not.toContain("Get the line");

    await web(`ready_at = now(), waiting_on = 'snippet'`);
    try {
      const html = await render("settings");
      const words = text(html);
      expect(words).toContain(`/widget/v1.js" data-clinic="${clinic.clinicSlug}" async`);
      expect(words).toContain("The line for your website");
      expect(words).toContain("Copy the line");
      expect(words).toContain("Email to my web person");
      expect(words).toContain(WEB_CHAT_COUNTS_LINE);
      expect(words).not.toContain("appears here when website chat is ready");
      expect(html).toContain('id="website-line"');
      expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
      expect(await axeViolations(html, "settings")).toEqual([]);

      const home = await render("home");
      expect(text(home)).toContain(
        "Website chat is ready: paste one line on your website, and AYA is designed to start answering there. Get the line",
      );
      expect(home).toContain(`href="/c/${portal.clinicSlug}/settings#website-line"`);
      expect(brokenLinks(home, portal.clinicSlug)).toEqual([]);

      // Seen on the site: Home stops asking, and the line stays in Settings for good.
      await web(`waiting_on = null`);
      expect(text(await render("home"))).not.toContain("Get the line");
      expect(text(await render("settings"))).toContain("Email to my web person");
    } finally {
      await web(`ready_at = null, waiting_on = null`);
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
      // A caller AYA answered this week and took a request from, waiting for
      // the team (WP4's "Waiting for you" card and the week's numbers).
      await inTenant(clinic.clinicId, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `insert into contacts (clinic_id, phone, full_name) values ($1, '+14155550134', 'Maria Lopez') returning id`,
          [clinic.clinicId],
        );
        await c.query(
          `insert into conversations (clinic_id, contact_id, channel, recovery_reason, outcome, started_at, disclosure_played_at)
           values ($1, $2, 'voice', 'after_hours', 'qualified_no_booking', now() - interval '3 hours', now() - interval '3 hours')`,
          [clinic.clinicId, rows[0]!.id],
        );
        await c.query(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, treatment, token_hash, expires_at, created_at)
           values ($1, $2, 'voice', 'Thursday afternoon', 'Consultation', $3, now() + interval '7 days', now() - interval '2 hours')`,
          [clinic.clinicId, rows[0]!.id, randomBytes(32)],
        );
      });
      const html = await render("home");
      const words = text(html);
      // The first card: counts and an age, one tap into Bookings, nobody named.
      expect(words.indexOf("Waiting for you:")).toBeLessThan(words.indexOf("Needs attention"));
      expect(words).toContain("Waiting for you: 1 person to call back (oldest 2 h) Open Bookings");
      expect(html).toContain(`href="/c/${portal.clinicSlug}/bookings"`);
      // This week, from the claims function.
      expect(words).toContain(
        "This week The last 7 days. Conversations handled 1 Phone 1 call · 1 would otherwise have rung out Website chat 0 chats Booking requests taken 1 · 0 confirmed by your team",
      );
      expect(words).not.toMatch(/Maria|Lopez|4155550134|Consultation|Thursday afternoon|revenue/);
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

    test("Home and Settings say since when a channel is live, and until when a pause runs, as the wizard does", async () => {
      // Until 19 October 2026 both showed a bare "Live" or "Paused": only the
      // wizard's step 4 used channelStatusLabel, so the three screens disagreed.
      const pause = (set: string) =>
        inTenant(clinic.clinicId, (c) =>
          c.query(`update clinic_settings set ${set} where clinic_id = $1`, [clinic.clinicId]),
        );
      /** Settings' status pills carrying exactly this label, one per channel. */
      const settingsPills = (html: string, label: RegExp) =>
        html.match(new RegExp(`<span[^>]*rounded-full[^>]*>${label.source}</span>`, "g")) ?? [];
      const SINCE = /Live since 14 October(?: 2026)?/;
      const UNTIL = /Paused until \d{1,2}(?::\d{2})? [ap]m [A-Z]{2,5} on Monday 2 March 2099/;
      const OPEN_ENDED = /Paused until you switch AYA back on/;
      await setChannels(`live_at = '2026-10-14T15:00:00Z'`);
      try {
        const home = text(await render("home"));
        expect(home).toMatch(new RegExp(`Website chat ${SINCE.source} `));
        expect(home).toMatch(new RegExp(`Phone ${SINCE.source} `));
        expect(settingsPills(await render("settings"), SINCE)).toHaveLength(2);

        await pause(`ai_paused_at = now(), ai_paused_until = '2099-03-02T19:00:00Z'`);
        const pausedHome = text(await render("home"));
        expect(pausedHome).toMatch(new RegExp(`Website chat ${UNTIL.source} `));
        expect(pausedHome).toMatch(new RegExp(`Phone ${UNTIL.source} `));
        expect(settingsPills(await render("settings"), UNTIL)).toHaveLength(2);

        await pause(`ai_paused_until = null`);
        const heldHome = text(await render("home"));
        expect(heldHome).toMatch(new RegExp(`Website chat ${OPEN_ENDED.source} `));
        expect(heldHome).toMatch(new RegExp(`Phone ${OPEN_ENDED.source} `));
        const held = await render("settings");
        expect(settingsPills(held, OPEN_ENDED)).toHaveLength(2);
        // No bare word left on either screen.
        expect(settingsPills(held, /(?:Live|Paused)/)).toEqual([]);
        expect(heldHome).not.toMatch(/(?:Website chat|Phone) (?:Live|Paused) (?!since |until )/);
        expect(await axeViolations(held, "settings")).toEqual([]);
      } finally {
        await pause(`ai_paused_at = null, ai_paused_until = null`);
        await setChannels(`live_at = now() - interval '1 day'`);
      }
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

    test("Billing once the service has ended: read-only, with the export's deadline and the destruction's date, then the delivery, then the destruction", async () => {
      worldAfterStart();
      const actor = { type: "service", serviceName: "portal-pages-test" } as const;
      await entitlements(`status = 'canceled'`);
      await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        startOffboarding(tx, "customer.subscription.deleted"),
      );
      try {
        // Not delivered: the day to download by, the latest destruction, and the way to the export.
        let html = await render("billing");
        let words = text(html);
        expect(words).toContain("Your export and your data");
        expect(words).toMatch(
          /Your export is ready in Conversations\. Download it by [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+( \d{4})?\./,
        );
        expect(words).toMatch(
          /We destroy our copies of your data within 30 days of your export being delivered, and by [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+( \d{4})? at the latest\./,
        );
        expect(html).toContain(`href="/c/${portal.clinicSlug}/conversations#export"`);
        // Read-only: nothing to switch or change.
        expect(html).not.toContain('id="switches"');
        expect(html).not.toContain('id="change"');
        expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
        expect(await axeViolations(html, "Billing after cancellation")).toEqual([]);

        // Delivered: when, and the day the data goes.
        await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          markExportDelivered(tx, "downloaded in full by the clinic"),
        );
        worldAfterStart();
        words = text(await render("billing"));
        expect(words).toMatch(
          /Your export was delivered on [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\. We destroy our copies of your data by [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+( \d{4})?\./,
        );
        expect(words).not.toContain("Open the export");

        // Destroyed: when, the backups' last day, and what is kept.
        await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [
          clinic.clinicId,
        ]);
        worldAfterStart();
        html = await render("billing");
        words = text(html);
        expect(words).toMatch(/Your data was destroyed on [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\./);
        expect(words).toContain("Copies in our encrypted database backups expire by");
        expect(words).toContain("We keep the signed agreement and your billing history");
        expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
        expect(await axeViolations(html, "Billing after destruction")).toEqual([]);
      } finally {
        await getMigratorPool().query(
          `update clinics set offboarding_started_at = null, destroy_after = null,
                  export_delivered_at = null, destroyed_at = null where id = $1`,
          [clinic.clinicId],
        );
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
