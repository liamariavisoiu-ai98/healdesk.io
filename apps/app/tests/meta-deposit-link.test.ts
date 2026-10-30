import { findClinicalContent, namesMetaTreatment } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { recordDepositLapsed } from "@/lib/billing/deposits";
import { flagUnlinkedDepositsFor, UNLINKED_DEPOSIT_GRACE_MS } from "@/lib/billing/deposit-sweep";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { createBookingRequest, followUpLine } from "@/lib/meta/booking-requests";
import { attachMetaChannel, META_WINDOW_MS, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  isCheckoutUrl,
  META_DEPOSIT_LINK_WORDS,
  META_DEPOSIT_MIN_WINDOW_MS,
  metaDepositLinkText,
  metaDepositWindowOpen,
  metaDepositWordsAllowed,
  sendMetaDepositLink,
} from "@/lib/meta/deposit-link";
import { guardReply } from "@/lib/meta/front-door";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { deskDecideById } from "./setup/desk";
import { bindAgreementInEffect, inTenant, queuedNotices, seedClinic, seedEntitled } from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { createStripeFake, type StripeFake } from "./setup/stripe-fake";

/**
 * DEP-META slice 1 (docs/design/launch-readiness-2026-10-27/dep-meta-deposit-links.md):
 * staff confirm a Meta booking request, and while the thread's window is
 * open the clinic's own deposit link is sent there as one fixed line, after
 * the decision commits. Anything that stops it expires the session, cancels
 * the row and hands the deposit to the front desk with the L10 alert.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = { timeout: 60_000 };
const ACTOR = { type: "service", serviceName: "test" } as const;
const ACCOUNT = "acct_1MetaDeposit";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PEEL = "Chemical peel";

describe("the fixed line", () => {
  test("is the approved wording and the Checkout URL, nothing more", () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_a1";
    expect(metaDepositLinkText(url)).toBe(`To hold your request, please pay the deposit through this secure link: ${url}`);
    expect(META_DEPOSIT_LINK_WORDS).not.toMatch(/\d|\$|appointment|booked|confirm/i);
  });

  test("refuses any URL that is not https on checkout.stripe.com", () => {
    for (const bad of [
      "http://checkout.stripe.com/c/pay/cs_1",
      "https://checkout.stripe.com.evil.test/c/pay/cs_1",
      "https://evil.test/checkout.stripe.com",
      "https://user:pw@checkout.stripe.com/c/pay/cs_1",
      "https://checkout.stripe.com:8443/c/pay/cs_1",
      "https://checkout.stripe.com/c/pay/cs 1",
      "https://pay.stripe.com/c/pay/cs_1",
      "javascript:alert(1)",
    ]) {
      expect(isCheckoutUrl(bad), bad).toBe(false);
      expect(() => metaDepositLinkText(bad), bad).toThrow();
    }
    expect(isCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_a1#fid=x")).toBe(true);
  });

  test("its words pass their own checks, and a clinic whose service name is in them fails closed", () => {
    expect(findClinicalContent({ words: META_DEPOSIT_LINK_WORDS }, { conditions: true })).toEqual([]);
    expect(namesMetaTreatment(META_DEPOSIT_LINK_WORDS)).toBe(false);
    expect(metaDepositWordsAllowed([PEEL, "Consultation", "Lip filler"])).toBe(true);
    expect(metaDepositWordsAllowed([PEEL, "Secure"])).toBe(false);
    expect(metaDepositWordsAllowed(["Hold"])).toBe(false);
  });

  test("never goes through the model's guard, which refuses deposit talk by design", () => {
    expect(guardReply(metaDepositLinkText("https://checkout.stripe.com/c/pay/cs_test_a1")).ok).toBe(false);
  });

  test("needs five minutes of the window left", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const at = (msLeft: number) => new Date(now.getTime() - META_WINDOW_MS + msLeft);
    expect(metaDepositWindowOpen(at(META_DEPOSIT_MIN_WINDOW_MS), now)).toBe(true);
    expect(metaDepositWindowOpen(at(META_DEPOSIT_MIN_WINDOW_MS - 1), now)).toBe(false);
    expect(metaDepositWindowOpen(null, now)).toBe(false);
  });
});

describeDb("the desk-confirmed deposit link on Meta, against the database", SLOW, () => {
  let fake: StripeFake;
  let sessions = 0;
  /** Checkout session ids are unique across the table, so each test names its own. */
  let run = 0;
  const sessionId = (n: number) => `cs_test_r${run}_${n}`;
  /** Runs inside Stripe's create: what happens while the link is being made. */
  let duringCreate: (() => Promise<void>) | null = null;
  let checkoutUrl: (n: number) => string = (n) => `https://checkout.stripe.com/c/pay/${sessionId(n)}`;
  const sent: Parameters<MetaSender>[0][] = [];
  let graphFails = false;
  const sender: MetaSender = async (input) => {
    if (graphFails && input.text.startsWith(META_DEPOSIT_LINK_WORDS)) throw new Error("Graph API 500");
    sent.push(input);
  };
  let page = 900_000_000_000_000;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    sessions = 0;
    run += 1;
    sent.length = 0;
    graphFails = false;
    duringCreate = null;
    checkoutUrl = (n) => `https://checkout.stripe.com/c/pay/${sessionId(n)}`;
    fake = createStripeFake({
      "checkout.sessions.create": async (params: unknown) => {
        sessions += 1;
        if (duringCreate) await duringCreate();
        return { id: sessionId(sessions), url: checkoutUrl(sessions), status: "open", expires_at: (params as { expires_at: number }).expires_at };
      },
      "checkout.sessions.retrieve": (id: unknown) => ({ id, url: `https://checkout.stripe.com/c/pay/${String(id)}`, status: "open", payment_status: "unpaid", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      "checkout.sessions.expire": (id: unknown) => ({ id, status: "expired" }),
    });
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closePools();
  });

  /** A live clinic on Messenger that takes deposits: connected to Stripe, Take deposits on, a $75 peel. */
  async function depositClinic(label: string, opts: { services?: string[]; deposits?: boolean } = {}) {
    const c = await seedClinic(label);
    page += 1;
    const externalId = String(page);
    await bindAgreementInEffect(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(),
              stripe_connect_account_id = $2, stripe_connect_connected_at = now() where id = $1`,
      [c.clinicId, ACCOUNT],
    );
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, deposits_enabled, deposit_hold_minutes) values ($1, $2, 60)
         on conflict (clinic_id) do update set deposits_enabled = excluded.deposits_enabled`,
        [c.clinicId, opts.deposits !== false],
      ),
    );
    const connectionId = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: (opts.services ?? [PEEL, "Consultation"]).map((name) => ({ name, priceFromUsd: 150, priceToUsd: 250, durationMinutes: 30, depositUsd: name === "Consultation" ? 0 : 75 })),
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
        depositPolicy: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      const id = await attachMetaChannel(tx, { platform: "messenger", externalId, accessToken: "EAAB-page-token-0123456789", label: "Main page" });
      await setMetaFrontDoor(tx, true);
      return id;
    });
    return { ...c, externalId, connectionId };
  }

  type Clinic = Awaited<ReturnType<typeof depositClinic>>;

  async function request(c: Clinic, lastInboundAt: Date, senderId = "user-dep") {
    return withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) =>
      (
        await createBookingRequest(tx, {
          channel: "meta",
          thread: { platform: "messenger", externalId: c.externalId, senderId },
          connectionId: c.connectionId,
          fields: { firstName: "Sam", phone: "+14155550177", preferredWindow: "Saturday afternoon", alternativeWindows: [] },
          lastInboundAt,
        })
      ).id,
    );
  }

  const confirm = (c: Clinic, requestId: string, treatment = PEEL) =>
    deskDecideById(c.clinicId, requestId, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: new Date(Date.now() + 3 * DAY), treatment }, sender);

  const appointmentsOf = async (c: Clinic) =>
    (await inTenant(c.clinicId, (client) => client.query<{ id: string; deposit_status: string; deposit_usd: string | null }>(`select id, deposit_status, deposit_usd from appointments order by created_at`))).rows;
  const depositRows = async (c: Clinic) =>
    (await inTenant(c.clinicId, (client) => client.query<{ id: string; status: string; channel: string; amount_cents: number }>(`select id, status, channel, amount_cents from deposit_payments order by created_at`))).rows;
  const depositAlerts = (c: Clinic) => queuedNotices(c.clinicId, ["deposit_to_collect"]);
  const stripeCalls = (method: string) => fake.calls.filter((call) => call.method === method);
  /** Freeze the thread's last inbound at an instant, as the migrator (the 0040 trigger freezes a decided request). */
  const ageThread = async (c: Clinic, at: Date) => {
    await inTenant(c.clinicId, async (client) => {
      await client.query(`alter table booking_requests disable trigger user`);
      await client.query(`update booking_requests set last_inbound_at = $1`, [at]);
      await client.query(`alter table booking_requests enable trigger user`);
    });
  };

  /** Every message to the patient: no service name, no figure outside the URL, nothing clinical, and any URL on Stripe Checkout. */
  function expectCleanMessages(c: Clinic, services = [PEEL, "Consultation"]) {
    for (const message of sent) {
      const words = message.text.replace(/https:\/\/\S+/g, "");
      for (const name of services) expect(message.text.toLowerCase()).not.toContain(name.toLowerCase());
      expect(words, message.text).not.toMatch(/\d|\$/);
      expect(findClinicalContent({ words }, { conditions: true })).toEqual([]);
      for (const url of message.text.match(/https:\/\/\S+/g) ?? []) expect(new URL(url).hostname).toBe("checkout.stripe.com");
    }
    expect(c.clinicId).toBeTruthy();
  }

  test("window open: the follow-up, then exactly one link line; the appointment owes pending_link; a retry or second click sends nothing", async () => {
    const c = await depositClinic("dep-open");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    const decided = await confirm(c, requestId);
    expect(decided).toMatchObject({ outcome: "decided", followUp: "sent", depositLink: "sent" });

    expect(sent.map((m) => m.text)).toEqual([followUpLine(`dep-open Clinic`, "confirmed"), metaDepositLinkText(`https://checkout.stripe.com/c/pay/${sessionId(1)}`)]);
    expect(sent[1]).toMatchObject({ platform: "messenger", externalId: c.externalId, recipientId: "user-dep" });
    expectCleanMessages(c);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_link", deposit_usd: "75.00" }]);
    expect(await depositRows(c)).toMatchObject([{ status: "open", channel: "meta", amount_cents: 7500 }]);
    expect(await depositAlerts(c)).toEqual([]);

    // Stripe saw an amount, the generic product, DEPOSIT and the row's id: no treatment.
    const params = stripeCalls("checkout.sessions.create")[0]!.args[0];
    // The words Stripe sees, without the session's expiry (a Unix time) or
    // the row's opaque ids: both are generated, and a run whose timestamp or
    // uuid happened to hold "0177" used to fail with nothing of the patient
    // in it. The patient's name, number, service and day still may not appear.
    const { expires_at: expiresAt, ...described } = params as { expires_at: unknown } & Record<string, unknown>;
    expect(typeof expiresAt).toBe("number");
    const words = JSON.stringify(described).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
    expect(words).not.toMatch(/peel|Sam|0177|Saturday/i);
    expect(JSON.stringify(params)).not.toContain("4155550177");
    expect(params).toMatchObject({ line_items: [{ price_data: { product_data: { name: "Appointment deposit" } } }], payment_intent_data: { statement_descriptor_suffix: "DEPOSIT" } });

    // The audit says a link went, by ids; nothing of the line or the URL is kept.
    const audit = await inTenant(c.clinicId, (client) => client.query<{ row: string }>(`select row_to_json(a)::text as row from audit_log a`));
    const everything = audit.rows.map((r) => r.row).join("\n");
    expect(everything).toMatch(/"source": ?"deposit_link"/);
    expect(everything).not.toMatch(/checkout\.stripe\.com|cs_test_|secure link/);

    // A second click is already-decided, and a retried send step finds the open link: no second message, one row.
    expect(await confirm(c, requestId)).toMatchObject({ outcome: "already-decided" });
    const [appt] = await appointmentsOf(c);
    expect(
      await sendMetaDepositLink(c.clinicId, appt!.id, { platform: "messenger", externalId: c.externalId, senderId: "user-dep", connectionId: c.connectionId }, { actor: ACTOR, send: sender }),
    ).toBeNull();
    expect(sent).toHaveLength(2);
    expect(await depositRows(c)).toHaveLength(1);
    expect(stripeCalls("checkout.sessions.create")).toHaveLength(1);

    // The webhook's lapse hands a Meta link to the front desk, once.
    const [row] = await depositRows(c);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordDepositLapsed(tx, { depositId: row!.id, status: "expired", from: ["open"], eventId: "evt_1", at: new Date() }));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordDepositLapsed(tx, { depositId: row!.id, status: "expired", from: ["open"], eventId: "evt_1", at: new Date() }));
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect(await depositAlerts(c)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  test("under five minutes of window at confirm: no Stripe call, the front desk with one alert; the follow-up still goes", async () => {
    const c = await depositClinic("dep-closing");
    const requestId = await request(c, new Date(Date.now() - META_WINDOW_MS + 2 * MINUTE));
    expect(await confirm(c, requestId)).toMatchObject({ outcome: "decided", followUp: "sent", depositLink: "front_desk" });
    expect(sent.map((m) => m.text)).toEqual([followUpLine("dep-closing Clinic", "confirmed")]);
    expect(fake.calls).toEqual([]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk", deposit_usd: "75.00" }]);
    expect(await depositRows(c)).toEqual([]);
    expect(await depositAlerts(c)).toHaveLength(1);
  });

  test("window closed at confirm: nothing on the thread, no Stripe call, the front desk with one alert", async () => {
    const c = await depositClinic("dep-closed");
    const requestId = await request(c, new Date(Date.now() - 25 * 60 * MINUTE));
    expect(await confirm(c, requestId)).toMatchObject({ outcome: "decided", followUp: "outside_window", depositLink: "front_desk" });
    expect(sent).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect(await depositAlerts(c)).toHaveLength(1);
  });

  test("the window closes while the link is made: the session is expired, the row cancelled, the front desk alerted once", async () => {
    const c = await depositClinic("dep-race");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    duringCreate = () => ageThread(c, new Date(Date.now() - 25 * 60 * MINUTE));
    expect(await confirm(c, requestId)).toMatchObject({ outcome: "decided", followUp: "sent", depositLink: "front_desk" });
    expect(sent.map((m) => m.text)).toEqual([followUpLine("dep-race Clinic", "confirmed")]);
    expect(stripeCalls("checkout.sessions.expire").map((call) => call.args[0])).toEqual([sessionId(1)]);
    expect(await depositRows(c)).toMatchObject([{ status: "cancelled" }]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    const alerts = await depositAlerts(c);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dedupe_key).not.toMatch(/unchecked/);
  });

  test("Graph refuses the link line: the same as a closed window", async () => {
    const c = await depositClinic("dep-graph");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    graphFails = true;
    expect(await confirm(c, requestId)).toMatchObject({ outcome: "decided", followUp: "sent", depositLink: "front_desk" });
    expect(sent.map((m) => m.text)).toEqual([followUpLine("dep-graph Clinic", "confirmed")]);
    expect(stripeCalls("checkout.sessions.expire")).toHaveLength(1);
    expect(await depositRows(c)).toMatchObject([{ status: "cancelled" }]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect(await depositAlerts(c)).toHaveLength(1);
  });

  test("Stripe cannot expire the unsent session: the row stays open for the webhook, and the alert says it may be paid", async () => {
    const c = await depositClinic("dep-noexpire");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    graphFails = true;
    fake.on("checkout.sessions.expire", () => {
      throw new Error("Stripe unreachable");
    });
    expect(await confirm(c, requestId)).toMatchObject({ depositLink: "front_desk" });
    expect(await depositRows(c)).toMatchObject([{ status: "open" }]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    const alerts = await depositAlerts(c);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dedupe_key).toMatch(/unchecked/);
  });

  test("a URL that is not on checkout.stripe.com is never sent", async () => {
    const c = await depositClinic("dep-host");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    checkoutUrl = () => "https://pay.example.test/c/pay/cs_x";
    expect(await confirm(c, requestId)).toMatchObject({ depositLink: "front_desk" });
    expect(sent.map((m) => m.text)).toEqual([followUpLine("dep-host Clinic", "confirmed")]);
    expect(stripeCalls("checkout.sessions.expire")).toHaveLength(1);
    expect(await depositRows(c)).toMatchObject([{ status: "cancelled" }]);
    expect(await depositAlerts(c)).toHaveLength(1);
  });

  test("withheld: the front door off at confirm sends nothing and calls no Stripe; switched off while the link is made, the link is unsent", async () => {
    const c = await depositClinic("dep-withheld");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => setMetaFrontDoor(tx, false));
    expect(await confirm(c, requestId)).toMatchObject({ followUp: "withheld", depositLink: "front_desk" });
    expect(sent).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await depositAlerts(c)).toHaveLength(1);

    const d = await depositClinic("dep-withheld-late");
    const second = await request(d, new Date(Date.now() - 60 * MINUTE));
    duringCreate = () => withTenant({ clinicId: d.clinicId, actor: ACTOR }, (tx) => setMetaFrontDoor(tx, false));
    expect(await confirm(d, second)).toMatchObject({ followUp: "sent", depositLink: "front_desk" });
    expect(sent.filter((m) => m.externalId === d.externalId).map((m) => m.text)).toEqual([followUpLine("dep-withheld-late Clinic", "confirmed")]);
    expect(await depositRows(d)).toMatchObject([{ status: "cancelled" }]);
    expect(await depositAlerts(d)).toHaveLength(1);
  });

  test("a service named in the line's words fails closed to the front desk before Stripe", async () => {
    const c = await depositClinic("dep-name", { services: [PEEL, "Secure"] });
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    expect(await confirm(c, requestId)).toMatchObject({ depositLink: "front_desk" });
    expect(fake.calls).toEqual([]);
    expect(sent.map((m) => m.text)).toEqual([followUpLine("dep-name Clinic", "confirmed")]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect(await depositAlerts(c)).toHaveLength(1);
  });

  test("no deposit due (Take deposits off, or a $0 service): no link, no alert, nothing said to staff", async () => {
    const c = await depositClinic("dep-off", { deposits: false });
    const decided = await confirm(c, await request(c, new Date(Date.now() - 60 * MINUTE)));
    expect(decided).toMatchObject({ outcome: "decided", followUp: "sent" });
    expect(decided.depositLink).toBeUndefined();
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "none", deposit_usd: null }]);

    const d = await depositClinic("dep-zero");
    const zero = await confirm(d, await request(d, new Date(Date.now() - 60 * MINUTE)), "Consultation");
    expect(zero.depositLink).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(await depositAlerts(c)).toEqual([]);
    expect(await depositAlerts(d)).toEqual([]);
  });

  test("Stripe disconnected after the confirmation: chatDepositFor hands it to the front desk, nothing is sent", async () => {
    const c = await depositClinic("dep-disconnected");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    await confirm(c, requestId);
    const [appt] = await appointmentsOf(c);
    // The appointment owes a link again with no live row (as a send step
    // that never ran would leave it), and the clinic then disconnects Stripe.
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update deposit_payments set status = 'cancelled'`);
      await client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appt!.id]);
    });
    await getMigratorPool().query(`update clinics set stripe_connect_account_id = null where id = $1`, [c.clinicId]);
    sent.length = 0;
    const before = (await depositAlerts(c)).length;
    expect(
      await sendMetaDepositLink(c.clinicId, appt!.id, { platform: "messenger", externalId: c.externalId, senderId: "user-dep", connectionId: c.connectionId }, { actor: ACTOR, send: sender }),
    ).toBe("front_desk");
    expect(sent).toEqual([]);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect((await depositAlerts(c)).length).toBe(before + 1);
  });

  test("a Meta appointment left pending_link with no row (the process died after the commit) is flagged by the sweep after its grace", async () => {
    const c = await depositClinic("dep-sweep");
    const requestId = await request(c, new Date(Date.now() - 60 * MINUTE));
    await confirm(c, requestId);
    const [appt] = await appointmentsOf(c);
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update deposit_payments set status = 'cancelled'`);
      await client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appt!.id]);
    });
    const before = (await depositAlerts(c)).length;
    expect(await flagUnlinkedDepositsFor(c.clinicId, new Date(Date.now() + UNLINKED_DEPOSIT_GRACE_MS + MINUTE))).toBe(1);
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk" }]);
    expect((await depositAlerts(c)).length).toBe(before + 1);
  });

  test("a call's request confirmed by staff is still priced by the clinic-wide rule, and is never sent a link", async () => {
    const c = await depositClinic("dep-voice");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: PEEL, priceFromUsd: 150, priceToUsd: 250, durationMinutes: 30, depositUsd: 75 }],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: { required: true, amountUsd: 50, collection: "front_desk" },
      }),
    );
    const contact = await inTenant(c.clinicId, (client) => client.query<{ id: string }>(`insert into contacts (clinic_id, phone) values ($1, '+14155550166') returning id`, [c.clinicId]));
    const requestId = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) =>
      (await createBookingRequest(tx, { channel: "voice", contactId: contact.rows[0]!.id, conversationId: null, preferredWindow: "Friday morning", treatment: PEEL })).id,
    );
    const decided = await confirm(c, requestId);
    expect(decided).toMatchObject({ outcome: "decided", followUp: null });
    expect(decided.depositLink).toBeUndefined();
    expect(await appointmentsOf(c)).toMatchObject([{ deposit_status: "pending_front_desk", deposit_usd: "50.00" }]);
    expect(fake.calls).toEqual([]);
    expect(sent).toEqual([]);
  });
});
