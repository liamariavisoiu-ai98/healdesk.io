import { getPlan } from "@healdesk/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __clearPortalConfigurationForTests } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { getBillingSummary } from "@/lib/billing/summary";
import { optionalEmailAllowed } from "@/lib/email/stop";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
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
    clinic = await provisionPortalClinic("billing", { plan: "web-voice" });
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
    expect(html).toContain(`${getPlan("web-voice")!.name}, billed monthly`);
    expect(html).toContain("Website chat · Phone · one location");
    expect(html).toContain("Monthly billing ($897) starts the day AYA first answers a patient.");
    expect(html).toContain(
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
    );
    expect(html).toContain("Your allowance starts when your plan does.");
    // The three switches, together, under one heading.
    const switches = html.slice(html.indexOf('id="switches"'), html.indexOf('id="change"'));
    expect(switches).toContain("When the monthly allowance runs out");
    expect(switches).toMatch(
      /role="switch"[^>]*aria-checked="true"[\s\S]*Usage alerts|Usage alerts[\s\S]*role="switch"/,
    );
    expect(switches).toContain("Auto-renew");
    expect(switches).toMatch(/Off means your plan won(&#x27;|’)t start/);
    // The current plan can't be chosen again; a location says its price.
    const plan = getPlan("web-voice")!;
    expect(html).toMatch(
      new RegExp(`disabled=""[^>]*/?>[\\s\\S]{0,400}${escapeRegExp(plan.name)} · your plan`),
    );
    expect(html).toContain(`plus a $${plan.setupFeeUsd.toLocaleString("en-US")} setup fee`);
    expect(html).toContain("Change the card");
    expect(html).toContain("See invoices");
    expect(html).toMatch(/Business associate agreement, version [0-9.]+, signed by Laura Owner/);
    expect(html).toContain(`href="/c/${portal.clinicSlug}/billing/agreement"`);
    expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
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

    // Usage alerts: the switch the sender asks before an 80% or 100% email.
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
    const preview = await previewPlanAction(portal.clinicSlug, "complete", "month");
    const delta = (getPlan("complete")!.setupFeeUsd - getPlan("web-voice")!.setupFeeUsd) * 100;
    expect(preview).toMatchObject({
      status: "ok",
      setupFeeDeltaCents: delta,
      prorationCents: 0,
      isInProgress: false,
      requestId: expect.any(String),
    });
    // Without a step-up nothing is charged.
    expect(
      await changePlanAction(portal.clinicSlug, {
        planId: "complete",
        interval: "month",
        requestId: "req-1",
      }),
    ).toMatchObject({ ok: false, stepUpHref: expect.any(String) });
    expect(world.fake.calls).toHaveLength(0);

    // A change whose outcome was lost: choosing that plan again carries it
    // on, and the page offers it rather than greying it out.
    await entitlements(
      `pending_plan_change_request_id = 'req-lost', pending_plan_change_plan_id = 'complete',
       pending_plan_change_interval = 'month'`,
    );
    try {
      expect(await previewPlanAction(portal.clinicSlug, "complete", "month")).toMatchObject({
        status: "ok",
        isInProgress: true,
      });
      expect(await previewPlanAction(portal.clinicSlug, "chat-web", "month")).toEqual({
        status: "refused",
        message: expect.stringMatching(
          new RegExp(
            `^A change to ${escapeRegExp(getPlan("complete")!.name)}, billed monthly, is still being completed\\.`,
          ),
        ),
      });
      const html = await render();
      const beingChanged = `${getPlan("complete")!.name} · being changed to`;
      const complete = html.slice(html.indexOf(beingChanged) - 600);
      expect(html).toContain(beingChanged);
      expect(complete.slice(0, 600)).not.toMatch(/disabled=""[^<]*$/);
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
      }),
    ).toEqual({
      ok: false,
      message: expect.stringMatching(/needs Face ID or your screen lock/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/billing`)}`,
    });
    expect(touched).not.toHaveBeenCalled();
    // Nothing reached Stripe, and no clinic names this one as its billing clinic.
    expect(world.fake.calls).toEqual([]);
    const locations = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from clinics where billing_clinic_id = $1 and id <> $1`,
      [clinic.clinicId],
    );
    expect(locations.rows).toEqual([{ n: 0 }]);
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
