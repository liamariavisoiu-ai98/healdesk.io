import { setGoogleTimeouts, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { queueTranscriptEmail, endTranscriptCopy } from "@/lib/conversations/transcript-outbox";
import { runOperation, type Operator } from "@/lib/ops/api";
import { TRANSCRIPTS_PAGE, transcriptDeliverySource } from "@/lib/ops/inbox/transcript-delivery";
import { readOpsInbox } from "@/lib/ops/inbox/run";
import { listStuckCalendarWrites } from "@/lib/ops/stuck-writes-ops";
import { listUndeliveredTranscripts } from "@/lib/ops/transcript-watch-ops";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
} from "./setup/desk-calendar";
import { deskDecide } from "./setup/desk";
import { inTenant, seedClinic, seedConversation, seedEntitled } from "./setup/factories";

/**
 * The cross-clinic monitors of Phase 5, lane P5a: the stuck calendar writes
 * (listStuckCalendarWrites), the undelivered transcript copies
 * (listUndeliveredTranscripts) and Home's row for them. Each is a projection
 * of ids, codes, counts and whole days with the clinic's own name: the exact
 * key sets are asserted, and nothing a patient said, a time or an address
 * may appear. Synthetic data; Google is the in-memory fake.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const ACTOR = { type: "service", serviceName: "p5a-monitors-test" } as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

describeDb("cross-clinic monitors (lane P5a)", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    google = freshGoogle();
  });

  afterEach(() => setGoogleTimeouts(undefined));

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  /* ---------------------------------------------- stuck calendar writes */

  async function confirmWith(clinicId: string, fail: { status: number; reason: string }, days: number, hour: number) {
    const r = await phoneRequest(clinicId, { service: "Facial" });
    google.failNext({ on: "insert", ...fail });
    const decided = await deskDecide(r.token, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: deskTime(days, hour),
    });
    return decided.appointmentId!;
  }

  test("listStuckCalendarWrites: failed and unknown writes, newest first, exactly its keys, demo clinics hidden unless asked, truncated past the cap", async () => {
    const a = await deskLocation(google, "stuck-a");
    const failed = await confirmWith(a.clinicId, { status: 400, reason: "badRequest" }, 3, 9);
    const waiting = await confirmWith(a.clinicId, { status: 503, reason: "backendError" }, 5, 10);
    // A written one and a cancelled one are not stuck.
    const ok = await phoneRequest(a.clinicId);
    await deskDecide(ok.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(6, 9) });
    const cancelled = await confirmWith(a.clinicId, { status: 400, reason: "badRequest" }, 6, 11);
    await inTenant(a.clinicId, (c) => c.query(`update appointments set status = 'cancelled' where id = $1`, [cancelled]));

    const demo = await deskLocation(google, "stuck-demo");
    const demoWrite = await confirmWith(demo.clinicId, { status: 503, reason: "backendError" }, 2, 9);
    await seedEntitled(demo.clinicId, { stripe: false });
    const flipped = await inTenant(demo.clinicId, (c) =>
      c.query(
        `update entitlements set status = 'demo', stripe_subscription_id = null, stripe_customer_id = null
          where clinic_id = $1 returning clinic_id`,
        [demo.clinicId],
      ),
    );
    expect(flipped.rows).toHaveLength(1);
    const { rows: isDemo } = await inTenant(demo.clinicId, (c) =>
      c.query<{ demo: boolean }>(`select app_clinic_is_demo($1) as demo`, [demo.clinicId]),
    );
    expect(isDemo[0]!.demo).toBe(true);
    // Make the order certain: the failed one changed last.
    await inTenant(a.clinicId, (c) => c.query(`update appointments set updated_at = now() + interval '1 minute' where id = $1`, [failed]));

    const now = new Date();
    const res = await runOperation("listStuckCalendarWrites", {}, OPERATOR);
    expect(res.status).toBe(200);
    const data = (res.body as { data: Awaited<ReturnType<typeof listStuckCalendarWrites>> }).data;
    expect(Object.keys(data).sort()).toEqual(["count", "truncated", "unreadClinics", "writes"]);
    expect(data).toMatchObject({ count: 2, truncated: false, unreadClinics: 0 });
    expect(data.writes.map((w) => w.appointmentId)).toEqual([failed, waiting]);
    for (const w of data.writes) {
      expect(Object.keys(w).sort()).toEqual(
        ["appointmentId", "attempts", "clinicId", "clinicName", "nextAttemptAt", "reason", "retryable", "slotInDays", "status"].sort(),
      );
    }
    expect(data.writes[0]).toMatchObject({
      clinicId: a.clinicId,
      status: "failed",
      reason: "other",
      attempts: 1,
      nextAttemptAt: null,
      retryable: false,
    });
    expect(data.writes[0]!.slotInDays).toBeGreaterThanOrEqual(2);
    expect(data.writes[0]!.slotInDays).toBeLessThanOrEqual(3);
    expect(data.writes[1]).toMatchObject({ status: "unknown", reason: "unconfirmed", attempts: 1, retryable: true });
    const next = Date.parse(data.writes[1]!.nextAttemptAt!);
    expect(next).toBeGreaterThan(now.getTime() - MIN);
    expect(next).toBeLessThanOrEqual(now.getTime() + 2 * MIN + 5_000);

    // Nothing of the person, the service or the time of day.
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Facial|Consultation|\+1555|scheduled|T\d\d:\d\d:00\.000Z.*slot/);
    expect(text).not.toContain(deskTime(3, 9).toISOString());

    // The demo clinic, when asked for; and the cap.
    const withDemo = (await runOperation("listStuckCalendarWrites", { includeDemo: true }, OPERATOR)).body as {
      data: { writes: { appointmentId: string }[]; count: number };
    };
    expect(withDemo.data.count).toBe(3);
    expect(withDemo.data.writes.map((w) => w.appointmentId)).toContain(demoWrite);
    const capped = await listStuckCalendarWrites({ actor: ACTOR, includeDemo: true, max: 2 });
    expect(capped).toMatchObject({ count: 3, truncated: true });
    expect(capped.writes).toHaveLength(2);

    // Bad arguments are refused.
    expect((await runOperation("listStuckCalendarWrites", { includeDemo: "yes" }, OPERATOR)).status).toBe(400);
    expect((await runOperation("listStuckCalendarWrites", { clinicId: a.clinicId }, OPERATOR)).status).toBe(400);
  }, 120_000);

  test("listStuckCalendarWrites: a slot already started is not listed; five of five is listed and not retryable", async () => {
    const a = await deskLocation(google, "stuck-five");
    const five = await confirmWith(a.clinicId, { status: 503, reason: "backendError" }, 4, 9);
    await inTenant(a.clinicId, (c) => c.query(`update appointments set calendar_write_attempts = 5 where id = $1`, [five]));
    const listed = await listStuckCalendarWrites({ actor: ACTOR });
    expect(listed.writes).toEqual([expect.objectContaining({ appointmentId: five, attempts: 5, retryable: false, nextAttemptAt: null })]);
    const later = await listStuckCalendarWrites({ actor: ACTOR, now: new Date(Date.now() + 5 * 24 * HOUR) });
    expect(later.writes).toEqual([]);
  }, 60_000);

  /* ------------------------------------------- undelivered transcripts */

  async function queued(clinicId: string): Promise<string> {
    const { conversationId } = await seedConversation(clinicId, { startedAt: new Date() });
    const id = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      queueTranscriptEmail(tx, {
        conversationId,
        channel: "voice",
        startedAt: new Date("2026-10-13T15:00:00Z"),
        turns: [
          { speaker: "assistant", text: "Hi, I'm the clinic's AI assistant, and this call is transcribed." },
          { speaker: "person", text: "Synthetic caller asking about Thursday." },
        ],
      }),
    );
    return id!;
  }

  /** Moves a row's clocks, as the outbox's own tests do: the trigger holds them to the database's clock otherwise. */
  async function age(clinicId: string, id: string, set: string) {
    const client = await getMigratorPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
      await client.query("alter table transcript_emails disable trigger transcript_emails_clock");
      await client.query(`update transcript_emails set ${set} where id = $1`, [id]);
      await client.query("alter table transcript_emails enable trigger transcript_emails_clock");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  test("listUndeliveredTranscripts: per clinic, counts and the oldest age only; a clinic with only a young copy is absent; each clinic read in its own tenant", async () => {
    const late = await seedClinic("tx-late");
    const lost = await seedClinic("tx-lost");
    const young = await seedClinic("tx-young");
    const overdueId = await queued(late.clinicId);
    await queued(late.clinicId); // young, beside it
    await age(late.clinicId, overdueId, `created_at = now() - interval '100 hours'`);
    const lostId = await queued(lost.clinicId);
    await age(lost.clinicId, lostId, `created_at = now() - interval '31 days', destroy_after = now() - interval '1 day'`);
    expect(await endTranscriptCopy(lost.clinicId, lostId, "expired", { notify: async () => {}, notifyOnce: async () => {} })).toBe(true);
    await queued(young.clinicId);

    const res = await runOperation("listUndeliveredTranscripts", {}, OPERATOR);
    expect(res.status).toBe(200);
    const data = (res.body as { data: Awaited<ReturnType<typeof listUndeliveredTranscripts>> }).data;
    expect(Object.keys(data).sort()).toEqual(["clinics", "unreadClinics"]);
    expect(data.unreadClinics).toBe(0);
    expect(data.clinics.map((c) => c.clinicId).sort()).toEqual([late.clinicId, lost.clinicId].sort());
    for (const c of data.clinics) {
      expect(Object.keys(c).sort()).toEqual(["clinicId", "clinicName", "counts", "oldestAgeHours"]);
      expect(Object.keys(c.counts).sort()).toEqual(["bounced", "expired", "overdue", "unconfirmed"]);
    }
    const byId = new Map(data.clinics.map((c) => [c.clinicId, c]));
    // Each clinic's own rows only: the late clinic's young copy is not overdue, and the lost clinic's copy is not the late one's.
    expect(byId.get(late.clinicId)).toMatchObject({
      counts: { overdue: 1, bounced: 0, expired: 0, unconfirmed: 0 },
      oldestAgeHours: 100,
    });
    expect(byId.get(lost.clinicId)).toMatchObject({
      counts: { overdue: 0, bounced: 0, expired: 1, unconfirmed: 0 },
      oldestAgeHours: null,
    });
    // Never a copy, a conversation or an address.
    expect(JSON.stringify(res.body)).not.toMatch(/Synthetic caller|conversation|@/);
    expect((await runOperation("listUndeliveredTranscripts", { clinicId: late.clinicId }, OPERATOR)).status).toBe(400);

    // Home: one row for all, red because one copy is lost, pointing at the System page.
    const read = await transcriptDeliverySource.read({
      now: new Date(),
      operator: OPERATOR,
      actor: ACTOR,
      request: {},
      clinicNames: async () => new Map(),
    });
    expect(read.partial).toBeUndefined();
    expect(read.rows).toEqual([
      {
        id: "transcripts:undelivered",
        kind: "queue",
        count: 2,
        sentence: "Transcript copies not delivered to 2 clinics: 1 waiting more than 72 hours, 1 deleted unsent after 30 days.",
        clinic: null,
        button: { label: "Open transcript deliveries", kind: "link", href: TRANSCRIPTS_PAGE },
        tone: "bad",
        dueAt: null,
      },
    ]);
    const inbox = await readOpsInbox(OPERATOR);
    expect(inbox.rows.filter((r) => r.id === "transcripts:undelivered")).toHaveLength(1);
  }, 60_000);

  test("Home's transcript row: none when nothing is late, amber and naming the clinic when one clinic is only overdue", async () => {
    const one = await seedClinic("tx-one");
    const id = await queued(one.clinicId);
    const read = () =>
      transcriptDeliverySource.read({
        now: new Date(),
        operator: OPERATOR,
        actor: ACTOR,
        request: {},
        clinicNames: async () => new Map(),
      });
    expect((await read()).rows).toEqual([]);
    await age(one.clinicId, id, `created_at = now() - interval '80 hours'`);
    const rows = (await read()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: "warn",
      count: 1,
      clinic: { id: one.clinicId },
      sentence: "Transcript copies not delivered: 1 waiting more than 72 hours.",
    });
  }, 60_000);
});
