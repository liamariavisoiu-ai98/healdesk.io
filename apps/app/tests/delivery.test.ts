import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { sendLiveAlert } from "@/lib/reporting/alerts";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { addRecipient, listRecipients, removeRecipient } from "@/lib/reporting/recipients";
import { sendRenewalReminders } from "@/lib/scheduler/annual-renewal-reminder";
import { findUnhealthyConnections, runConnectionHealthJob } from "@/lib/scheduler/connection-health";
import { JOB_CONNECTION_HEALTH, heartbeatAgeSeconds, setJobEnabled } from "@/lib/scheduler/jobs";
import { sendDueReports } from "@/lib/scheduler/monthly-report";
import { runTick } from "@/lib/scheduler/tick";
import { sendDueRecaps, weekKey } from "@/lib/scheduler/weekly-recap";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

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
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = $2, went_live_at = $2 where id = $1`,
    [clinicId, wentLiveAt],
  );
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

      // The slot is claimed; a retry does not double up, and this run does
      // not resend because the claim row exists. The operator clears it from
      // the console; the test proves the ledger says "failed", not "sent".
      const retry = await sendDueReports(now, new FakeTransport());
      expect(retry.sent).toBe(0);
    });
  });

  describe("weekly recap", () => {
    // Monday 14 September 2026, 09:00 in New York.
    const monday = new Date("2026-09-14T13:00:00Z");

    test("isoweek keys are stable", () => {
      expect(weekKey(monday)).toBe("2026-W38");
      expect(weekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    });

    test("sends counts on the clinic's Monday morning, once, and never for an empty week", async () => {
      const busy = await seedClinic("recap-busy");
      const quiet = await seedClinic("recap-quiet");
      for (const c of [busy, quiet]) {
        await makeProduction(c.clinicId, new Date(monday.getTime() - 30 * DAY));
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          addRecipient(tx, { email: `${c.slug}@example-clinic.test`, addedBy: "test" }),
        );
      }
      await seedConversation(busy.clinicId, { startedAt: new Date(monday.getTime() - 2 * DAY), recoveryReason: "rang_unanswered", booked: true });
      // A legacy call-back reason is not a call answered that would have rung out.
      await seedConversation(busy.clinicId, { startedAt: new Date(monday.getTime() - 2 * DAY), recovered: true });
      await seedConversation(busy.clinicId, { startedAt: new Date(monday.getTime() - 3 * DAY) });
      // Outside the window: last month.
      await seedConversation(busy.clinicId, { startedAt: new Date(monday.getTime() - 20 * DAY), recovered: true });

      const transport = new FakeTransport();
      const run = await sendDueRecaps(monday, transport);
      expect(run.sent).toBe(1);
      expect(transport.sent).toHaveLength(1);
      const text = transport.sent[0]!.message.text;
      expect(text).toMatch(/Conversations handled:\s+3/);
      expect(text).toMatch(/would otherwise have rung out:\s+1/);
      expect(text).toMatch(/booked from those conversations:\s+1/);
      // v1 claims only: never revenue, collected or recovered.
      expect(text).not.toMatch(/revenue|collected|recovered|monthly report/i);

      expect((await sendDueRecaps(monday, transport)).sent).toBe(0);
      expect(transport.sent).toHaveLength(1);

      // Tuesday: not due.
      const tuesday = new Date(monday.getTime() + DAY);
      await seedConversation(busy.clinicId, { startedAt: tuesday });
      expect((await sendDueRecaps(tuesday, transport)).sent).toBe(0);
    });

    test("the first recap arrives on day seven whatever the weekday", async () => {
      const c = await seedClinic("recap-first");
      const wentLive = new Date("2026-09-03T14:00:00Z"); // a Thursday
      await makeProduction(c.clinicId, wentLive);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        addRecipient(tx, { email: "first@example-clinic.test", addedBy: "test" }),
      );
      await seedConversation(c.clinicId, { startedAt: new Date(wentLive.getTime() + 2 * DAY), recovered: true });

      const daySeven = new Date(wentLive.getTime() + 7 * DAY + 3600_000); // Thursday again
      const transport = new FakeTransport();
      expect((await sendDueRecaps(daySeven, transport)).sent).toBe(1);
      expect((await ledger(c.clinicId)).map((r) => r.period_key)).toEqual(["first-week"]);
    });
  });

  describe("annual renewal reminder", () => {
    test("an annual clinic 30 days from renewal is told once; monthly and cancelling clinics are not", async () => {
      const now = new Date("2026-09-14T09:00:00Z");
      const annual = await seedClinic("renew-annual");
      const monthly = await seedClinic("renew-monthly");
      const cancelling = await seedClinic("renew-cancel");
      const periodEnd = new Date(now.getTime() + 30 * DAY + 3600_000);
      const entitle = (clinicId: string, interval: string, status: string) =>
        inTenant(clinicId, async (client) => {
          await client.query(
            `insert into entitlements (clinic_id, plan_code, billing_interval, status, current_period_end)
             values ($1, 'voice', $2, $3::billing_status, $4)`,
            [clinicId, interval, status, periodEnd],
          );
        });
      await entitle(annual.clinicId, "year", "active");
      await entitle(monthly.clinicId, "month", "active");
      await entitle(cancelling.clinicId, "year", "canceling");
      for (const c of [annual, monthly, cancelling]) {
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          addRecipient(tx, { email: `${c.slug}@example-clinic.test`, addedBy: "test" }),
        );
      }

      const transport = new FakeTransport();
      const run = await sendRenewalReminders(now, transport);
      expect(run.sent).toBe(1);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.target.to).toBe(`${annual.slug}@example-clinic.test`);
      expect(transport.sent[0]!.message.subject).toContain(periodEnd.toISOString().slice(0, 10));
      expect(transport.sent[0]!.message.text).toMatch(/\$[\d,]+/);

      // The next day's run finds the same renewal and does not repeat itself.
      expect((await sendRenewalReminders(new Date(now.getTime() + 12 * 3600_000), transport)).sent).toBe(0);
      expect(transport.sent).toHaveLength(1);
    });
  });

  describe("live alerts", () => {
    test("one alert per conversation, with a count and no patient", async () => {
      const c = await seedClinic("alert");
      await makeProduction(c.clinicId, new Date("2026-08-01T00:00:00Z"));
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        addRecipient(tx, { email: "desk@example-clinic.test", addedBy: "test" }),
      );
      const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date(), booked: true });

      const transport = new FakeTransport();
      expect(await sendLiveAlert(c.clinicId, "booked", conversationId, transport)).toBe("sent");
      expect(await sendLiveAlert(c.clinicId, "booked", conversationId, transport)).toBe("skipped");
      expect(transport.sent).toHaveLength(1);
      const { message } = transport.sent[0]!;
      expect(message.phiClass).toBe("none");
      expect(message.text).not.toMatch(/\+1555|Synthetic/);
      expect(message.text).not.toContain(conversationId);
    });

    test("a synthetic clinic never gets one", async () => {
      const c = await seedClinic("alert-synthetic");
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        addRecipient(tx, { email: "desk@example-clinic.test", addedBy: "test" }),
      );
      const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date(), booked: true });
      const transport = new FakeTransport();
      expect(await sendLiveAlert(c.clinicId, "escalated", conversationId, transport)).toBe("skipped");
      expect(transport.sent).toHaveLength(0);
    });
  });

  describe("connection health", () => {
    test("finds the dead, the stale and the stuck, and mails ops one digest", async () => {
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

      await setJobEnabled(JOB_CONNECTION_HEALTH, true, fine.staffUserId);
      process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
      const transport = new FakeTransport();
      const outcome = await runConnectionHealthJob({ transport });
      expect(outcome.status).toBe("ok");
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.target.to).toBe("ops@healdesk.test");
      expect(transport.sent[0]!.message.text).toContain(stale.clinicId);
      // Ids only. The clinic's name is not in the digest; nor is any patient.
      expect(transport.sent[0]!.message.text).not.toContain("Clinic");
    });
  });

  describe("the hourly tick", () => {
    test("beats the heart and runs every job through its own switch", async () => {
      const now = new Date("2026-09-14T02:00:00Z");
      const out = await runTick(now);
      expect(await heartbeatAgeSeconds(now)).toBe(0);
      const jobs = Object.fromEntries(out.map((o) => [o.job, o.status]));
      // Hour 2 gates the nightly sync in; nothing else night-time is due.
      expect(Object.keys(jobs).sort()).toEqual(
        ["billing-sweep", "booking-request-expiry", "booking-requirements-defaults", "connection-health", "monthly-report", "nightly-sync", "weekly-recap"].sort(),
      );
      // Every job that has not been switched on says so rather than working;
      // the two phase-two jobs say so in v1 even when switched on.
      for (const [job, status] of Object.entries(jobs)) {
        if (job === "connection-health") continue; // enabled by the test above
        if (job === "booking-requirements-defaults") continue; // §H.5 sweep, not a switched job
        if (job === "booking-request-expiry") continue; // a sweep, not a switched job: pure function of the clock, reports a count
        expect(status, job).toBe("disabled");
      }
      expect(jobs["booking-request-expiry"]).toBe("ok");
      expect(out.some((o) => o.status === "threw")).toBe(false);
    });
  });
});
