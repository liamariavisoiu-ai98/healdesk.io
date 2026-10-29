import { annualTotalUsd, getPlan } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setCancelAt } from "@/lib/billing/entitlements";
import { transition } from "@/lib/billing/state-machine";
import { assertPayloadAllowed } from "@/lib/email/lint";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { addRecipient, listRecipients, removeRecipient } from "@/lib/reporting/recipients";
import { renewalNoticeDue, sendRenewalReminders } from "@/lib/scheduler/annual-renewal-reminder";
import { findUnhealthyConnections, runConnectionHealthJob } from "@/lib/scheduler/connection-health";
import { JOB_CONNECTION_HEALTH, heartbeatAgeSeconds, setJobEnabled } from "@/lib/scheduler/jobs";
import { sendDueReports } from "@/lib/scheduler/monthly-report";
import { runTick } from "@/lib/scheduler/tick";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedConversation, seedEntitled } from "./setup/factories";

/**
 * The delivery layer: who gets mail, and the ledger that makes every mailer
 * send once.
 *
 * Every mailer here is tested through a fake transport that records what it
 * was asked to send, so the assertions are about the decision (due or not,
 * once or twice, aggregate or not) and never about SES.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(private readonly outcome: "sent" | "failed" = "sent") {}
  async send(target: DeliveryTarget, message: OutgoingEmail) {
    this.sent.push({ target, message });
    return this.outcome === "sent"
      ? { status: "sent" as const, messageId: `fake-${this.sent.length}` }
      : { status: "failed" as const, reason: "fake transport refused" };
  }
}

async function makeProduction(clinicId: string, wentLiveAt: Date): Promise<void> {
  await bindAgreementInEffect(clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = $2, went_live_at = $2 where id = $1`,
    [clinicId, wentLiveAt],
  );
}

async function paidThrough(clinicId: string): Promise<Date> {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ paid_through: Date }>(`select paid_through from entitlements where clinic_id = $1`, [clinicId]),
  );
  return rows[0]!.paid_through;
}

async function renewalNotices(clinicId: string): Promise<{ dedupe_key: string; payload: Record<string, unknown> }[]> {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices
        where clinic_id = $1 and kind = 'renewal_upcoming' order by created_at`,
      [clinicId],
    ),
  );
  return rows;
}

async function ledger(clinicId: string): Promise<{ kind: string; period_key: string; recipient: string; status: string }[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ kind: string; period_key: string; recipient: string; status: string }>(
      `select kind, period_key, recipient, status from report_deliveries order by attempted_at`,
    );
    return rows;
  });
}

describeDb("delivery", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  describe("recipients", () => {
    test("added, listed lower-cased, removed, and re-adding revives", async () => {
      const c = await seedClinic("recip");
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
        await addRecipient(tx, { email: "  Desk@Example-Clinic.test ", label: "Front desk", addedBy: "test" });
        expect((await listRecipients(tx)).map((r) => r.email)).toEqual(["desk@example-clinic.test"]);
        expect(await removeRecipient(tx, "desk@example-clinic.test", "left the practice")).toBe(true);
        expect(await listRecipients(tx)).toEqual([]);
        // Removing twice is not an error, it is a no-op that says so.
        expect(await removeRecipient(tx, "desk@example-clinic.test", "again")).toBe(false);
        await addRecipient(tx, { email: "desk@example-clinic.test", addedBy: "test" });
        expect((await listRecipients(tx)).length).toBe(1);
      });
    });
  });

  describe("monthly report send path", () => {
    // 2 September: August has ended in every US timezone.
    const now = new Date("2026-09-02T12:00:00Z");

    test("a live production clinic with a recipient gets exactly one report per period", async () => {
      const live = await seedClinic("send-live");
      const synthetic = await seedClinic("send-synthetic");
      const tooNew = await seedClinic("send-new");
      await makeProduction(live.clinicId, new Date("2026-07-15T00:00:00Z"));
      // Went live mid-August: no full month to report on yet.
      await makeProduction(tooNew.clinicId, new Date("2026-08-15T00:00:00Z"));
      for (const c of [live, synthetic, tooNew]) {
        await seedConversation(c.clinicId, { startedAt: new Date("2026-08-10T15:00:00Z"), recovered: true, booked: true });
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          addRecipient(tx, { email: `${c.slug}@example-clinic.test`, addedBy: "test" }),
        );
      }

      const transport = new FakeTransport();
      const first = await sendDueReports(now, transport);
      expect(first.sent).toBe(1);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.target.to).toBe(`${live.slug}@example-clinic.test`);
      expect(transport.sent[0]!.message.phiClass).toBe("none");
      // Aggregate only: the report names no caller.
      expect(transport.sent[0]!.message.text).not.toMatch(/\+1555/);

      const again = await sendDueReports(now, transport);
      expect(again.sent).toBe(0);
      expect(transport.sent).toHaveLength(1);

      const rows = await ledger(live.clinicId);
      expect(rows).toEqual([
        { kind: "monthly", period_key: "2026-08", recipient: `${live.slug}@example-clinic.test`, status: "sent" },
      ]);
      expect(await ledger(synthetic.clinicId)).toEqual([]);
      expect(await ledger(tooNew.clinicId)).toEqual([]);
    });

    test("a failed send is recorded as failed, and is retried by the next run", async () => {
      const c = await seedClinic("send-fail");
      await makeProduction(c.clinicId, new Date("2026-07-01T00:00:00Z"));
      await seedConversation(c.clinicId, { startedAt: new Date("2026-08-10T15:00:00Z"), recovered: true });
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        addRecipient(tx, { email: "fail@example-clinic.test", addedBy: "test" }),
      );

      const broken = await sendDueReports(now, new FakeTransport("failed"));
      expect(broken.failed).toBe(1);
      expect((await ledger(c.clinicId)).map((r) => r.status)).toEqual(["failed"]);

      // The slot was claimed and never sent, so the next run claims it again
      // and sends it (Annex X3: a row claimed but never sent is retried, not
      // skipped). The same row is reused: one ledger row, now "sent".
      const retry = await sendDueReports(now, new FakeTransport());
      expect(retry.sent).toBe(1);
      expect((await ledger(c.clinicId)).map((r) => r.status)).toEqual(["sent"]);

      // And once sent, never again.
      const again = await sendDueReports(now, new FakeTransport());
      expect(again.sent).toBe(0);
    });
  });

  // The weekly recap moved onto the outbox with the daily summary (WP4):
  // tests/claims-and-summary.test.ts.

  describe("annual renewal reminder (BD17, R32)", () => {
    test("each notice has a window, so a missed run is caught up and a late 30-day one is never sent", () => {
      const renews = new Date("2026-12-01T12:00:00Z");
      const at = (days: number) => new Date(renews.getTime() - days * DAY);
      expect(renewalNoticeDue(renews, at(40))).toBeNull();
      expect(renewalNoticeDue(renews, at(31.5))).toBeNull();
      expect(renewalNoticeDue(renews, at(30.5))).toBe(30);
      expect(renewalNoticeDue(renews, at(22.5))).toBe(30);
      expect(renewalNoticeDue(renews, at(21.5))).toBe(21);
      expect(renewalNoticeDue(renews, at(1))).toBe(21);
      expect(renewalNoticeDue(renews, at(0))).toBeNull();
      expect(renewalNoticeDue(renews, at(-3))).toBeNull();
    });

    test("an annual plan is told 30 and 21 days ahead, once each; nobody else is", async () => {
      // Annual plans started a year before the renewal: paid_through is the
      // end of the year paid for, 14 September 2026 at 21:00.
      const startedAt = new Date("2025-09-14T21:00:00Z");
      const renewsAt = new Date("2026-09-14T21:00:00Z");
      const entitle = async (label: string, options: Parameters<typeof seedEntitled>[1]) => {
        const c = await seedClinic(label);
        await seedEntitled(c.clinicId, {
          stripe: { customerId: `cus_${label.replace(/[^a-z]/g, "")}`, subscriptionId: `sub_${label.replace(/[^a-z]/g, "")}` },
          ...options,
        });
        return c;
      };
      const annual = await entitle("renew-annual", { interval: "year", planStartedAt: startedAt, locations: 2 });
      // A monthly plan renewing the same day is told nothing: its renewal is
      // its ordinary monthly invoice.
      const monthly = await entitle("renew-monthly", {
        interval: "month",
        planStartedAt: new Date("2026-08-14T21:00:00Z"),
      });
      const cancelling = await entitle("renew-cancelling", { interval: "year", planStartedAt: startedAt });
      const autoRenewOff = await entitle("renew-autorenew-off", { interval: "year", planStartedAt: startedAt });
      // Bought annual but not started: the placeholder sets no paid_through.
      const waiting = await entitle("renew-waiting", { interval: "year" });
      await withTenant({ clinicId: cancelling.clinicId, actor: ACTOR }, (tx) =>
        transition(tx, "canceling", { actor: "client", reason: "cancel_at_period_end" }),
      );
      await withTenant({ clinicId: autoRenewOff.clinicId, actor: ACTOR }, (tx) =>
        setCancelAt(tx.db, autoRenewOff.clinicId, renewsAt),
      );

      expect((await paidThrough(annual.clinicId)).getTime()).toBe(renewsAt.getTime());
      expect((await paidThrough(monthly.clinicId)).getTime()).toBe(renewsAt.getTime());
      const renewsOn = "2026-09-14";
      const before = new Date(renewsAt.getTime() - 30.5 * DAY);
      await sendRenewalReminders(before);
      const complete = getPlan("voice-metachat-1000-1000")!;
      expect(await renewalNotices(annual.clinicId)).toEqual([
        {
          dedupe_key: `renewal:${renewsOn}:30`,
          payload: {
            renewsOn,
            amountCents: annualTotalUsd(complete) * 100 * 2,
            planName: complete.name,
            locations: 2,
            noticeDays: 30,
          },
        },
      ]);

      // The next day's run finds the same notice already queued.
      await sendRenewalReminders(new Date(before.getTime() + DAY));
      expect(await renewalNotices(annual.clinicId)).toHaveLength(1);

      const later = new Date(renewsAt.getTime() - 21.5 * DAY);
      await sendRenewalReminders(later);
      await sendRenewalReminders(new Date(later.getTime() + DAY));
      const queued = await renewalNotices(annual.clinicId);
      expect(queued.map((n) => n.dedupe_key)).toEqual([`renewal:${renewsOn}:30`, `renewal:${renewsOn}:21`]);
      expect(queued[1]!.payload.noticeDays).toBe(21);
      for (const notice of queued) {
        expect(() => assertPayloadAllowed(notice.payload, "renewal_upcoming")).not.toThrow();
      }

      for (const c of [monthly, cancelling, autoRenewOff, waiting]) {
        expect(await renewalNotices(c.clinicId)).toEqual([]);
      }
      // Nothing goes through the old path any more: no report recipients, no ledger.
      expect(await ledger(annual.clinicId)).toEqual([]);
    });
  });

  describe("connection health", () => {
    test("finds the dead, the stale and the stuck, raises only the dead at once, and mails nothing itself", async () => {
      const stale = await seedClinic("health-stale");
      const revoked = await seedClinic("health-revoked");
      const stuck = await seedClinic("health-stuck");
      const fine = await seedClinic("health-fine");
      const connect = (clinicId: string, status: string) =>
        inTenant(clinicId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into provider_connections
               (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
             values ($1, 'fixture', $2, 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
            [clinicId, status],
          );
          return rows[0]!.id;
        });
      await connect(stale.clinicId, "active");
      await connect(revoked.clinicId, "revoked");
      const stuckConn = await connect(stuck.clinicId, "active");
      const fineConn = await connect(fine.clinicId, "active");
      await inTenant(stuck.clinicId, async (client) => {
        await client.query(
          `insert into sync_runs (clinic_id, connection_id, resource, status, started_at)
           values ($1, $2, 'appointments', 'ok', now() - interval '2 hours')`,
          [stuck.clinicId, stuckConn],
        );
        await client.query(
          `insert into webhook_events (clinic_id, provider, delivery_id, signature_valid, raw_payload, received_at)
           values ($1, 'fixture', 'd1', true, '{}', now() - interval '3 hours')`,
          [stuck.clinicId],
        );
      });
      await inTenant(fine.clinicId, async (client) => {
        await client.query(
          `insert into sync_runs (clinic_id, connection_id, resource, status, started_at)
           values ($1, $2, 'appointments', 'ok', now() - interval '2 hours')`,
          [fine.clinicId, fineConn],
        );
      });

      const findings = await findUnhealthyConnections(new Date());
      const byClinic = Object.fromEntries(findings.map((f) => [f.clinicId, f.condition]));
      expect(byClinic[stale.clinicId]).toBe("stale");
      expect(byClinic[revoked.clinicId]).toBe("revoked");
      expect(byClinic[stuck.clinicId]).toBe("stuck");
      expect(byClinic[fine.clinicId]).toBeUndefined();

      // Since WP5 the job sends no email of its own: every finding is in the
      // 07:00 ops digest (lib/ops/digest.ts), and only a revoked connection
      // is raised at once, as one ops alert with ids and a category.
      await setJobEnabled(JOB_CONNECTION_HEALTH, true, fine.staffUserId);
      await getMigratorPool().query(`delete from ops_alerts where event = 'connection_broken'`);
      const outcome = await runConnectionHealthJob();
      expect(outcome.status).toBe("ok");
      const { rows: raised } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
        `select fields from ops_alerts where event = 'connection_broken'`,
      );
      expect(raised.map((r) => r.fields.clinicId)).toEqual([revoked.clinicId]);
      expect(JSON.stringify(raised)).not.toContain("Clinic");
    });

    test("never reports a Google Calendar connection: it never syncs, and its health is the calendar watch's", async () => {
      const calendar = await seedClinic("health-google");
      for (const status of ["active", "revoked", "error"]) {
        await inTenant(calendar.clinicId, async (client) => {
          await client.query(`delete from provider_connections where clinic_id = $1`, [
            calendar.clinicId,
          ]);
          await client.query(
            `insert into provider_connections
               (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
             values ($1, 'google_calendar', $2, 'x', 'x', 'x', 'x', 'v1', 1)`,
            [calendar.clinicId, status],
          );
        });
        const findings = await findUnhealthyConnections(new Date());
        expect(
          findings.filter((f) => f.clinicId === calendar.clinicId),
          status,
        ).toEqual([]);
      }
    });
  });

  describe("the hourly tick", () => {
    test("beats the heart and runs every job through its own switch", async () => {
      const now = new Date("2026-09-14T02:00:00Z");
      // Never a live Retell call from a test: the fallback sync stays idle.
      const retellKey = process.env.HEALDESK_RETELL_API_KEY;
      delete process.env.HEALDESK_RETELL_API_KEY;
      const out = await runTick(now).finally(() => {
        if (retellKey !== undefined) process.env.HEALDESK_RETELL_API_KEY = retellKey;
      });
      expect(await heartbeatAgeSeconds(now)).toBe(0);
      const jobs = Object.fromEntries(out.map((o) => [o.job, o.status]));
      // Hour 2 gates the nightly sync in; nothing else night-time is due.
      expect(Object.keys(jobs).sort()).toEqual(
        [
          "billing-sweep",
          // The routed/answered counter's sweep (drizzle/0137): every minute
          // from the billing-minute clock, and hourly here as its backstop.
          // Unswitched: L21 is a promise of the Terms.
          "answer-notices",
          "booking-request-expiry",
          "booking-requirements-defaults",
          "connection-health",
          // Every six hours from hour 2: Meta logins that have been dropped
          // are marked so the portal offers Reconnect (lib/meta/token-watch.ts).
          "meta-token-watch",
          "monthly-report",
          "nightly-sync",
          // The daily summary (drizzle/0087) and the weekly recap alone, hourly
          // behind their switches, each on the clinic's own clock.
          "daily-summary",
          "weekly-recap",
          // The Stripe launch's hourly jobs (drizzle/0043), each behind its switch.
          // billing-notices left the tick: the email platform sends notices
          // every minute from the `notices` queue (lib/email/outbox.ts).
          "usage-meter-report",
          "usage-alerts",
          // The Stripe build's hourly jobs (drizzle/0050): the billing reconcile,
          // and the requests worker's hourly backstop.
          "billing-reconcile",
          "billing-requests",
          // Destruction runs every hour (drizzle/0058), on every rule, so a
          // clinic is gone before its agreement's thirty days, or ninety, are up.
          // Its switch widens it: off, it still runs for the clinics whose
          // agreement states the export rule (C19, 12 October 2026).
          "offboarding-destroy",
          // Meta access revoked for every clinic whose service has ended
          // (Terms §7, lib/meta/revoke.ts): a sweep, not a switched job.
          "meta-revoke",
          // After cancellation (drizzle/0086): E6 to the address captured at
          // destruction, right after it and hourly until it goes; and E3, E4
          // and E5 queued for every clinic whose service has ended. Sweeps,
          // not switched jobs.
          "destruction-notices",
          "after-cancellation",
          // The setup reminder (drizzle/0056), hourly behind its switch: each
          // clinic's reminder waits for that clinic's own daytime.
          "setup-reminders",
          // The welcome email's backstop: a sweep, not a switched job, because
          // the welcome it retries goes unswitched at every provisioning.
          "welcome-email",
          // Missed incident deadlines (drizzle/0066), hourly behind its switch.
          "incident-deadlines",
          // The transcript outbox's backstop (drizzle/0069): every minute from
          // the billing-minute queue, and hourly here, behind its switch.
          "transcript-emails",
          // The practice questions' sweep (drizzle/0080), hourly behind the
          // practice-questions switch; the runs go every minute from their queue.
          "practice-questions-sweep",
          // L8, "Request still open" (drizzle/0082), hourly behind its switch:
          // each clinic's goes at its own opening hour.
          "requests-still-open",
          // WP5 (drizzle/0085): the internal health flags and the ops watch,
          // hourly behind their switches. The ops digest joins from 07 UTC.
          "health-flags",
          "ops-watch",
          // Each ops alert's Slack copy (lib/ops/slack.ts): not switched, idle
          // without SLACK_WEBHOOK_URL.
          "ops-slack",
          // Support replies shown in Slack (lane P7i): not switched, idle
          // without the four SLACK_ support settings.
          "support-slack",
          // Calendar writes that need a person, told to ops once each
          // (lib/ops/calendar-write-alerts.ts): a sweep that only alerts.
          "calendar-write-alerts",
          // The deletion records' own clock (drizzle/0063): a sweep, not a
          // switched job, because "no longer than it needs one" waits for no
          // switch.
          "erasure-expiry",
          // A change of a clinic's address takes effect when its 72 hours are
          // up (plan Part D5): a sweep, not a switched job, because the clinic
          // was told the moment.
          "address-changes",
          // Channel events (drizzle/0076): a sweep, not a switched job, over
          // inputs the clinic and the operator set.
          "channel-states",
          // The header's pause: a sweep that records a timed pause's end.
          "ai-pause",
          // The redial records of calls that ended early (drizzle/0108): a
          // deletion at their two hours, never behind a switch.
          "redial-sweep",
          // L22's reminders and the 7-day ops alert (WP9): a sweep, not a
          // switched job, because the practice was told AYA is paused until
          // it signs.
          "agreement-resigns",
          // L32's reminders and ops alerts (drizzle/0094): a sweep, not a
          // switched job, because the BAA's five business days wait for no
          // switch.
          "patient-requests",
          // The website re-reads (the website_drift migration): the missing
          // and corrected reads and the minute queue's backstop, behind
          // site-reads; the monthly drift check, behind website-drift.
          "site-reads",
          "website-drift",
          // The voice fall-through: each AYA number's Retell fallback kept on
          // the clinic's direct line; not switched, idle without its key.
          "retell-fallback",
          // Each clinic's Retell agent and number by code (lib/voice/
          // provision-job.ts); idle without the Retell key.
          "voice-agents",
          // A chat deposit whose link was never made (lib/billing/deposit-sweep.ts):
          // every minute from the billing-minute queue, and hourly here. A sweep,
          // not a switched job: it only hands the front desk a deposit the
          // booking already owes, once, and contacts no patient.
          "deposit-links",
          // The location-quantity check (drizzle/0111), hourly behind its
          // switch, which ships off: Stripe's quantity for locations against
          // the active locations, read-only, told to ops once per episode.
          "location-quantity",
          // Clinics' changes to hours, closed days and providers (drizzle/0114):
          // the minute sweep's backstop, which tells ops of each change
          // unswitched and audits behind clinic-audits; and the hourly
          // fingerprint check and 04 UTC run, behind clinic-audits-hourly.
          "clinic-changes",
          "clinic-audits-hourly",
          // The lifecycle watch (drizzle/0115), hourly behind its switch,
          // which ships off: stages, the reminder ledger and the ops waves.
          "lifecycle-watch",
          // The approval inbox (drizzle/0119), hourly behind its switch,
          // which ships off.
          "approvals-propose",
          // The weekly compliance pack (drizzle/0123), hourly behind its
          // switch, which ships off; due from 07:00 New York on Monday.
          "compliance-pack",
          // The support reply's retries (drizzle/0127), hourly behind their
          // switch, which ships off: the minute queue's backstop.
          "support-send",
          // Inbound support mail's sweep (drizzle/0130), hourly behind its
          // switch, which ships off; reads nothing without the bucket.
          "support-inbound-sweep",
        ].sort(),
      );
      // Every job that has not been switched on says so rather than working;
      // the two phase-two jobs say so in v1 even when switched on.
      for (const [job, status] of Object.entries(jobs)) {
        if (job === "connection-health") continue; // enabled by the test above
        if (job === "booking-requirements-defaults") continue; // §H.5 sweep, not a switched job
        if (job === "booking-request-expiry") continue; // a sweep, not a switched job: pure function of the clock, reports a count
        if (job === "welcome-email") continue; // a sweep: retries only a welcome provisioning recorded as owed
        if (job === "erasure-expiry") continue; // a sweep: empties and deletes only expired deletion records
        if (job === "address-changes") continue; // a sweep: applies only the changes whose 72 hours are up
        if (job === "offboarding-destroy") continue; // widening: runs for 1.3.0 and DPA clinics, switch or not
        if (job === "channel-states") continue; // a sweep: moves production clinics' channels on as their inputs allow
        if (job === "meta-token-watch") continue; // a check, not a switched job: marks only logins Meta says are dead
        if (job === "ai-pause") continue; // a sweep: records the end of a timed pause the clinic set
        if (job === "redial-sweep") continue; // a deletion: the redial records past their two hours
        if (job === "destruction-notices") continue; // a sweep: E6 to an address captured at destruction
        if (job === "after-cancellation") continue; // a sweep: queues E3–E5 for clinics whose service ended
        if (job === "agreement-resigns") continue; // a sweep: L22's reminders for the open re-signs only
        if (job === "meta-revoke") continue; // a sweep: revokes Meta access only for clinics whose service ended
        if (job === "patient-requests") continue; // a sweep: L32's reminders for the unmarked requests only
        if (job === "retell-fallback") continue; // not switched: does nothing until HEALDESK_RETELL_API_KEY is set
        if (job === "voice-agents") continue; // behind the owner's HEALDESK_VOICE_PROVISION_ENABLED, and idle without the Retell key
        if (job === "calendar-write-alerts") continue; // a sweep: tells ops of stuck calendar writes, once each
        if (job === "ops-slack") continue; // not switched: does nothing until SLACK_WEBHOOK_URL is set
        if (job === "support-slack") continue; // not switched: does nothing until the SLACK_ support settings are set
        if (job === "clinic-changes") continue; // tells ops of each recorded change unswitched; its audits stay behind clinic-audits
        if (job === "deposit-links") continue; // a sweep: flags to the front desk only a pending_link deposit with no link, past its grace
        expect(status, job).toBe("disabled");
      }
      expect(jobs["offboarding-destroy"]).toBe("ok");
      expect(jobs["booking-request-expiry"]).toBe("ok");
      expect(jobs["welcome-email"]).toBe("ok");
      expect(jobs["erasure-expiry"]).toBe("ok");
      expect(jobs["address-changes"]).toBe("ok");
      expect(jobs["channel-states"]).toBe("ok");
      expect(jobs["ai-pause"]).toBe("ok");
      expect(jobs["redial-sweep"]).toBe("ok");
      expect(jobs["deposit-links"]).toBe("ok");
      expect(jobs["destruction-notices"]).toBe("ok");
      expect(jobs["after-cancellation"]).toBe("ok");
      expect(jobs["agreement-resigns"]).toBe("ok");
      expect(jobs["meta-revoke"]).toBe("ok");
      expect(jobs["patient-requests"]).toBe("ok");
      expect(jobs["retell-fallback"]).toBe("skipped");
      expect(jobs["voice-agents"]).toBe("skipped");
      expect(jobs["ops-slack"]).toBe("ok");
      expect(jobs["support-slack"]).toBe("ok");
      expect(jobs["calendar-write-alerts"]).toBe("ok");
      expect(jobs["clinic-changes"]).toBe("ok");
      expect(out.some((o) => o.status === "threw")).toBe(false);
    });
  });
});
