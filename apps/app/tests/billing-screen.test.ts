import { getPlan } from "@healdesk/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __clearPortalConfigurationForTests } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { getBillingSummary } from "@/lib/billing/summary";
import { copyProblems, visibleText } from "@/lib/email/lint";
import { optionalEmailAllowed } from "@/lib/email/stop";
import { locationsReady } from "@/lib/locations";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/** A plan name as a literal inside a pattern: the names come from the catalog, which renames them. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Billing (plan Part F6), through its server actions with the sign-in stood
 * in, against a provisioned clinic and a simulated Stripe: the page says
 * what the plan is and when it starts, and computes nothing itself; the
 * three switches need a passkey step-up and change what the rest of the
 * system reads (the answer gate under "Stop and fall back", the sender's
 * usage-alerts switch, Stripe's cancel at period end); a plan change shows
 * the setup-fee difference first, and a change in flight is finished by
 * choosing it again, never greyed out; the card and invoices open Stripe's
 * own portal; and the agreement downloads as the PDF that was signed.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const grants: { clinicId: string; slug: string; name: string }[] = [];
let steppedUp = false;
const touched = vi.fn();

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
  portalActor: async () =>
    steppedUp
      ? { label: "Front desk Mac", steppedUp: true }
      : { label: "the clinic's sign-in", steppedUp: false },
}));
vi.mock("@/lib/portal/step-up", () => ({
  stepUpPath: (slug: string, next: string) => `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
  touchStepUp: async () => {
    touched();
    return null;
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Voice + Web Chat, 1,000 of each (13 October 2026): $1,200 a month, $956 setup. */
const BOUGHT = "voice-webchat-1000-1000";
const ACTOR = { type: "service", serviceName: "billing-screen-test" } as const;
const s = (date: Date) => Math.floor(date.getTime() / 1000);

let clinic: PortalClinic;
let world: StripeWorld;
const ids = { customerId: "cus_billingscreen1", subscriptionId: "sub_billingscreen1" };

async function actions() {
  return import("@/app/c/[slug]/billing/actions");
}

async function render(): Promise<string> {
  const { default: BillingPage } = await import("@/app/c/[slug]/billing/page");
  return renderToStaticMarkup(
    await BillingPage({ params: Promise.resolve({ slug: portal.clinicSlug }) }),
  );
}

async function entitlements(set: string, values: unknown[] = []) {
  await inTenant(clinic.clinicId, async (c) => {
    await c.query(`update entitlements set ${set} where clinic_id = $1`, [
      clinic.clinicId,
      ...values,
    ]);
  });
}

describeDb("Billing", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("billing", { plan: BOUGHT });
    Object.assign(portal, {
      userId: clinic.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.clinicSlug,
    });
    grants.splice(0, grants.length, {
      clinicId: clinic.clinicId,
      slug: clinic.clinicSlug,
      name: "billing Med Spa LLC",
    });
    // The billing row as the first paid invoice leaves it: the customer and
    // the subscription Checkout made, before the plan starts.
    await entitlements(`status = 'active', stripe_customer_id = $2, stripe_subscription_id = $3`, [
      ids.customerId,
      ids.subscriptionId,
    ]);
    // Warm the page, its actions and the download up once, outside any
    // test's clock: on a busy machine the first import of a page's module
    // graph alone can take longer than a test is given.
    await import("@/app/c/[slug]/billing/page");
    await import("@/app/c/[slug]/billing/actions");
    await import("@/app/c/[slug]/billing/agreement/route");
  }, 300_000);

  beforeEach(() => {
    steppedUp = false;
    touched.mockClear();
    __clearPriceCacheForTests();
    __clearPortalConfigurationForTests();
    world = createStripeWorld({
      customerId: ids.customerId,
      subscriptionId: ids.subscriptionId,
      items: [{ lookupKey: "healdesk_plan_start_placeholder_month", quantity: 1 }],
      periodStart: s(new Date("2026-10-01T00:00:00Z")),
      periodEnd: s(new Date("2026-11-01T00:00:00Z")),
      customerDefaultPm: null,
      subscriptionDefaultPm: "pm_from_checkout",
      nowSeconds: s(new Date()),
    });
    __setStripeForTests(world.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("before the start: the plan, its channels and location, when it starts, the switches together, a location's price, Stripe for the card, and the agreement", async () => {
    const html = await render();
    const plan = getPlan(BOUGHT)!;
    // The package, then its steps: the plan's full name would say them twice.
    expect(html).toContain(`${plan.packageName}, billed monthly`);
    expect(html).toContain("Website chat · Phone · one location");
    expect(html).toContain("Includes 1,000 voice minutes and 1,000 chat conversations a month.");
    expect(html).toContain("Monthly billing ($1,200) starts the day AYA first answers a patient.");
    expect(html).toContain(
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
    );
    expect(html).toContain("Your allowance starts when your plan does.");
    // Each meter's extra-100 price, at the bought plan's rate, and provisional.
    expect(html).toContain(
      "Past it: $104 for each started block of 100 extra voice minutes (provisional).",
    );
    expect(html).toContain(
      "Past it: $52 for each started block of 100 extra chat conversations (provisional).",
    );
    expect(html).toMatch(/Their prices are provisional until we(&#x27;|’)ve measured/);
    expect(html).not.toMatch(/\$1\.04|\$0\.52/);
    // The three switches, together, under one heading.
    const switches = html.slice(html.indexOf('id="switches"'), html.indexOf('id="change"'));
    expect(switches).toContain("When the monthly allowance runs out");
    expect(switches).toMatch(
      /role="switch"[^>]*aria-checked="true"[\s\S]*Usage alerts|Usage alerts[\s\S]*role="switch"/,
    );
    expect(switches).toContain("Auto-renew");
    expect(switches).toContain("Emails at 90% and 100% of the allowance");
    expect(switches).toMatch(/Off means your plan won(&#x27;|’)t start/);
    // The change control starts on the current plan, which can't be asked
    // about again; every package is offered, with a step for each meter.
    expect(html).toContain("AYA Voice + Web Chat · your package");
    for (const name of ["AYA Voice", "AYA Web Chat", "AYA Meta Chat", "AYA Voice + Meta Chat"]) {
      expect(html).toContain(`>${name}<`);
    }
    expect(html).toContain("Voice minutes a month");
    expect(html).toContain("Chat conversations a month");
    expect(html).toContain('<option value="1500">1,500 minutes</option>');
    const current = html.slice(html.indexOf(`${plan.name} · your plan`));
    expect(current).not.toBe(html);
    expect(current.match(/<button[^>]*>[^<]*/)![0]).toMatch(/disabled=""[^>]*>This is your plan/);
    // A location says its price.
    expect(html).toContain(`plus a $${plan.setupFeeUsd.toLocaleString("en-US")} setup fee`);
    expect(html).toContain("Change the card");
    expect(html).toContain("See invoices");
    expect(html).toMatch(/Business associate agreement, version [0-9.]+, signed by Laura Owner/);
    expect(html).toContain(`href="/c/${portal.clinicSlug}/billing/agreement"`);
    expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
  });

  test("Add a location states what a location costs and that it is added from Billing, and offers nothing that cannot add one", async () => {
    // Until 19 October 2026 the card sent the clinic to hello@healdesk.io to
    // "set it up with you", though nothing, the ops console included, can add
    // a location to a plan yet. Under copy-first the card states the promise
    // as designed, and LAUNCH_PROMISES' "extra-locations" tracks the gap.
    const html = await render();
    const plan = getPlan(BOUGHT)!;
    const start = html.indexOf(">Add a location</h3>");
    expect(start).toBeGreaterThan(-1);
    const card = html.slice(start, html.indexOf('id="payment-method"'));
    const words = visibleText(card).replace(/\s+/g, " ").trim();
    expect(words).toContain(
      `Each further location is added to this plan from Billing, at your plan’s price again: $${plan.monthlyUsd.toLocaleString("en-US")} a month plus a $${plan.setupFeeUsd.toLocaleString("en-US")} setup fee, charged once. It renews on the same date as your plan, and the allowances are pooled across your locations.`,
    );
    // The owner's central model of 20 October 2026: one AYA for every
    // location, and only the practice's own locations on one account.
    expect(words).toContain(
      "One AYA answers for all of your locations as a central assistant, like a call centre, with one knowledge base, price list and sign-in. Every location must be run by your practice; one run by a different business needs its own account.",
    );
    // No inbox that cannot add one, and no newness words or dates.
    expect(card).not.toContain("mailto:");
    expect(words).not.toMatch(/hello@|email|set it up with you/i);
    expect(words).not.toMatch(/\b(soon|yet|shortly|coming|not available)\b/i);
    expect(words).not.toMatch(/\b(20\d\d|January|February|March|April|May|June|July|August|September|October|November|December)\b/);
    expect(copyProblems(words)).toEqual([]);
    // The button only once the package bought may add a location: before
    // that it would ask Stripe for a price and then refuse.
    expect(locationsReady(plan)).toBe(false);
    expect(card).not.toMatch(/<button[^>]*>[^<]*Add a location/);
  });

  test("the three switches need a step-up, and each changes what the rest of the system reads", async () => {
    const { saveBillingSwitchAction } = await actions();
    const refused = await saveBillingSwitchAction(portal.clinicSlug, "overage_mode", "hard_cap");
    expect(refused).toEqual({
      ok: false,
      message: expect.stringMatching(/needs Face ID or your screen lock/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/billing`)}`,
    });
    expect((await getBillingSummary(clinic.clinicId))!.overageMode).toBe("allow");

    steppedUp = true;
    // "Stop and fall back": once the plan has started and the window's
    // allowance is used up, a new conversation passes through to the team.
    const now = new Date();
    await entitlements(
      `plan_started_at = $2, current_period_start = $2, current_period_end = $3,
       included_chat_conversations = 100, used_chat_conversations = 100`,
      [new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 20 * 86_400_000)],
    );
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update clinic_channels set live_at = now() where channel = 'web'`);
    });
    const gate = () =>
      assistantMayAnswer({ clinicId: clinic.clinicId, channel: "web", actor: ACTOR });
    expect(await gate()).toEqual({ decision: "answer" });
    // Past the alert mark (90% since 13 October 2026), the screen says what
    // the alert email says: move up a step, or let extra blocks bill.
    const usedUp = await render();
    expect(usedUp).toMatch(/You(&#x27;|’)re past 90% of this month(&#x27;|’)s allowance/);
    expect(usedUp).toContain("Moving up a step costs less than extra blocks");
    expect(usedUp).toContain("100 chat conversations used of 100 included (100%)");
    expect(await saveBillingSwitchAction(portal.clinicSlug, "overage_mode", "hard_cap")).toEqual({
      ok: true,
      toast: expect.stringMatching(/^When the allowance runs out, calls go to your direct line/),
    });
    expect(touched).toHaveBeenCalled();
    expect(await gate()).toMatchObject({ decision: "pass_through", reason: "allowance_cap" });
    await saveBillingSwitchAction(portal.clinicSlug, "overage_mode", "allow");
    expect(await gate()).toEqual({ decision: "answer" });
    await entitlements(
      `plan_started_at = null, current_period_start = null, current_period_end = null,
       included_chat_conversations = 0, used_chat_conversations = 0`,
    );
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update clinic_channels set live_at = null`);
    });

    // Usage alerts: the switch the sender asks before a 90% or 100% email.
    const alerts = () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        optionalEmailAllowed(tx, "usage_alerts"),
      );
    expect(await saveBillingSwitchAction(portal.clinicSlug, "usage_alerts", false)).toMatchObject({
      ok: true,
    });
    expect(await alerts()).toBe(false);
    await saveBillingSwitchAction(portal.clinicSlug, "usage_alerts", true);
    expect(await alerts()).toBe(true);

    // Auto-renew off before the start: Stripe cancels at the period's end,
    // and the plan never starts.
    const off = await saveBillingSwitchAction(portal.clinicSlug, "auto_renew", false);
    expect(off).toMatchObject({
      ok: true,
      toast: expect.stringMatching(
        /^Auto-renew off\. Your plan won't start, and nothing more is charged\. Turn it back on any time before \w+day \d{1,2} \w+/,
      ),
    });
    const [update] = world.fake.callsTo("subscriptions.update");
    expect(update!.args[1]).toMatchObject({ cancel_at_period_end: true });
    const summary = await getBillingSummary(clinic.clinicId);
    expect(summary).toMatchObject({ isAutoRenewOn: false, closesOn: expect.any(String) });
    const html = await render();
    expect(html).toMatch(
      /Your plan won(&#x27;|’)t start, and nothing more is charged\. Turn it back on/,
    );
    expect(await saveBillingSwitchAction(portal.clinicSlug, "auto_renew", true)).toMatchObject({
      ok: true,
    });
    expect((await getBillingSummary(clinic.clinicId))!.isAutoRenewOn).toBe(true);
  });

  test("a plan change shows the setup-fee difference first; one in flight is finished by choosing it again", async () => {
    const { previewPlanAction, changePlanAction } = await actions();
    const target = "voice-metachat-1000-1000";
    // A change of package pays the setup-fee difference first.
    const preview = await previewPlanAction(portal.clinicSlug, target, "month");
    const delta = (getPlan(target)!.setupFeeUsd - getPlan(BOUGHT)!.setupFeeUsd) * 100;
    expect(delta).toBe(43_800);
    expect(preview).toMatchObject({
      status: "ok",
      setupFeeDeltaCents: delta,
      prorationCents: 0,
      isInProgress: false,
      requestId: expect.any(String),
    });
    // A step within the package owes none (owner, 13 October 2026).
    expect(
      await previewPlanAction(portal.clinicSlug, "voice-webchat-1200-1000", "month"),
    ).toMatchObject({ status: "ok", setupFeeDeltaCents: 0 });
    // Without a step-up nothing is charged.
    expect(
      await changePlanAction(portal.clinicSlug, {
        planId: target,
        interval: "month",
        requestId: "req-1",
      }),
    ).toMatchObject({ ok: false, stepUpHref: expect.any(String) });
    expect(world.fake.calls).toHaveLength(0);

    // A change whose outcome was lost: choosing that plan again carries it
    // on, and the page starts on it and offers it rather than greying it out.
    await entitlements(
      `pending_plan_change_request_id = 'req-lost', pending_plan_change_plan_id = '${target}',
       pending_plan_change_interval = 'month'`,
    );
    try {
      expect(await previewPlanAction(portal.clinicSlug, target, "month")).toMatchObject({
        status: "ok",
        isInProgress: true,
      });
      expect(await previewPlanAction(portal.clinicSlug, "webchat-1000", "month")).toEqual({
        status: "refused",
        message: expect.stringMatching(
          new RegExp(
            `^A change to ${escapeRegExp(getPlan(target)!.name)}, billed monthly, is still being completed\\.`,
          ),
        ),
      });
      const html = await render();
      const beingChanged = `${getPlan(target)!.name} · being changed to`;
      expect(html).toContain(beingChanged);
      const button = html.slice(html.indexOf(beingChanged)).match(/<button[^>]*>[^<]*/)![0];
      expect(button).not.toContain('disabled=""');
      expect(button).toContain("See what it costs");
    } finally {
      await entitlements(
        `pending_plan_change_request_id = null, pending_plan_change_plan_id = null,
         pending_plan_change_interval = null`,
      );
    }
  });

  test("adding a location needs a step-up: without one nothing is charged and no location is made", async () => {
    const { addLocationAction } = await actions();
    expect(
      await addLocationAction(portal.clinicSlug, {
        requestId: "req-location-1",
        name: "Glow Med Spa, Round Rock",
        address: "1 Main St, Round Rock",
        acceptedBy: "Laura Owner, owner",
        accepted: true,
      }),
    ).toEqual({
      ok: false,
      message: expect.stringMatching(/needs Face ID or your screen lock/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/billing`)}`,
    });
    expect(touched).not.toHaveBeenCalled();
    // Nothing reached Stripe, and the account has only its main location.
    expect(world.fake.calls).toEqual([]);
    // clinic_locations is FORCEd, so it is read inside the clinic's tenant.
    const locations = await inTenant(clinic.clinicId, (c) =>
      c.query<{ n: number }>(
        `select count(*)::int as n from clinic_locations where clinic_id = $1`,
        [clinic.clinicId],
      ),
    );
    expect(locations.rows).toEqual([{ n: 1 }]);
  });

  test("the card and the invoices open Stripe's own portal, made on the click", async () => {
    const saved = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    try {
      world.state.portalConfigurations.push({
        id: "bpc_healdesk",
        metadata: { healdesk: "customer-portal" },
      });
      const { openStripePortalAction } = await actions();
      const result = await openStripePortalAction(portal.clinicSlug, "payment_method_update");
      expect(result).toEqual({
        ok: true,
        toast: "Opening Stripe…",
        href: expect.stringMatching(/^https:\/\/billing\.stripe\.com\//),
      });
      const [create] = world.fake.callsTo("billingPortal.sessions.create");
      expect(create!.args[0]).toMatchObject({
        customer: ids.customerId,
        return_url: `https://app.healdesk.test/c/${portal.clinicSlug}/billing`,
        flow_data: { type: "payment_method_update" },
      });
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = saved;
    }
  });

  test("the agreement downloads as the PDF that was signed, and only for this clinic's sign-in", async () => {
    const { GET } = await import("@/app/c/[slug]/billing/agreement/route");
    const response = await GET(new Request("https://app.healdesk.test/x"), {
      params: Promise.resolve({ slug: portal.clinicSlug }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="[^"]+\.pdf"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
