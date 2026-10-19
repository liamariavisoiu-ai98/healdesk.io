import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  NEVER_SAY_DEFAULTS,
  type BookingSystemId,
  type CalendarAccount,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { publicUrl } from "@/lib/public-url";
import { POST as postProvision } from "@/app/api/provision/route";
import { signAgreement } from "@/lib/agreements";
import {
  depositDecision,
  effectiveDepositUsd,
  findService,
  readClinicDepositFacts,
} from "@/lib/billing/deposits";
import { setupDeadline } from "@/lib/clinic/setup-window";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { notifyCalendarState } from "@/lib/notices/calendar-state";
import { destroyClinicData, startOffboarding } from "@/lib/offboarding/offboarding";
import { runOperation, type Operator } from "@/lib/ops/api";
import { provisionClinic } from "@/lib/provisioning";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { setJobEnabled, JOB_SETUP_REMINDERS } from "@/lib/scheduler/jobs";
import { queueSetupClosedEmail } from "@/lib/setup/closure-email";
import { queueSetupReminder, runSetupRemindersJob } from "@/lib/setup/reminders";
import { saveSetupScreen, skipSetupScreen, type SaveContext } from "@/lib/setup/save";
import { readProgress, resumeScreen } from "@/lib/setup/screens";

import { agreementRecord, intentRecord, records } from "./setup/checkout-records";
import type { SetupSeed } from "@/lib/setup/seed";
import { loadSetupState } from "@/lib/setup/state";
import { buildTracker } from "@/lib/setup/tracker";
import { urgentHelpNumber } from "@/lib/setup/urgent";
import {
  runWelcomeBackstop,
  sendWelcomeEmail,
  WELCOME_RETRY_AFTER_MS,
} from "@/lib/setup/welcome-email";
import { consumeSignInLink } from "@/lib/sign-in/links";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The setup wizard end to end against the database (plan Part E, C2, C4 and
 * Annex X5's B1, O7, O13 and the day-30 closure): what provisioning seeds
 * from the purchase, the welcome email once per clinic with its receipt and
 * its backstop, each screen's save and skip, the resume point, the reminders
 * and their schedule across a time zone correction, the closure email's seam,
 * the calendar emails, the ops console's writers keeping what setup stores,
 * and the grants and destruction rules of the two tables 0056 adds.
 */

const SECRET = "setup-wizard-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

const describeDb = hasTestDatabase ? describe : describe.skip;
const SERVICE = { type: "service", serviceName: "setup-wizard-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

function signed(url: string, body: unknown): Request {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
    },
    body: raw,
  });
}

/** A website read of a two-location med spa, as apps/web hands it to the intent. */
function profile(website: string): ClinicProfile {
  const hours = {
    sun: [],
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "20:00"]],
    fri: [["09:00", "17:00"]],
    sat: [["10:00", "14:00"]],
  } as const;
  return {
    version: 1,
    website,
    readAt: "2026-10-07T09:00:00.000Z",
    pages: 3,
    locations: [
      {
        label: "Glow Downtown",
        address: "1200 Congress Ave, Austin, TX 78701",
        phone: "(512) 555-0142",
        hours,
      },
      {
        label: "Glow North",
        address: "9000 Burnet Rd, Austin, TX 78758",
        phone: "(512) 555-0199",
        hours: null,
      },
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
      {
        name: "Chemical peel",
        priceKind: "from",
        priceUsd: 150,
        maxUsd: null,
        unit: null,
        durationMinutes: 45,
      },
      {
        name: "Laser session",
        priceKind: "per_unit",
        priceUsd: 14.5,
        maxUsd: null,
        unit: "pulse",
        durationMinutes: 30,
      },
    ],
    providers: [{ name: "Dana Reyes", title: "Nurse injector" }],
    policies: ["Cancel at least 24 hours ahead.", "Safe for every skin type."],
    faqs: [{ question: "Where do I park?", answer: "Free parking behind the building." }],
    acceptsInsurance: "no",
    practiceKind: "med-spa",
    dropped: 1,
  } as unknown as ClinicProfile;
}

/**
 * The current agreement, BAA 1.3.0 since its release, signed with the two
 * calendar answers it reads and the platform the booking system implies, as
 * the funnel's agreement step sends them.
 */
async function agreementFor(
  email: string,
  answers: { bookingSystem: BookingSystemId; calendarAccount: CalendarAccount } = {
    bookingSystem: "none",
    calendarAccount: "workspace_no_baa",
  },
  isCoveredEntity: boolean | null = false,
) {
  const result = await signAgreement({
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    signatoryName: "Laura Owner",
    signatoryTitle: "Owner",
    signatoryEmail: email,
    isCoveredEntity,
    attributionMode: "estimated",
    platform: agreementPlatformFor(answers.bookingSystem),
    bookingSystem: answers.bookingSystem,
    calendarAccount: answers.calendarAccount,
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  return result.agreementId;
}

type Provisioned = { clinicId: string; slug: string; userId: string; email: string };

/** The paid first invoice's hosted page, as the invoice.paid relay passes it. */
const RECEIPT_URL = "https://invoice.stripe.com/i/acct_1Test/test_c2V0dXAgZmVlIHJlY2VpcHQ";

/** A purchase through an intent and a paid first invoice, as production makes one. */
async function purchaseAndProvision(
  options: {
    bookingSystem?: BookingSystemId;
    platform?: string;
    hostedInvoiceUrl?: string | null;
  } = {},
): Promise<Provisioned & { provisionBody: Record<string, unknown> }> {
  const email = `laura-${randomUUID().slice(0, 8)}@glowspa.test`;
  const platform = options.platform ?? "mindbody";
  const bookingSystem = options.bookingSystem ?? "mindbody";
  const agreementId = randomUUID();
  const nonce = createHash("sha256").update(randomBytes(24)).digest("hex");
  const website = "glowmedspa.com";
  // The purchase as apps/web records it at Pay (since 14 October 2026, in the
  // marketing Sheet), relayed with the first paid invoice and imported.
  const agreement = agreementRecord(
    { signatoryEmail: email, platform: agreementPlatformFor(bookingSystem), bookingSystem, calendarAccount: "workspace_no_baa" },
    { id: agreementId },
  );
  const purchase = intentRecord(agreement, {
    purchase: {
      clinicName: "Glow Med Spa LLC",
      specialty: "med-spa",
      platform,
      plan: "voice-webchat-1000-1000",
      billingInterval: "month",
      contactName: "Laura Owner",
      contactEmail: email,
      agreementId,
      isCoveredEntity: false,
      inviteRef: null,
      nonceHash: nonce,
      bookingSystem,
      calendarAccount: "workspace_no_baa",
      website,
      profile: profile(website),
      profileStatus: "read",
      timezone: "America/Los_Angeles",
      terms: { version: "2026-10-07.1", acceptedAt: new Date().toISOString(), ip: "203.0.113.4" },
    },
  });
  const saved = { ref: purchase.ref };
  const sub = `sub_test_${randomUUID().slice(0, 8)}`;
  const provisionBody = {
    ref: saved.ref,
    idempotencyKey: sub,
    stripeCustomerId: `cus_test_${randomUUID().slice(0, 8)}`,
    stripeSubscriptionId: sub,
    attempt: 1,
    plan: "voice-webchat-1000-1000",
    billingInterval: "month",
    hostedInvoiceUrl:
      options.hostedInvoiceUrl === undefined ? RECEIPT_URL : options.hostedInvoiceUrl,
    records: records(agreement, purchase),
  };
  const provisioned = await postProvision(signed("http://app.test/api/provision", provisionBody));
  const json = (await provisioned.json()) as { clinicId: string; clinicSlug: string };
  expect(provisioned.status).toBe(201);
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `select id from "user" where email = $1`,
    [email],
  );
  return {
    clinicId: json.clinicId,
    slug: json.clinicSlug,
    userId: rows[0]!.id,
    email,
    provisionBody,
  };
}

/** A clinic made by provisioning directly, with the seed given (no intent). */
async function provisionDirect(
  label: string,
  options: {
    plan?: string;
    isCoveredEntity?: boolean | null;
    setup?: SetupSeed;
    timezone?: string;
    callRouting?: "conditional" | "always";
  } = {},
): Promise<Provisioned> {
  const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
  const agreementId = await agreementFor(
    email,
    undefined,
    options.isCoveredEntity === undefined ? false : options.isCoveredEntity,
  );
  const result = await provisionClinic(
    {
      clinicName: "Glow Med Spa LLC",
      specialty: "med-spa",
      platform: "none",
      plan: options.plan ?? "voice-webchat-1000-1000",
      billingInterval: "month",
      contactName: "Laura Owner",
      contactEmail: email,
      agreementId,
      timezone: options.timezone ?? "America/New_York",
      ...(options.callRouting ? { callRouting: options.callRouting } : {}),
      idempotencyKey: `idem-${randomUUID()}`,
    },
    {},
    options.setup ? { setup: options.setup } : {},
  );
  return { clinicId: result.clinicId, slug: result.clinicSlug, userId: result.ownerUserId!, email };
}

function contextOf(clinic: Provisioned, actorLabel = "Front desk Mac"): SaveContext {
  return { clinicId: clinic.clinicId, slug: clinic.slug, userId: clinic.userId, actorLabel };
}

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail) {
    this.sent.push({ target, message });
    return { status: "sent" as const, messageId: `msg_${this.sent.length}` };
  }
}

/** Run as the runtime role inside a clinic's tenant, for the grant checks. */
async function asApp<T>(
  clinicId: string,
  fn: (c: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  }) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const result = await fn(client as never);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describeDb("the setup wizard", () => {
  test("a Meta Chat clinic with no website gets no website-chat channel to set up", async () => {
    // Inside the clinic's tenant: clinic_channels is RLS'd like every tenant table.
    const channelsOf = (clinicId: string) =>
      asApp(clinicId, async (c) =>
        (await c.query(`select channel from clinic_channels where clinic_id = $1 order by channel`, [clinicId])).rows.map(
          (r) => r.channel,
        ),
      );
    // Meta Chat includes the website, and a practice with one keeps the row.
    const withSite = await provisionDirect("metasite", {
      plan: "voice-metachat-500-300",
      setup: { website: "glowmedspa.com" },
    });
    expect(await channelsOf(withSite.clinicId)).toEqual(["meta", "voice", "web"]);
    // Without one, the wizard would list a step the clinic can never finish.
    const noSite = await provisionDirect("metanosite", { plan: "voice-metachat-500-300", setup: { website: null } });
    expect(await channelsOf(noSite.clinicId)).toEqual(["meta", "voice"]);
  });

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  describe("what provisioning seeds from the purchase", () => {
    test("settings, the practice, knowledge and the baseline, from the funnel's answers and the read", async () => {
      const clinic = await purchaseAndProvision();
      const pool = getMigratorPool();

      const { rows: clinics } = await pool.query(
        `select timezone, address, website, site_profile, published_phone_e164, opening_hours,
                booking_requirements_source, onboarding
           from clinics where id = $1`,
        [clinic.clinicId],
      );
      const row = clinics[0]!;
      // The address first: Austin is Central, whatever the buyer's browser said.
      expect(row.timezone).toBe("America/Chicago");
      expect(row.address).toBe("1200 Congress Ave, Austin, TX 78701");
      expect(row.website).toBe("glowmedspa.com");
      expect(row.published_phone_e164).toBe("+15125550142");
      expect(row.opening_hours.thu).toEqual([["09:00", "20:00"]]);
      expect(row.site_profile.website).toBe("glowmedspa.com");
      // Screened again under the specialty bought: the safety claim is gone.
      expect(row.site_profile.policies).toEqual(["Cancel at least 24 hours ahead."]);
      expect(row.booking_requirements_source).toBe("defaults");
      expect(row.onboarding.booking_requirements_confirmed).toBeTruthy();
      // Hours are pre-filled, not confirmed: the wizard asks.
      expect(row.onboarding.hours_confirmed).toBeNull();

      const settings = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select * from clinic_settings where clinic_id = $1`, [clinic.clinicId]))
            .rows[0]!,
      );
      // Mindbody does not read Google Calendar: manual booking, Auto-confirm off.
      expect(settings).toMatchObject({
        booking_system: "mindbody",
        calendar_account: "workspace_no_baa",
        auto_confirm_bookings: false,
        coverage_mode: "overflow_after_hours",
        tone: "warm",
        languages: ["en"],
        daily_summary: true,
        transcript_retention_days: 90,
      });

      const agent = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select services, policies, quick_answers, never_say from agent_configs`))
            .rows[0]!,
      );
      expect((agent.services as { name: string }[]).map((s) => s.name)).toEqual([
        "Signature facial",
        "Chemical peel",
        "Laser session",
      ]);
      expect((agent.services as unknown[])[2]).toMatchObject({
        priceKind: "per_unit",
        priceFromUsd: 14.5,
        unit: "pulse",
      });
      expect(agent.policies).toEqual(["Cancel at least 24 hours ahead."]);
      expect(agent.quick_answers).toEqual([
        { question: "Where do I park?", answer: "Free parking behind the building." },
      ]);
      expect(agent.never_say).toEqual([...NEVER_SAY_DEFAULTS]);
    });

    test("the read prices count as set up only once the clinic has saved the services screen", async () => {
      const clinic = await purchaseAndProvision();
      const answers = async () => {
        const state = await loadSetupState({
          clinicId: clinic.clinicId,
          userId: clinic.userId,
          actor: SERVICE,
        });
        const calendar = { status: "not_connected", accessRemovedAt: null } as const;
        return buildTracker(state!, calendar).stages.find((stage) => stage.id === "answers")!
          .detail;
      };
      expect(await answers()).toContain("a check of your prices");
      await skipSetupScreen(contextOf(clinic), "services");
      expect(await answers()).toContain("a check of your prices");
      expect(
        await saveSetupScreen(contextOf(clinic), "services", {
          services: [
            { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
          ],
        }),
      ).toMatchObject({ ok: true });
      expect(await answers()).not.toContain("a check of your prices");
    });

    test("a booking system that reads Google Calendar keeps Auto-confirm on", async () => {
      const clinic = await purchaseAndProvision({
        bookingSystem: "google_calendar",
        platform: "none",
      });
      const settings = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select booking_system, auto_confirm_bookings from clinic_settings`))
            .rows[0]!,
      );
      expect(settings).toEqual({ booking_system: "google_calendar", auto_confirm_bookings: true });
    });

    test("a purchase from before intents still gets the defaults and the never-say list", async () => {
      const clinic = await provisionDirect("legacy");
      const agent = await inTenant(
        clinic.clinicId,
        async (c) => (await c.query(`select services, never_say from agent_configs`)).rows[0]!,
      );
      expect(agent.never_say).toEqual([...NEVER_SAY_DEFAULTS]);
      // No read: the specialty's default services stay, for the clinic to price.
      expect((agent.services as unknown[]).length).toBeGreaterThan(0);
      const settings = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select booking_system, auto_confirm_bookings from clinic_settings`))
            .rows[0]!,
      );
      // No intent, but the signed agreement (BAA 1.3.0 reads it) names the
      // booking system: none, which books live, so Auto-confirm stays on.
      expect(settings).toEqual({ booking_system: "none", auto_confirm_bookings: true });
    });
  });

  describe("the welcome email (B1)", () => {
    test("goes once per clinic, with the order's terms, its receipt and a 72-hour link into setup", async () => {
      const clinic = await purchaseAndProvision();
      // Provisioning recorded it as owed and the route tried it after commit,
      // through the console transport in tests, which records "skipped": a
      // send that reached no one. One row, whatever happened.
      expect(await welcomeLedger(clinic)).toEqual([expect.objectContaining({ status: "skipped" })]);
      const transport = new FakeTransport();
      expect(await sendWelcomeEmail(clinic.clinicId, { transport })).toBe("sent");
      expect(transport.sent).toHaveLength(1);
      const { target, message } = transport.sent[0]!;
      expect(target.to).toBe(clinic.email);
      expect(message.subject).toBe("Welcome to healdesk: your order is confirmed");
      expect(message.text).toContain(
        "Monthly billing ($1,200) starts the day AYA first answers a patient.",
      );
      expect(message.text).toContain("version 2026-10-07.1");
      expect(message.text).toContain(
        "Website chat: after setup, you paste one line on your website",
      );
      expect(message.text).toContain("The setup fee is non-refundable.");
      // The setup-fee receipt: the paid first invoice's hosted page, as the
      // relay passed it (contracts §3: no separate receipt for this invoice).
      expect(message.text).toContain("Setup fee: Paid");
      expect(message.text).toContain(`Your setup-fee receipt: ${RECEIPT_URL}`);
      // Cancelling online is the clinic's own Auto-renew, and its signed
      // agreement downloads from its own Billing: both on the public origin.
      expect(message.text).toMatch(/turn off Auto-renew in Billing/);
      expect(message.text).not.toMatch(/reply to this email and we'll cancel/i);
      expect(message.text).toContain(
        `Open Billing: ${publicUrl(`/c/${clinic.slug}/billing#switches`)}`,
      );
      expect(message.text).toContain(
        `Download your signed agreement (PDF): ${publicUrl(`/c/${clinic.slug}/billing/agreement`)}`,
      );
      expect(message.tags).toEqual(
        expect.arrayContaining([
          { name: "app", value: "app" },
          { name: "kind", value: "welcome" },
          { name: "clinic", value: clinic.clinicId },
        ]),
      );
      expect(message.idempotencyKey).toMatch(/^hd-welcome-[0-9a-f-]{36}-1$/);

      const token = /\/link\/([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
      const used = await consumeSignInLink(token, null);
      expect(used).toMatchObject({
        ok: true,
        purpose: "welcome",
        redirectTo: `/c/${clinic.slug}/setup`,
      });

      // Once per clinic.
      expect(await sendWelcomeEmail(clinic.clinicId, { transport })).toBe("already_sent");
      expect(transport.sent).toHaveLength(1);
      const ledger = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select status, period_key from report_deliveries where kind = 'welcome'`))
            .rows,
      );
      expect(ledger).toEqual([{ status: "sent", period_key: "welcome" }]);
    });

    test("a replayed provision makes no second attempt", async () => {
      const clinic = await purchaseAndProvision();
      const before = await welcomeLedger(clinic);
      const again = await postProvision(
        signed("http://app.test/api/provision", clinic.provisionBody),
      );
      expect(again.status).toBe(200);
      expect(await welcomeLedger(clinic)).toEqual(before);
    });

    test("a receipt link that is not Stripe's own is left out, never refused", async () => {
      const clinic = await purchaseAndProvision({
        hostedInvoiceUrl: "https://evil.example/receipt",
      });
      const { rows } = await getMigratorPool().query(
        `select first_invoice_url from checkout_intents where provisioned_clinic_id = $1`,
        [clinic.clinicId],
      );
      expect(rows).toEqual([{ first_invoice_url: null }]);
      const transport = new FakeTransport();
      expect(await sendWelcomeEmail(clinic.clinicId, { transport })).toBe("sent");
      expect(transport.sent[0]!.message.text).not.toContain("receipt");
    });

    test("one whose send never ran is owed from provisioning, and the backstop sends it ten minutes on, once", async () => {
      // provisionClinic itself: no route, so no after-commit send, as when
      // the process exits before that task runs.
      const clinic = await provisionDirect("owed");
      expect(await welcomeLedger(clinic)).toEqual([
        expect.objectContaining({
          status: "failed",
          reason: "owed since provisioning; not yet attempted",
        }),
      ]);
      const transport = new FakeTransport();
      const start = Date.now();
      await runWelcomeBackstop({ now: new Date(start + 5 * 60_000), transport });
      expect(sentFor(transport, clinic)).toHaveLength(0);

      const later = new Date(start + WELCOME_RETRY_AFTER_MS + 60_000);
      await runWelcomeBackstop({ now: later, transport });
      const sent = sentFor(transport, clinic);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.message.subject).toBe("Welcome to healdesk: your order is confirmed");
      expect(await welcomeLedger(clinic)).toEqual([expect.objectContaining({ status: "sent" })]);
      await runWelcomeBackstop({ now: later, transport });
      expect(sentFor(transport, clinic)).toHaveLength(1);
    });

    test("one whose send failed goes again ten minutes on, with a fresh link, and not before", async () => {
      const clinic = await provisionDirect("retry");
      const attempts: OutgoingEmail[] = [];
      const failing: EmailTransport = {
        name: "failing",
        async send(_target: DeliveryTarget, message: OutgoingEmail) {
          attempts.push(message);
          throw new Error("Resend is unreachable");
        },
      };
      expect(await sendWelcomeEmail(clinic.clinicId, { transport: failing })).toBe("failed");
      expect(attempts).toHaveLength(1);
      expect(await welcomeLedger(clinic)).toEqual([expect.objectContaining({ status: "failed" })]);

      const transport = new FakeTransport();
      const start = Date.now();
      await runWelcomeBackstop({ now: new Date(start + 5 * 60_000), transport });
      expect(sentFor(transport, clinic)).toHaveLength(0);
      await runWelcomeBackstop({
        now: new Date(start + WELCOME_RETRY_AFTER_MS + 60_000),
        transport,
      });
      const sent = sentFor(transport, clinic);
      expect(sent).toHaveLength(1);
      // A fresh link, under a fresh key: the failed attempt's never reached anyone.
      expect(sent[0]!.message.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey);
      const token = /\/link\/([A-Za-z0-9_-]{43})/.exec(sent[0]!.message.text)![1]!;
      expect(await consumeSignInLink(token, null)).toMatchObject({ ok: true, purpose: "welcome" });
    });

    test("one setup has moved past is not sent late: it is marked skipped and ops is told, once", async () => {
      const clinic = await provisionDirect("lapsed");
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
          clinic.clinicId,
          new Date(Date.now() - 3_600_000),
        ]),
      );
      const transport = new FakeTransport();
      const later = new Date(Date.now() + WELCOME_RETRY_AFTER_MS + 60_000);
      await runWelcomeBackstop({ now: later, transport });
      await runWelcomeBackstop({ now: later, transport });
      expect(sentFor(transport, clinic)).toHaveLength(0);
      expect(await welcomeLedger(clinic)).toEqual([
        expect.objectContaining({
          status: "skipped",
          reason: "not sent: the setup window has ended",
        }),
      ]);
      const { rows } = await getMigratorPool().query(
        `select repeats from ops_alerts where event = 'welcome_email_unsent' and dedupe_key = $1`,
        [`clinicId=${clinic.clinicId}`],
      );
      expect(rows).toEqual([{ repeats: 0 }]);
    });
  });

  describe("saving and skipping screens", () => {
    let clinic: Provisioned;
    beforeAll(async () => {
      clinic = await provisionDirect("screens");
    });

    test("1.1 saves the practice and moves on; a wrong number is refused and nothing is ticked", async () => {
      const ctx = contextOf(clinic);
      const refused = await saveSetupScreen(ctx, "basics", {
        name: "Glow Med Spa",
        address: "1 Main St, Austin, TX 78701",
        phone: "555",
        website: "",
        timezone: "America/Chicago",
      });
      expect(refused).toMatchObject({ ok: false, field: "phone" });
      expect((await progressOf(clinic)).has("basics")).toBe(false);

      const saved = await saveSetupScreen(ctx, "basics", {
        name: "Glow Med Spa",
        address: "1 Main St, Austin, TX 78701",
        phone: "(512) 555-0100",
        website: "https://glowmedspa.com/",
        timezone: "America/Chicago",
      });
      expect(saved).toEqual({ ok: true, next: `/c/${clinic.slug}/setup?s=hours` });
      const { rows } = await getMigratorPool().query(
        `select name, published_phone_e164, website, timezone, timezone_confirmed_at from clinics where id = $1`,
        [clinic.clinicId],
      );
      expect(rows[0]).toMatchObject({
        name: "Glow Med Spa",
        published_phone_e164: "+15125550100",
        website: "glowmedspa.com",
        timezone: "America/Chicago",
      });
      expect(rows[0]!.timezone_confirmed_at).toBeInstanceOf(Date);
      expect((await progressOf(clinic)).get("basics")?.outcome).toBe("done");
    });

    test("1.2 saves the weekly hours and the closed days, and confirms the hours", async () => {
      const result = await saveSetupScreen(contextOf(clinic), "hours", {
        hours: {
          sun: [],
          mon: [["09:00", "17:00"]],
          tue: [["09:00", "17:00"]],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
        closures: [{ closedOn: "2099-12-25", label: "Christmas" }],
      });
      expect(result.ok).toBe(true);
      const hours = await getMigratorPool().query(
        `select opening_hours, onboarding from clinics where id = $1`,
        [clinic.clinicId],
      );
      expect(hours.rows[0]!.opening_hours.mon).toEqual([["09:00", "17:00"]]);
      expect(hours.rows[0]!.onboarding.hours_confirmed).toBeTruthy();
      const closures = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select closed_on::text as closed_on, label from clinic_closures`)).rows,
      );
      expect(closures).toEqual([{ closed_on: "2099-12-25", label: "Christmas" }]);
      expect(
        await saveSetupScreen(contextOf(clinic), "hours", {
          hours: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
          closures: [],
        }),
      ).toMatchObject({ ok: false, field: "hours" });
    });

    test("1.3 refuses a clinical service name, naming the phrase, and saves a priced list as a new version", async () => {
      const refused = await saveSetupScreen(contextOf(clinic), "services", {
        services: [{ name: "Peel with no downtime", priceKind: "exact", price: 150 }],
      });
      expect(refused).toMatchObject({ ok: false, field: "services[0]" });
      expect((refused as { message: string }).message).toMatch(/recovery or aftercare/);

      const before = await versionOf(clinic);
      const saved = await saveSetupScreen(contextOf(clinic), "services", {
        services: [
          { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
          { name: "Consultation", priceKind: null },
        ],
      });
      expect(saved.ok).toBe(true);
      expect(await versionOf(clinic)).toBe(before + 1);
    });

    test("a skip says what it costs elsewhere, never undoes an answer, and an answer replaces a skip", async () => {
      const ctx = contextOf(clinic);
      expect(await skipSetupScreen(ctx, "question")).toEqual({
        ok: true,
        next: `/c/${clinic.slug}/setup?s=tone`,
      });
      expect((await progressOf(clinic)).get("question")?.outcome).toBe("skipped");
      await saveSetupScreen(ctx, "question", {
        question: "Where do I park?",
        answer: "Behind the building.",
      });
      expect((await progressOf(clinic)).get("question")?.outcome).toBe("done");
      await skipSetupScreen(ctx, "question");
      expect((await progressOf(clinic)).get("question")?.outcome).toBe("done");
    });

    test("2.2 makes coverage_mode the source and keeps call_routing in step for its readers", async () => {
      const saved = await saveSetupScreen(contextOf(clinic), "coverage", {
        coverageMode: "all_calls",
      });
      expect(saved.ok).toBe(true);
      const settings = await inTenant(
        clinic.clinicId,
        async (c) => (await c.query(`select coverage_mode from clinic_settings`)).rows[0]!,
      );
      expect(settings.coverage_mode).toBe("all_calls");
      const { rows } = await getMigratorPool().query(
        `select call_routing, call_routing_confirmed_at, onboarding from clinics where id = $1`,
        [clinic.clinicId],
      );
      expect(rows[0]!.call_routing).toBe("always");
      expect(rows[0]!.onboarding.call_routing_chosen).toBeTruthy();
      await saveSetupScreen(contextOf(clinic), "coverage", { coverageMode: "after_hours_only" });
      const again = await getMigratorPool().query(
        `select call_routing from clinics where id = $1`,
        [clinic.clinicId],
      );
      expect(again.rows[0]!.call_routing).toBe("conditional");
    });

    test("2.2 confirms the call routing when the recommended mode is kept as it was", async () => {
      // A funnel purchase carries no call routing: wizard 2.2 settles it, and
      // its commonest answer is the pre-selected, unchanged default.
      const fresh = await provisionDirect("coverage-default");
      const before = await getMigratorPool().query(
        `select call_routing_confirmed_at, onboarding from clinics where id = $1`,
        [fresh.clinicId],
      );
      expect(before.rows[0]!.call_routing_confirmed_at).toBeNull();
      expect(before.rows[0]!.onboarding.call_routing_chosen).toBeNull();
      expect(
        await saveSetupScreen(contextOf(fresh), "coverage", {
          coverageMode: "overflow_after_hours",
        }),
      ).toMatchObject({ ok: true });
      const { rows } = await getMigratorPool().query(
        `select call_routing, call_routing_confirmed_at, onboarding from clinics where id = $1`,
        [fresh.clinicId],
      );
      expect(rows[0]!.call_routing).toBe("conditional");
      expect(rows[0]!.call_routing_confirmed_at).toBeInstanceOf(Date);
      expect(rows[0]!.onboarding.call_routing_chosen).toBeTruthy();
      const settings = await inTenant(
        fresh.clinicId,
        async (c) => (await c.query(`select coverage_mode from clinic_settings`)).rows[0]!,
      );
      expect(settings.coverage_mode).toBe("overflow_after_hours");
    });

    test("2.3 refuses the main number as the direct line, and keeps the before and after of each change", async () => {
      const loop = await saveSetupScreen(contextOf(clinic), "direct_line", {
        directLine: "(512) 555-0100",
      });
      expect(loop).toMatchObject({ ok: false, field: "directLine" });
      expect(
        await saveSetupScreen(contextOf(clinic), "direct_line", { directLine: "(512) 555-0177" }),
      ).toMatchObject({
        ok: true,
      });
      const history = await inTenant(
        clinic.clinicId,
        async (c) =>
          (
            await c.query(
              `select field, before_value, after_value, actor_label from clinic_settings_history where field = 'direct_line_e164'`,
            )
          ).rows,
      );
      expect(history).toEqual([
        {
          field: "direct_line_e164",
          before_value: null,
          after_value: "+15125550177",
          actor_label: "Front desk Mac",
        },
      ]);
    });

    test("2.1 screens the greeting, and 2.5 keeps the urgent number's history", async () => {
      const refused = await saveSetupScreen(contextOf(clinic), "tone", {
        tone: "clinical",
        phoneGreeting: "Our treatments are completely safe.",
      });
      expect(refused).toMatchObject({ ok: false, field: "phoneGreeting" });
      expect(
        await saveSetupScreen(contextOf(clinic), "tone", {
          tone: "clinical",
          phoneGreeting: "Thanks for calling Glow. What can I do for you?",
        }),
      ).toMatchObject({ ok: true });
      expect(
        await saveSetupScreen(contextOf(clinic), "urgent", { urgentHelp: "512 555 0188" }),
      ).toMatchObject({ ok: true });
      const rows = await inTenant(clinic.clinicId, async (c) => ({
        settings: (
          await c.query(`select tone, phone_greeting, urgent_help_e164 from clinic_settings`)
        ).rows[0]!,
        history: (
          await c.query(
            `select field, after_value from clinic_settings_history where field = 'urgent_help_e164'`,
          )
        ).rows,
      }));
      expect(rows.settings).toEqual({
        tone: "clinical",
        phone_greeting: "Thanks for calling Glow. What can I do for you?",
        urgent_help_e164: "+15125550188",
      });
      expect(rows.history).toEqual([{ field: "urgent_help_e164", after_value: "+15125550188" }]);
    });

    test("2.5 keeps the urgent number on the direct line's default, so it follows a changed line", async () => {
      // The direct line is (512) 555-0177 from 2.3. Saving it again as the
      // urgent number, or leaving the field empty, is the default, not a copy.
      expect(
        await saveSetupScreen(contextOf(clinic), "urgent", { urgentHelp: "(512) 555-0177" }),
      ).toMatchObject({ ok: true });
      const stored = async () =>
        inTenant(
          clinic.clinicId,
          async (c) =>
            (await c.query(`select urgent_help_e164 from clinic_settings`)).rows[0]!
              .urgent_help_e164,
        );
      expect(await stored()).toBeNull();
      expect(await saveSetupScreen(contextOf(clinic), "urgent", { urgentHelp: "" })).toMatchObject({
        ok: true,
      });
      expect(await stored()).toBeNull();
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update clinic_settings set direct_line_e164 = $2 where clinic_id = $1`, [
          clinic.clinicId,
          "+15125550166",
        ]),
      );
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: SERVICE,
      });
      expect(urgentHelpNumber(state!)).toBe("+15125550166");
    });

    test("2.4 sets a deposit per service by name", async () => {
      expect(
        await saveSetupScreen(contextOf(clinic), "deposits", {
          needsDeposits: true,
          deposits: { "Signature facial": 50, Consultation: null },
        }),
      ).toMatchObject({ ok: true });
      const agent = await inTenant(
        clinic.clinicId,
        async (c) => (await c.query(`select services from agent_configs`)).rows[0]!,
      );
      expect(agent.services).toEqual([
        expect.objectContaining({ name: "Signature facial", depositUsd: 50 }),
        // Left blank, the amount shows "None": no deposit, which BD27 stores as 0.
        expect.objectContaining({ name: "Consultation", depositUsd: 0 }),
      ]);
      expect(
        await saveSetupScreen(contextOf(clinic), "deposits", { needsDeposits: true, deposits: {} }),
      ).toMatchObject({
        ok: false,
        field: "deposits",
      });
    });

    test("2.4's No, and a blank under Yes, ask for no deposit even once the clinic has a default", async () => {
      // BD27 reads a service's 0 as no deposit and an absent one as the clinic
      // default (AgentService.depositUsd), which an operator can set in the
      // console's script form. A clinic that answered No is asked for none.
      const own = await provisionDirect("deposits-none");
      const ctx = contextOf(own);
      expect(
        await saveSetupScreen(ctx, "services", {
          services: [
            { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
            { name: "Chemical peel", priceKind: "from", price: 150, durationMinutes: 45 },
          ],
        }),
      ).toMatchObject({ ok: true });
      expect(await saveSetupScreen(ctx, "deposits", { needsDeposits: false })).toMatchObject({
        ok: true,
      });

      // The operator then sets a $75 default, sending the services back as read.
      const read = await runOperation("getOnboarding", { clinicId: own.clinicId }, OPERATOR);
      const agent = (read.body as { data: { agent: { services: Record<string, unknown>[] } } }).data
        .agent;
      const saved = await runOperation(
        "updateAgentConfig",
        {
          clinicId: own.clinicId,
          greeting: "Thanks for calling Glow. How can I help?",
          services: agent.services,
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: { required: true, amountUsd: 75, collection: "front_desk" },
        },
        OPERATOR,
      );
      expect((saved.body as { data: { status: string } }).data.status).toBe("updated");

      // The deposit each booking is asked for, by BD27's decision as the voice
      // tool makes it, and as the chat channels are to: deposits on,
      // connected, and booking without a deposit off on every channel.
      const asked = () =>
        withTenant({ clinicId: own.clinicId, actor: SERVICE }, async (tx) => {
          const facts = await readClinicDepositFacts(tx);
          return Object.fromEntries(
            ["Signature facial", "Chemical peel", "Something new"].map((name) => {
              const amountUsd = effectiveDepositUsd({
                service: findService(facts.services, name),
                policy: facts.policy,
              });
              return [
                name,
                (["voice", "web", "meta"] as const).map(
                  (channel) =>
                    depositDecision({
                      channel,
                      depositsEnabled: true,
                      isConnected: true,
                      amountUsd,
                      bookVoiceWithoutDeposit: false,
                      bookChatWithoutDeposit: false,
                      uncollectable: "decline_and_alert",
                      canCollectNow: true,
                    }).amountUsd,
                ),
              ];
            }),
          );
        });
      expect(await asked()).toEqual({
        "Signature facial": [null, null, null],
        "Chemical peel": [null, null, null],
        // A service the clinic never listed takes the default, as BD27 has it.
        "Something new": [75, 75, 75],
      });

      // Yes, with one amount and the other left blank: the blank is none too.
      expect(
        await saveSetupScreen(ctx, "deposits", {
          needsDeposits: true,
          deposits: { "Signature facial": 50, "Chemical peel": null },
        }),
      ).toMatchObject({ ok: true });
      expect(await asked()).toEqual({
        "Signature facial": [50, 50, 50],
        "Chemical peel": [null, null, null],
        "Something new": [75, 75, 75],
      });
    });

    test("resumes on the first screen nobody answered or skipped", async () => {
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: SERVICE,
      });
      expect(resumeScreen(state!.screens, state!.progress)).toBe("calendar");
      expect(await saveSetupScreen(contextOf(clinic), "backup", {})).toMatchObject({
        ok: false,
        field: "screen",
      });
    });
  });

  test('1.5 asks the insurance question only after a "Not sure", and records the practice\'s notice', async () => {
    const unsure = await provisionDirect("unsure", { isCoveredEntity: null });
    const state = await loadSetupState({
      clinicId: unsure.clinicId,
      userId: unsure.userId,
      actor: SERVICE,
    });
    expect(state!.screens).toContain("insurance");
    expect(
      await saveSetupScreen(contextOf(unsure), "insurance", { billsInsurance: true }),
    ).toMatchObject({ ok: true });
    const { rows } = await getMigratorPool().query(
      `select is_covered_entity, agreement_kind, onboarding from clinics where id = $1`,
      [unsure.clinicId],
    );
    expect(rows[0]).toMatchObject({ is_covered_entity: true, agreement_kind: "baa" });
    expect(rows[0]!.onboarding.covered_entity_confirmed).toBeTruthy();

    const sure = await provisionDirect("sure", { isCoveredEntity: false });
    const other = await loadSetupState({
      clinicId: sure.clinicId,
      userId: sure.userId,
      actor: SERVICE,
    });
    expect(other!.screens).not.toContain("insurance");
    expect(
      await saveSetupScreen(contextOf(sure), "insurance", { billsInsurance: true }),
    ).toMatchObject({
      ok: false,
      field: "screen",
    });
  });

  describe("the setup reminders (O7)", () => {
    /**
     * A clinic bought at `created` in `timeZone`, its window ending where
     * provisioning ends it: the end of the 30th day there (setupDeadline).
     */
    async function boughtAt(
      label: string,
      created: Date,
      timeZone = "America/New_York",
    ): Promise<Provisioned> {
      const clinic = await provisionDirect(label, { plan: "voice-webchat-1000-1000", timezone: timeZone });
      await getMigratorPool().query(`update clinics set created_at = $2 where id = $1`, [
        clinic.clinicId,
        created,
      ]);
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
          clinic.clinicId,
          setupDeadline(created, timeZone),
        ]),
      );
      return clinic;
    }

    /** A clinic bought `daysAgo` days before `now`. */
    async function boughtDaysAgo(label: string, daysAgo: number, now: Date): Promise<Provisioned> {
      return boughtAt(label, new Date(now.getTime() - daysAgo * 86_400_000));
    }

    // Noon in New York, where provisionDirect's clinics are.
    const noon = new Date("2026-10-20T16:00:00Z");
    const night = new Date("2026-10-20T07:00:00Z");

    test("one on day 5, in the clinic's daytime, once, naming what is left", async () => {
      const clinic = await boughtDaysAgo("remind", 5, noon);
      expect(await queueSetupReminder(clinic.clinicId, night)).toBe("night");
      expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("queued");
      expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("already_queued");
      const rows = await inTenant(
        clinic.clinicId,
        async (c) =>
          (
            await c.query(
              `select id, kind, dedupe_key, payload from billing_notices where kind = 'setup_reminder'`,
            )
          ).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dedupe_key: "setup_reminder:1" });
      const payload = rows[0]!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({ reminderCount: 1, stepsLeftCount: 4 });
      expect(() => assertPayloadAllowed(payload, "setup_reminder")).not.toThrow();

      // The sender renders it from the stored payload and sends it.
      await setJobEnabled("billing-notices", true, await opsUser());
      const transport = new FakeTransport();
      expect(
        await deliverNotice(clinic.clinicId, rows[0]!.id as string, { now: noon, transport }),
      ).toBe("sent");
      expect(transport.sent[0]!.message.subject).toBe(
        "AYA isn't answering patients yet: what's left",
      );
      expect(transport.sent[0]!.message.text).toContain("Finish setup: 4 steps left");
      await setJobEnabled("billing-notices", false, await opsUser());
    });

    test("none before day 5, none once a channel is live, none after the window", async () => {
      expect(await queueSetupReminder((await boughtDaysAgo("early", 3, noon)).clinicId, noon)).toBe(
        "not_due",
      );
      const live = await boughtDaysAgo("live", 10, noon);
      await inTenant(live.clinicId, (c) =>
        c.query(`update clinic_channels set live_at = now() where channel = 'web'`),
      );
      expect(await queueSetupReminder(live.clinicId, noon)).toBe("live");
      expect(await queueSetupReminder((await boughtDaysAgo("late", 40, noon)).clinicId, noon)).toBe(
        "window_over",
      );
    });

    test("none when setup is done and every channel is still being prepared: there is nothing to ask", async () => {
      const clinic = await boughtDaysAgo("prepared", 10, noon);
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: SERVICE,
      });
      for (const screen of state!.screens.filter((s) => s !== "backup")) {
        await skipSetupScreen(contextOf(clinic), screen);
      }
      expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("nothing_to_do");
    });

    test("the job runs only behind its switch, which ships off", async () => {
      expect(await runSetupRemindersJob({ now: noon })).toEqual({ status: "disabled" });
      await setJobEnabled(JOB_SETUP_REMINDERS, true, await opsUser());
      const outcome = await runSetupRemindersJob({ now: noon });
      expect(outcome.status).toBe("ok");
      await setJobEnabled(JOB_SETUP_REMINDERS, false, await opsUser());
    });

    test("a corrected time zone keeps the named last day, and the sixth reminder goes on it", async () => {
      // Bought at 22:00 in Los Angeles on 7 October (01:00 on the 8th in New
      // York), with no address read: provisioning guessed the browser's zone.
      const clinic = await boughtAt(
        "corrected",
        new Date("2026-10-08T05:00:00Z"),
        "America/Los_Angeles",
      );
      const saved = await saveSetupScreen(contextOf(clinic), "basics", {
        name: "Glow Med Spa",
        address: "",
        phone: "",
        website: "",
        timezone: "America/New_York",
      });
      expect(saved.ok).toBe(true);
      const deadline = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select setup_deadline_at from entitlements`)).rows[0]!
            .setup_deadline_at as Date,
      );
      // The end of 6 November, the day the welcome email named, in New York.
      expect(deadline.toISOString()).toBe("2026-11-07T04:59:59.999Z");

      // Noon in New York on 6 November, the last day.
      expect(await queueSetupReminder(clinic.clinicId, new Date("2026-11-06T17:00:00Z"))).toBe(
        "queued",
      );
      const queued = await inTenant(
        clinic.clinicId,
        async (c) =>
          (
            await c.query(
              `select dedupe_key, payload from billing_notices where kind = 'setup_reminder'`,
            )
          ).rows,
      );
      expect(queued).toEqual([
        expect.objectContaining({
          dedupe_key: "setup_reminder:6",
          payload: expect.objectContaining({ reminderCount: 6, closesOn: "2026-11-06" }),
        }),
      ]);
      // The closure email names the same day.
      await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, (tx) =>
        queueSetupClosedEmail(tx, "setup_closure"),
      );
      const closed = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select payload from billing_notices where kind = 'setup_closed'`))
            .rows[0]!.payload,
      );
      expect(closed).toMatchObject({ closedOn: "2026-11-06" });
    });

    test("the ops console's time zone correction moves the deadline the same way", async () => {
      const clinic = await boughtAt(
        "ops-zone",
        new Date("2026-10-08T02:00:00Z"),
        "America/New_York",
      );
      const result = await runOperation(
        "setClinicTimezone",
        { clinicId: clinic.clinicId, timezone: "America/Los_Angeles" },
        OPERATOR,
      );
      expect(result).toMatchObject({ body: { data: { status: "updated" } } });
      const deadline = await inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select setup_deadline_at from entitlements`)).rows[0]!
            .setup_deadline_at as Date,
      );
      // No longer 21:00 in Los Angeles on the named day: its end.
      expect(deadline.toISOString()).toBe("2026-11-07T07:59:59.999Z");
    });
  });

  test("the closure email is queued once, and only for a setup closure", async () => {
    const clinic = await provisionDirect("closure");
    const queued = await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, async (tx) => [
      await queueSetupClosedEmail(tx, "customer.subscription.deleted"),
      await queueSetupClosedEmail(tx, "setup_closure"),
      await queueSetupClosedEmail(tx, "setup_closure"),
    ]);
    expect(queued).toEqual([false, true, false]);
    const rows = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select dedupe_key, payload from billing_notices where kind = 'setup_closed'`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(() => assertPayloadAllowed(rows[0]!.payload, "setup_closed")).not.toThrow();
  });

  test("starting offboarding for a setup closure queues the closure email in its transaction, once", async () => {
    // The seam lib/setup/closure-email.ts names, wired: Package C's deletion
    // handler starts offboarding with the reason "setup_closure", and
    // startOffboarding queues the email right after the database's stamp.
    const closing = await provisionDirect("seam-closure");
    const leaving = await provisionDirect("seam-leaving");
    const closureEmails = (clinicId: string) =>
      inTenant(
        clinicId,
        async (c) =>
          (await c.query(`select dedupe_key from billing_notices where kind = 'setup_closed'`))
            .rows,
      );
    const startedAt = async (clinicId: string) =>
      (
        await getMigratorPool().query<{ offboarding_started_at: Date | null }>(
          `select offboarding_started_at from clinics where id = $1`,
          [clinicId],
        )
      ).rows[0]!.offboarding_started_at;

    // A closure that rolls back queues nothing, and starts nothing.
    await expect(
      withTenant({ clinicId: closing.clinicId, actor: SERVICE }, async (tx) => {
        await startOffboarding(tx, "setup_closure");
        throw new Error("the closure rolled back");
      }),
    ).rejects.toThrow("the closure rolled back");
    expect(await closureEmails(closing.clinicId)).toEqual([]);
    expect(await startedAt(closing.clinicId)).toBeNull();

    // Committed, it queues one; started again, as a second delivery of the
    // deletion would, it queues no other.
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await withTenant({ clinicId: closing.clinicId, actor: SERVICE }, (tx) =>
        startOffboarding(tx, "setup_closure"),
      );
    }
    expect(await closureEmails(closing.clinicId)).toEqual([{ dedupe_key: "setup_closed" }]);
    expect(await startedAt(closing.clinicId)).not.toBeNull();

    // Every other reason, Stripe's own and the ops console's, queues nothing.
    for (const reason of ["customer.subscription.deleted", "operator"]) {
      await withTenant({ clinicId: leaving.clinicId, actor: SERVICE }, (tx) =>
        startOffboarding(tx, reason),
      );
    }
    expect(await closureEmails(leaving.clinicId)).toEqual([]);
    expect(await startedAt(leaving.clinicId)).not.toBeNull();
  });

  test("the ops console cannot start offboarding with the setup closure's reason", async () => {
    // The console's reason is free text an operator types. Only the deletion
    // handler may pass "setup_closure": typed by hand, it would tell the
    // clinic its account had closed with nothing cancelled, and the email's
    // dedupe would then hold back the real one.
    const clinic = await provisionDirect("ops-closure-reason");
    const closureEmails = async () =>
      inTenant(
        clinic.clinicId,
        async (c) =>
          (await c.query(`select dedupe_key from billing_notices where kind = 'setup_closed'`))
            .rows,
      );
    const startedAt = async () =>
      (
        await getMigratorPool().query<{ offboarding_started_at: Date | null }>(
          `select offboarding_started_at from clinics where id = $1`,
          [clinic.clinicId],
        )
      ).rows[0]!.offboarding_started_at;

    for (const reason of ["setup_closure", " Setup_Closure "]) {
      const refused = await runOperation(
        "startOffboarding",
        { clinicId: clinic.clinicId, reason },
        OPERATOR,
      );
      expect((refused.body as { data: { status: string; message?: string } }).data).toEqual({
        status: "error",
        message: expect.stringMatching(/Close the unfinished setup/),
      });
    }
    expect(await closureEmails()).toEqual([]);
    expect(await startedAt()).toBeNull();

    // Any other reason starts it, and queues no closure email.
    const started = await runOperation(
      "startOffboarding",
      { clinicId: clinic.clinicId, reason: "cancelled by phone" },
      OPERATOR,
    );
    expect((started.body as { data: { status: string } }).data.status).toBe("updated");
    expect(await startedAt()).not.toBeNull();
    expect(await closureEmails()).toEqual([]);
  });

  test("the calendar emails (O13) are queued in the caller's transaction, once per key, and never break it", async () => {
    const clinic = await provisionDirect("calendar");
    await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, async (tx) => {
      await notifyCalendarState(tx.db, clinic.clinicId, "stopped", { dedupeKey: "conn-1:broken" });
      await notifyCalendarState(tx.db, clinic.clinicId, "stopped", { dedupeKey: "conn-1:broken" });
      // A notice the CHECK refuses fails inside its savepoint, not the caller's transaction.
      vi.spyOn(console, "error").mockImplementation(() => {});
      await notifyCalendarState(tx.db, clinic.clinicId, "stopped", { dedupeKey: "" });
      vi.restoreAllMocks();
    });
    // A transaction that rolls back sends nothing.
    await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, async (tx) => {
      await notifyCalendarState(tx.db, clinic.clinicId, "reconnected", {
        dedupeKey: "conn-1:back",
      });
      throw new Error("roll back");
    }).catch(() => undefined);
    const rows = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select kind, dedupe_key, payload from billing_notices where kind like 'calendar_%'`,
          )
        ).rows,
    );
    expect(rows.map((r) => [r.kind, r.dedupe_key])).toEqual([
      ["calendar_stopped", "conn-1:broken"],
    ]);
    // Settings, never the wizard: a reconnect from the wizard's calendar step
    // counts as a setup connect, which sends no "reconnected".
    expect((rows[0]!.payload as { calendarUrl: string }).calendarUrl).toBe(
      `${process.env.BETTER_AUTH_URL}/c/${clinic.slug}/settings#calendar`,
    );
  });

  describe("the ops console's writers keep what setup stores", () => {
    test("an agent-config save keeps each service's kind, unit, deposit and cents", async () => {
      const clinic = await purchaseAndProvision();
      // 2.4 sets a deposit on the read per-pulse service.
      expect(
        await saveSetupScreen(contextOf(clinic), "deposits", {
          needsDeposits: true,
          deposits: { "Laser session": 25 },
        }),
      ).toMatchObject({ ok: true });
      const read = await runOperation("getOnboarding", { clinicId: clinic.clinicId }, OPERATOR);
      const agent = (
        read.body as { data: { agent: { greeting: string; services: Record<string, unknown>[] } } }
      ).data.agent;
      // What the console's form sent before it knew the new keys: four fields.
      const stripped = agent.services.map((s) => ({
        name: s.name,
        priceFromUsd: s.priceFromUsd,
        priceToUsd: s.priceToUsd,
        durationMinutes: s.durationMinutes,
      }));
      const saved = await runOperation(
        "updateAgentConfig",
        {
          clinicId: clinic.clinicId,
          greeting: "Thanks for calling Glow. How can I help?",
          services: stripped,
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: null,
        },
        OPERATOR,
      );
      expect((saved.body as { data: { status: string } }).data.status).toBe("updated");
      const services = async () =>
        inTenant(
          clinic.clinicId,
          async (c) =>
            (await c.query(`select services from agent_configs`)).rows[0]!.services as Record<
              string,
              unknown
            >[],
        );
      expect(await services()).toEqual([
        expect.objectContaining({
          name: "Signature facial",
          priceKind: "exact",
          priceFromUsd: 199,
          priceToUsd: 199,
        }),
        expect.objectContaining({ name: "Chemical peel", priceKind: "from", priceFromUsd: 150 }),
        expect.objectContaining({
          name: "Laser session",
          priceKind: "per_unit",
          priceFromUsd: 14.5,
          priceToUsd: null,
          unit: "pulse",
          depositUsd: 25,
        }),
      ]);

      // And the console as it is now, sending back what it was given.
      const full = await runOperation(
        "updateAgentConfig",
        {
          clinicId: clinic.clinicId,
          greeting: "Thanks for calling Glow. How can I help today?",
          services: agent.services,
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: null,
        },
        OPERATOR,
      );
      expect((full.body as { data: { status: string } }).data.status).toBe("updated");
      expect((await services())[2]).toMatchObject({
        priceKind: "per_unit",
        priceFromUsd: 14.5,
        unit: "pulse",
        depositUsd: 25,
      });
    });

    test("a deposit setup stores is one the console's save accepts: $10,000 at most (BD27)", async () => {
      // validateAgentConfig refuses a deposit above $10,000, and the console
      // sends every deposit back as it read it: one stored above that would
      // have each later save of the clinic's script refused.
      const clinic = await provisionDirect("deposit-cap");
      const ctx = contextOf(clinic);
      const bridal = {
        name: "Bridal glow package",
        priceKind: "exact",
        price: 15_000,
        durationMinutes: 90,
      };
      expect(await saveSetupScreen(ctx, "services", { services: [bridal] })).toMatchObject({
        ok: true,
      });
      expect(
        await saveSetupScreen(ctx, "deposits", {
          needsDeposits: true,
          deposits: { "Bridal glow package": 10_000.01 },
        }),
      ).toMatchObject({ ok: false, field: "deposits" });
      // The services screen carries a deposit through, and holds it to the same range.
      expect(
        await saveSetupScreen(ctx, "services", {
          services: [{ ...bridal, depositUsd: 12_000 }],
        }),
      ).toMatchObject({ ok: false, field: "services[0]" });
      expect(
        await saveSetupScreen(ctx, "deposits", {
          needsDeposits: true,
          deposits: { "Bridal glow package": 10_000 },
        }),
      ).toMatchObject({ ok: true });

      const read = await runOperation("getOnboarding", { clinicId: clinic.clinicId }, OPERATOR);
      const agent = (read.body as { data: { agent: { services: Record<string, unknown>[] } } }).data
        .agent;
      expect(agent.services).toEqual([
        expect.objectContaining({ name: "Bridal glow package", depositUsd: 10_000 }),
      ]);
      const saved = await runOperation(
        "updateAgentConfig",
        {
          clinicId: clinic.clinicId,
          greeting: "Thanks for calling Glow. How can I help?",
          services: agent.services,
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: null,
        },
        OPERATOR,
      );
      expect((saved.body as { data: { status: string } }).data).toMatchObject({
        status: "updated",
      });
    });

    test("an operator's call routing moves coverage_mode, and provisioning starts it from the purchase", async () => {
      const clinic = await provisionDirect("ops-routing");
      const mode = async () =>
        inTenant(
          clinic.clinicId,
          async (c) =>
            (await c.query(`select coverage_mode from clinic_settings`)).rows[0]!.coverage_mode,
        );
      const route = (callRouting: string) =>
        runOperation("setPhoneSettings", { clinicId: clinic.clinicId, callRouting }, OPERATOR);
      await route("always");
      expect(await mode()).toBe("all_calls");
      await route("conditional");
      expect(await mode()).toBe("overflow_after_hours");
      // After hours only also rings the clinic first: "conditional" keeps it.
      await saveSetupScreen(contextOf(clinic), "coverage", { coverageMode: "after_hours_only" });
      await route("conditional");
      expect(await mode()).toBe("after_hours_only");

      const always = await provisionDirect("bought-always", { callRouting: "always" });
      const seeded = await inTenant(
        always.clinicId,
        async (c) => (await c.query(`select coverage_mode from clinic_settings`)).rows[0]!,
      );
      expect(seeded.coverage_mode).toBe("all_calls");
    });
  });

  describe("the tables 0056 adds", () => {
    test("the settings history is append-only and the progress cannot be moved, by the runtime role", async () => {
      const clinic = await provisionDirect("grants");
      await saveSetupScreen(contextOf(clinic), "urgent", { urgentHelp: "(512) 555-0101" });
      const codes = await asApp(clinic.clinicId, async (c) => {
        const attempt = async (sql: string) => {
          await c.query("savepoint s");
          try {
            await c.query(sql);
            return "ok";
          } catch (error) {
            await c.query("rollback to savepoint s");
            return (error as { code?: string }).code;
          }
        };
        return {
          updateHistory: await attempt(
            `update clinic_settings_history set after_value = '+15125550000'`,
          ),
          deleteHistory: await attempt(`delete from clinic_settings_history`),
          moveScreen: await attempt(`update clinic_setup_screens set screen = 'basics'`),
          retickScreen: await attempt(`update clinic_setup_screens set outcome = 'skipped'`),
          deleteScreens: await attempt(`delete from clinic_setup_screens`),
        };
      });
      expect(codes).toEqual({
        updateHistory: "42501",
        deleteHistory: "42501",
        moveScreen: "42501",
        retickScreen: "ok",
        deleteScreens: "ok",
      });
    });

    test("one clinic never sees another's progress or history", async () => {
      const a = await provisionDirect("iso-a");
      const b = await provisionDirect("iso-b");
      await saveSetupScreen(contextOf(a), "urgent", { urgentHelp: "(512) 555-0102" });
      const seen = await asApp(b.clinicId, async (c) => ({
        screens: (
          await c.query(`select 1 from clinic_setup_screens where clinic_id = $1`, [a.clinicId])
        ).rows.length,
        history: (
          await c.query(`select 1 from clinic_settings_history where clinic_id = $1`, [a.clinicId])
        ).rows.length,
      }));
      expect(seen).toEqual({ screens: 0, history: 0 });
    });

    test("destruction deletes the wizard's progress and keeps the settings history", async () => {
      const clinic = await provisionDirect("destroy");
      await saveSetupScreen(contextOf(clinic), "urgent", { urgentHelp: "(512) 555-0103" });
      // Destruction runs only once the clinic is due by its agreement's rule,
      // by the database's clock (app_destruction_due, drizzle/0058), so start
      // it and move the stamps back as the migrator, which owns the table.
      await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, (tx) =>
        startOffboarding(tx, "operator"),
      );
      await getMigratorPool().query(
        `update clinics
            set offboarding_started_at = offboarding_started_at - interval '31 days',
                destroy_after = destroy_after - interval '31 days'
          where id = $1`,
        [clinic.clinicId],
      );
      const result = await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, (tx) =>
        destroyClinicData(tx),
      );
      expect(result.deleted.clinic_setup_screens).toBe(1);
      const left = await inTenant(clinic.clinicId, async (c) => ({
        screens: (await c.query(`select 1 from clinic_setup_screens`)).rows.length,
        history: (await c.query(`select 1 from clinic_settings_history`)).rows.length,
      }));
      expect(left).toEqual({ screens: 0, history: 1 });
    });

    test("every plan kind passes the outbox's CHECK, and the welcome the ledger's", async () => {
      const clinic = await provisionDirect("kinds");
      await inTenant(clinic.clinicId, async (c) => {
        for (const kind of [
          "setup_reminder",
          "setup_closed",
          "calendar_stopped",
          "calendar_reconnected",
        ]) {
          await c.query(
            `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, $2, 'check')`,
            [clinic.clinicId, kind],
          );
        }
        await c.query(
          `insert into report_deliveries (clinic_id, kind, period_key, recipient, status) values ($1, 'welcome', 'check', 'a@b.test', 'sent')`,
          [clinic.clinicId],
        );
      });
    });

    test("the one-time copy of the call routing puts a clinic that sent every call on All calls", async () => {
      const always = await provisionDirect("routing-always");
      const conditional = await provisionDirect("routing-conditional");
      const pool = getMigratorPool();
      await pool.query(`update clinics set call_routing = 'always' where id = $1`, [
        always.clinicId,
      ]);
      for (const clinic of [always, conditional]) {
        await inTenant(clinic.clinicId, (c) =>
          c.query(`delete from clinic_settings where clinic_id = $1`, [clinic.clinicId]),
        );
      }
      // The migration's own block, run again as the migrator runs it. Found
      // by its tag, not its number: the number is assigned when the branch
      // merges (build spec R27).
      const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
      const files = readdirSync(dir).filter((name) => /^\d{4}_setup_wizard\.sql$/.test(name));
      expect(files).toHaveLength(1);
      const sql = readFileSync(`${dir}${files[0]}`, "utf8");
      const block = /DO \$\$\s*DECLARE\s*previous text[\s\S]*?END;\s*\$\$;/.exec(sql)?.[0];
      expect(block, "0056 copies call_routing into coverage_mode").toBeDefined();
      await pool.query(block!);
      const modes = await Promise.all(
        [always, conditional].map((clinic) =>
          inTenant(
            clinic.clinicId,
            async (c) =>
              (
                await c.query(`select coverage_mode from clinic_settings where clinic_id = $1`, [
                  clinic.clinicId,
                ])
              ).rows,
          ),
        ),
      );
      // A clinic with no row reads the default, Overflow and after hours.
      expect(modes).toEqual([[{ coverage_mode: "all_calls" }], []]);
    });

    test("the setup reminders job ships switched off", async () => {
      const { rows } = await getMigratorPool().query(
        `select enabled from scheduled_jobs where name = 'setup-reminders'`,
      );
      expect(rows).toEqual([{ enabled: false }]);
    });
  });
});

/** The clinic's welcome ledger row: what provisioning recorded and every attempt since. */
async function welcomeLedger(clinic: Provisioned) {
  return inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query(
          `select status, reason, attempted_at from report_deliveries where kind = 'welcome'`,
        )
      ).rows,
  );
}

/** What a transport sent to one clinic: the backstop walks every clinic in the database. */
function sentFor(transport: FakeTransport, clinic: Provisioned) {
  return transport.sent.filter((s) =>
    (s.message.tags ?? []).some((t) => t.name === "clinic" && t.value === clinic.clinicId),
  );
}

async function progressOf(clinic: Provisioned) {
  return withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, (tx) =>
    readProgress(tx.db, clinic.clinicId),
  );
}

async function versionOf(clinic: Provisioned): Promise<number> {
  return inTenant(clinic.clinicId, async (c) =>
    Number((await c.query(`select version from agent_configs`)).rows[0]!.version),
  );
}

let opsUserId: string | null = null;
async function opsUser(): Promise<string> {
  if (opsUserId) return opsUserId;
  const id = `usr_ops_${randomUUID().slice(0, 8)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
    [id, `${id}@healdesk.test`],
  );
  opsUserId = id;
  return id;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
