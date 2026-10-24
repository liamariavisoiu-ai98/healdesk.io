import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// One clinic's entitlements read can be made to fail, to prove the strip
// fails whole rather than drawing a guessed row.
const failing = vi.hoisted(() => ({ clinicId: null as string | null }));
vi.mock("@/lib/billing/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/entitlements")>();
  return {
    ...actual,
    getEntitlements: async (...args: Parameters<typeof actual.getEntitlements>) => {
      if (failing.clinicId && args[1] === failing.clinicId) throw new Error("synthetic read failure");
      return actual.getEntitlements(...args);
    },
  };
});

import { setupDeadline } from "@/lib/clinic/setup-window";
import { isMutating, isOpName, parseEnvelope, runOperation, type Operator } from "@/lib/ops/api";
import type { Entitlements } from "@/db/schema";
import type { ClinicOverview } from "@/lib/ops/clinics";
import {
  availabilityOf,
  calendarOf,
  lastReminderOf,
  listClinicStrip,
  stageOf,
  STRIP_STATEMENTS_PER_CLINIC,
  voiceOf,
  type ClinicStripRow,
  type StripFacts,
} from "@/lib/ops/strip";

import { seedAudit, seedChange, seedReminder, setClinicAudits } from "./setup/audit-lifecycle-seeds";
import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  inTenant,
  seedChannels,
  seedClinic,
  seedConversation,
  seedDemoClinic,
  seedEntitled,
  seedGoogleConnection,
} from "./setup/factories";

/**
 * Lane A2: listClinicStrip, the redone admin's Clinics table. Seeded
 * clinics in each stage, with the channel mixes, calendar, voice agent,
 * transcript receipts and usage the columns read, and the exact row each
 * one becomes. The transcript outbox stamps its own created_at by the
 * database's clock, so the strip is read at the real time, captured once.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ZONE = "America/New_York";
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

/** An operation by its name as the envelope carries it: a string, narrowed by the closed list at run time. */
async function runNamed(name: string, args: Record<string, unknown>) {
  const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
  if (!parsed.ok) throw new Error(`${name} is not an operation`);
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

function mutatingNamed(name: string): boolean {
  if (!isOpName(name)) throw new Error(`${name} is not an operation`);
  return isMutating(name);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function migrator(text: string, values: unknown[]) {
  return getMigratorPool().query(text, values);
}

/** A transcript queued for a fresh conversation, then moved to `status` as the outbox would. */
async function seedTranscript(clinicId: string, status: "pending" | "sent" | "bounced" | "delivered") {
  const { conversationId } = await seedConversation(clinicId, { startedAt: new Date() });
  await inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into transcript_emails (clinic_id, conversation_id, sealed, status, destroy_after)
       values ($1, $2, '{"v":1}'::jsonb, 'pending', now() + interval '30 days') returning id`,
      [clinicId, conversationId],
    );
    const id = rows[0]!.id;
    if (status === "pending") return;
    await client.query(
      `update transcript_emails set status = 'sent', sent_at = now(), ses_message_id = 'ses-' || id::text where id = $1`,
      [id],
    );
    if (status === "bounced") await client.query(`update transcript_emails set status = 'bounced' where id = $1`, [id]);
    if (status === "delivered") {
      await client.query(`update transcript_emails set status = 'delivered', sealed = null where id = $1`, [id]);
    }
  });
}

async function setUsage(clinicId: string, voiceMinutes: number, chats: number) {
  await inTenant(clinicId, (client) =>
    client.query(`update entitlements set used_voice_minutes = $2, used_chat_conversations = $3 where clinic_id = $1`, [
      clinicId,
      voiceMinutes,
      chats,
    ]),
  );
}

async function setVoiceAgent(clinicId: string, status: string, drift: boolean) {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into voice_agents (clinic_id, status, drift_flagged_at, retell_agent_id, phone_number_e164, config_hash)
       values ($1, $2, $3, 'agent_synthetic_1', '+15555550100', repeat('a', 64))`,
      [clinicId, status, drift ? new Date() : null],
    ),
  );
}

function strings(value: unknown, path = "$", out: { path: string; value: string }[] = []) {
  if (typeof value === "string") out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  }
  return out;
}

const ROW_KEYS = [
  "availability",
  "blocking",
  "calendar",
  "channels",
  "clinicId",
  "lastReminder",
  "name",
  "stage",
  "synthetic",
  "transcripts",
  "usage",
  "voice",
];

const ENUMS = new Set([
  "setup", "live", "paused", "offboarding", "closed",
  "waiting", "off",
  "healthy", "degraded", "broken", "none",
  "ok", "drift", "failed", "not_provisioned",
  "voice", "web", "meta",
  "pass", "warn", "fail", "running", "never",
]);

describeDb("listClinicStrip (lane A2)", () => {
  const now = new Date();
  const seeded: Record<string, string> = {};
  const changedAt: Record<string, Date> = {};
  let names: Map<string, string>;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();

    // Setting up, day 3 of 30: voice not ready yet, website chat waiting on
    // the clinic; its Google Calendar taken away at Google; its voice agent
    // drifted and left for a person.
    const early = await seedClinic("strip-early");
    await seedEntitled(early.clinicId, {
      planId: "voice-webchat-500-300",
      setupDeadlineAt: setupDeadline(new Date(now.getTime() - 3 * DAY), ZONE),
      channelRows: [
        { channel: "voice" },
        { channel: "web", readyAt: new Date(now.getTime() - DAY), waitingOn: "snippet" },
      ],
    });
    await seedGoogleConnection(early.clinicId);
    await inTenant(early.clinicId, (client) =>
      client.query(
        `update provider_connections set status = 'revoked', broken_at = now() where clinic_id = $1 and provider = 'google_calendar'`,
        [early.clinicId],
      ),
    );
    await setVoiceAgent(early.clinicId, "ready", true);
    seeded.early = early.clinicId;

    // Setting up, day 29: Meta Chat waiting, its voice set-up failed.
    const late = await seedClinic("strip-late");
    await seedEntitled(late.clinicId, {
      planId: "voice-metachat-500-300",
      setupDeadlineAt: setupDeadline(new Date(now.getTime() - 29 * DAY), ZONE),
      channelRows: [{ channel: "meta", readyAt: new Date(now.getTime() - DAY), waitingOn: "meta_connect" }],
    });
    await setVoiceAgent(late.clinicId, "failed", false);
    seeded.late = late.clinicId;

    // Live: voice and website chat answering, the plan started, voice at
    // 50% and chat at 95%; two copies waiting, one bounced, one delivered;
    // its calendar healthy, its agent ready. Marked production with no
    // signed BAA, which blocks.
    const live = await seedClinic("strip-live");
    await seedEntitled(live.clinicId, {
      planId: "voice-webchat-500-300",
      planStartedAt: new Date(now.getTime() - 10 * DAY),
      channelRows: [
        { channel: "voice", readyAt: new Date(now.getTime() - 9 * DAY), liveAt: new Date(now.getTime() - 5 * DAY), firstAnswerAt: new Date(now.getTime() - 5 * DAY) },
        { channel: "web", readyAt: new Date(now.getTime() - 9 * DAY), liveAt: new Date(now.getTime() - 4 * DAY), firstAnswerAt: new Date(now.getTime() - 4 * DAY) },
      ],
    });
    await setUsage(live.clinicId, 250, 285);
    await seedGoogleConnection(live.clinicId);
    await setVoiceAgent(live.clinicId, "ready", false);
    await seedTranscript(live.clinicId, "pending");
    await seedTranscript(live.clinicId, "sent");
    await seedTranscript(live.clinicId, "bounced");
    await seedTranscript(live.clinicId, "delivered");
    await migrator(`update clinics set data_classification = 'production' where id = $1`, [live.clinicId]);
    seeded.live = live.clinicId;

    // Paused by the clinic an hour ago, Meta Chat at 100% of its chats.
    const paused = await seedClinic("strip-paused");
    await seedEntitled(paused.clinicId, {
      planId: "voice-metachat-500-300",
      planStartedAt: new Date(now.getTime() - 10 * DAY),
      channelRows: [
        { channel: "meta", readyAt: new Date(now.getTime() - 9 * DAY), liveAt: new Date(now.getTime() - 8 * DAY), firstAnswerAt: new Date(now.getTime() - 8 * DAY) },
        { channel: "web", enabled: false },
      ],
    });
    await setUsage(paused.clinicId, 0, 300);
    await inTenant(paused.clinicId, (client) =>
      client.query(`insert into clinic_settings (clinic_id, ai_paused_at) values ($1, $2)`, [
        paused.clinicId,
        new Date(now.getTime() - 60 * 60 * 1000),
      ]),
    );
    await seedGoogleConnection(paused.clinicId, { status: "degraded" });
    seeded.paused = paused.clinicId;

    // Leaving, and gone.
    const leaving = await seedClinic("strip-leaving");
    await migrator(`update clinics set offboarding_started_at = $2 where id = $1`, [
      leaving.clinicId,
      new Date(now.getTime() - 2 * DAY),
    ]);
    seeded.leaving = leaving.clinicId;
    const closed = await seedClinic("strip-closed");
    await migrator(`update clinics set account_closed_at = $2 where id = $1`, [closed.clinicId, new Date(now.getTime() - DAY)]);
    seeded.closed = closed.clinicId;

    // Live on voice alone at exactly half its minutes.
    const half = await seedClinic("strip-half");
    await seedEntitled(half.clinicId, {
      planId: "voice-500",
      planStartedAt: new Date(now.getTime() - 10 * DAY),
      channelRows: [
        { channel: "voice", readyAt: new Date(now.getTime() - 9 * DAY), liveAt: new Date(now.getTime() - 6 * DAY), firstAnswerAt: new Date(now.getTime() - 6 * DAY) },
      ],
    });
    await setUsage(half.clinicId, 250, 0);
    seeded.half = half.clinicId;

    // A location of the day-3 clinic: no entitlements row of its own, so its
    // stage and deadline are its billing clinic's, and its usage is shown on
    // that clinic's row only.
    const { rows: loc } = await migrator(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, 'strip-location Clinic', 'med-spa', $3) returning id`,
      [early.organizationId, `strip-location-${randomUUID().slice(0, 6)}`, early.clinicId],
    );
    seeded.location = loc[0]!.id;

    // healdesk's demo clinic.
    const demo = await seedDemoClinic("strip-demo");
    seeded.demo = demo.clinicId;

    // Lane A4: the audits and the setup reminders. The clinic-audits job is
    // off unless a test turns it on, so a change is written with no audit
    // status, as change-events.ts and the 0114 trigger write it then.
    await setClinicAudits(false);
    // Day 3: a change two hours ago, audited, and the availability pack
    // failing after it; no reminder yet.
    changedAt.early = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await seedChange(early.clinicId, { auditStatus: "attention", changedAt: changedAt.early });
    await seedAudit(early.clinicId, "availability", "pass", new Date(now.getTime() - DAY));
    await seedAudit(early.clinicId, "availability", "fail", new Date(now.getTime() - 60 * 60 * 1000));
    // Day 29: audited a day ago, then changed while the audits are off: not
    // audited, whatever the pass said. Reminders 4 and 5 sent on days 20 and
    // 25, then the after-live one, which has no window day: day 25.
    changedAt.late = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    await seedChange(late.clinicId, { auditStatus: "passed", changedAt: new Date(now.getTime() - 5 * DAY) });
    await seedAudit(late.clinicId, "availability", "pass", new Date(now.getTime() - DAY));
    await seedChange(late.clinicId, { auditStatus: null, changedAt: changedAt.late });
    await seedReminder(late.clinicId, "setup_reminder:4", new Date(now.getTime() - 9 * DAY));
    await seedReminder(late.clinicId, "setup_reminder:5", new Date(now.getTime() - 4 * DAY));
    await seedReminder(late.clinicId, "setup_reminder:live:web", new Date(now.getTime() - 2 * DAY));
    // Live on voice alone: the availability packs passed, nothing changed.
    for (const pack of ["availability", "roster"] as const) await seedAudit(half.clinicId, pack, "pass");
    // Live: go-live failing (as for every clinic not in production), transcripts
    // warning, and the availability pack warning for a setup state after an
    // earlier pass, with no change at all: a neutral column.
    await seedAudit(live.clinicId, "availability", "pass", new Date(now.getTime() - 2 * DAY));
    await seedAudit(live.clinicId, "availability", "warn", new Date(now.getTime() - DAY));
    await seedAudit(live.clinicId, "golive", "fail");
    await seedAudit(live.clinicId, "transcripts", "warn");
    // Paused: a change three days ago, then the availability pack warning
    // (it never passed) and the roster passing: a warning the change brought.
    changedAt.paused = new Date(now.getTime() - 3 * DAY);
    await seedChange(paused.clinicId, { auditStatus: "attention", changedAt: changedAt.paused });
    await seedAudit(paused.clinicId, "availability", "warn");
    await seedAudit(paused.clinicId, "roster", "pass");

    const { rows } = await migrator(`select id, name from clinics`, []);
    names = new Map(rows.map((r: { id: string; name: string }) => [r.id, r.name]));
  }, 240_000);

  afterAll(async () => {
    await setClinicAudits(false);
    await closePools();
  });

  function rowOf(rows: ClinicStripRow[], key: string): ClinicStripRow {
    const row = rows.find((r) => r.clinicId === seeded[key]);
    if (!row) throw new Error(`no strip row for ${key}`);
    return row;
  }

  test("each seeded clinic becomes exactly its row", async () => {
    const rows = await listClinicStrip(now);
    expect(rows).toHaveLength(9);

    expect(rowOf(rows, "early")).toEqual({
      clinicId: seeded.early,
      name: names.get(seeded.early!),
      synthetic: false,
      stage: { kind: "setup", day: 3, of: 30, deadlineAt: setupDeadline(new Date(now.getTime() - 3 * DAY), ZONE).toISOString() },
      channels: { web: "waiting", meta: "off", voice: "waiting" },
      availability: { changedAt: changedAt.early!.toISOString(), audit: "fail" },
      calendar: "broken",
      voice: "drift",
      transcripts: { waiting: 0, bounced: 0 },
      usage: { percent: null, meter: null },
      lastReminder: { day: null },
      blocking: null,
    });

    expect(rowOf(rows, "late")).toEqual({
      clinicId: seeded.late,
      name: names.get(seeded.late!),
      synthetic: false,
      stage: {
        kind: "setup",
        day: 29,
        of: 30,
        deadlineAt: setupDeadline(new Date(now.getTime() - 29 * DAY), ZONE).toISOString(),
      },
      channels: { web: "off", meta: "waiting", voice: "off" },
      // Changed after its last audit while the audits are off: not audited, whatever that audit said.
      availability: { changedAt: changedAt.late!.toISOString(), audit: "never" },
      calendar: "none",
      voice: "failed",
      transcripts: { waiting: 0, bounced: 0 },
      usage: { percent: null, meter: null },
      lastReminder: { day: 25 },
      blocking: null,
    });

    expect(rowOf(rows, "half")).toMatchObject({
      stage: { kind: "live", since: new Date(now.getTime() - 6 * DAY).toISOString() },
      channels: { web: "off", meta: "off", voice: "live" },
      usage: { percent: 50, meter: "voice" },
      availability: { changedAt: null, audit: "pass" },
      // Billed with no setup window of its own: not measured.
      lastReminder: null,
    });

    expect(rowOf(rows, "location")).toEqual({
      clinicId: seeded.location,
      name: "strip-location Clinic",
      synthetic: false,
      stage: {
        kind: "setup",
        day: 3,
        of: 30,
        deadlineAt: setupDeadline(new Date(now.getTime() - 3 * DAY), ZONE).toISOString(),
      },
      channels: { web: "off", meta: "off", voice: "off" },
      availability: { changedAt: null, audit: "never" },
      calendar: "none",
      voice: "not_provisioned",
      transcripts: { waiting: 0, bounced: 0 },
      usage: { percent: null, meter: null },
      // A location has no setup window of its own: its billing clinic's reminders are that clinic's.
      lastReminder: null,
      blocking: null,
    });

    expect(rowOf(rows, "live")).toEqual({
      clinicId: seeded.live,
      name: names.get(seeded.live!),
      synthetic: false,
      stage: { kind: "live", since: new Date(now.getTime() - 5 * DAY).toISOString() },
      channels: { web: "live", meta: "off", voice: "live" },
      // Go-live failing and a setup-state warning with no change since the last pass: neutral.
      availability: { changedAt: null, audit: "pass" },
      calendar: "healthy",
      voice: "ok",
      transcripts: { waiting: 2, bounced: 1 },
      usage: { percent: 95, meter: "web" },
      // No setup window of its own: not measured, rather than "none".
      lastReminder: null,
      blocking: "Marked production with no signed BAA — the database is refusing all patient data.",
    });

    expect(rowOf(rows, "paused")).toMatchObject({
      stage: { kind: "paused", since: new Date(now.getTime() - 60 * 60 * 1000).toISOString() },
      channels: { web: "off", meta: "live", voice: "off" },
      calendar: "degraded",
      voice: "not_provisioned",
      usage: { percent: 100, meter: "meta" },
      availability: { changedAt: changedAt.paused!.toISOString(), audit: "warn" },
      lastReminder: null,
    });
    expect(rowOf(rows, "demo").lastReminder).toBeNull();

    expect(rowOf(rows, "leaving").stage).toEqual({
      kind: "offboarding",
      since: new Date(now.getTime() - 2 * DAY).toISOString(),
    });
    expect(rowOf(rows, "closed").stage).toEqual({ kind: "closed", since: new Date(now.getTime() - DAY).toISOString() });
    expect(rowOf(rows, "closed")).toMatchObject({
      synthetic: false,
      channels: { web: "off", meta: "off", voice: "off" },
      calendar: "none",
      voice: "not_provisioned",
      usage: { percent: null, meter: null },
    });

    // The demo clinic, and only it, is synthetic: a clinic still setting up
    // is data_classification 'synthetic' too, and is not.
    expect(rows.filter((r) => r.synthetic).map((r) => r.clinicId)).toEqual([seeded.demo]);

    // Newest clinic first.
    expect(rows[0]!.clinicId).toBe(seeded.demo);
  });

  test("the rows carry the contract's keys and no free text: ids, enums, dates, counts and the clinic's own name", async () => {
    const rows = await listClinicStrip(now);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      expect(Object.keys(row.channels).sort()).toEqual(["meta", "voice", "web"]);
      expect(Object.keys(row.transcripts).sort()).toEqual(["bounced", "waiting"]);
      expect(Object.keys(row.usage).sort()).toEqual(["meter", "percent"]);
      const stageKeys: Record<string, string[]> = {
        setup: ["day", "deadlineAt", "kind", "of"],
        live: ["kind", "since"],
        paused: ["kind", "since"],
        offboarding: ["kind", "since"],
        closed: ["kind", "since"],
      };
      expect(Object.keys(row.stage).sort()).toEqual(stageKeys[row.stage.kind]);
      for (const { path, value } of strings(row)) {
        if (path === "$.name") expect(value).toBe(names.get(row.clinicId));
        else if (path === "$.blocking") expect(value).toMatch(/^Marked production with no signed BAA/);
        else expect(UUID.test(value) || ISO.test(value) || ENUMS.has(value), `${path}=${value}`).toBe(true);
      }
    }
  });

  test("the statements grow by a fixed number per clinic, never with what a clinic holds", async () => {
    const spy = vi.spyOn(pg.Client.prototype, "query");
    const before = await listClinicStrip(now);
    const first = spy.mock.calls.length;
    spy.mockClear();

    // More clinics, 30 in all, with channels and transcripts on some.
    const added = 30 - before.length;
    for (let i = 0; i < added; i++) {
      const c = await seedClinic(`strip-many-${i}`);
      if (i % 3 === 0) {
        await seedChannels(c.clinicId, [{ channel: "web" }, { channel: "voice" }]);
        await seedTranscript(c.clinicId, "pending");
      }
    }
    spy.mockClear();
    const after = await listClinicStrip(now);
    const second = spy.mock.calls.length;
    spy.mockRestore();

    expect(added).toBeGreaterThan(15);
    expect(after).toHaveLength(30);
    // Per clinic: BEGIN, set_config, the seven reads, COMMIT.
    expect(STRIP_STATEMENTS_PER_CLINIC).toBe(7);
    const perClinic = STRIP_STATEMENTS_PER_CLINIC + 3;
    expect(second - first).toBe(added * perClinic);
    // And two statements across tenants: the overview, and whether the
    // clinic-audits job is on.
    expect(first).toBe(before.length * perClinic + 2);
  });

  test("the operation is a read on the closed list, takes no arguments, and refuses any", async () => {
    expect(isOpName("listClinicStrip")).toBe(true);
    expect(mutatingNamed("listClinicStrip")).toBe(false);
    const parsed = parseEnvelope(JSON.stringify({ op: "listClinicStrip", args: {} }));
    if (!parsed.ok) throw new Error("not an operation");
    const outcome = await runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
    expect(outcome.status).toBe(200);
    expect((outcome.body as { data: { clinics: unknown[] } }).data.clinics.length).toBeGreaterThan(0);

    const refused = await runNamed("listClinicStrip", { clinicId: seeded.live });
    expect(refused).toEqual({
      status: 400,
      body: { error: "listClinicStrip takes no arguments.", code: "invalid_args" },
    });
  });
  test("transcripts: pending and sent wait; bounced, unconfirmed and expired did not arrive; open and delivered are neither; 30 days back", async () => {
    const c = await seedClinic("strip-transcripts");
    // Each row as the outbox would have left it, written as the migrator with
    // the outbox's clock trigger stood aside for this one transaction (the
    // trigger stamps created_at and refuses the 72-hour and 30-day ends
    // before their time), so ages can be set.
    const rows: [string, number][] = [
      ["open", 1], ["pending", 1], ["sent", 1], ["bounced", 1], ["delivered", 1],
      ["unconfirmed", 5], ["expired", 29], ["pending", 31], ["bounced", 31],
    ];
    const conversations: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      conversations.push((await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId);
    }
    await inTenant(c.clinicId, async (client) => {
      await client.query(`alter table transcript_emails disable trigger transcript_emails_clock`);
      for (const [i, [status, daysAgo]] of rows.entries()) {
        const receipt = ["delivered", "unconfirmed", "expired"].includes(status);
        const sent = !["open", "pending", "expired"].includes(status);
        await client.query(
          `insert into transcript_emails (clinic_id, conversation_id, sealed, status, created_at, destroy_after, sent_at, ses_message_id)
           values ($1, $2, $3::jsonb, $4, now() - make_interval(days => $5), now() + interval '1 day', $6, $7)`,
          [
            c.clinicId,
            conversations[i],
            receipt ? null : '{"v":1}',
            status,
            daysAgo,
            sent ? new Date() : null,
            sent ? `ses-${randomUUID()}` : null,
          ],
        );
      }
      await client.query(`alter table transcript_emails enable trigger transcript_emails_clock`);
    });
    const row = (await listClinicStrip(new Date())).find((r) => r.clinicId === c.clinicId)!;
    expect(row.transcripts).toEqual({ waiting: 2, bounced: 3 });
  });

  test("availability: a change queued while the audits are on is running; the same change with them off is not audited", async () => {
    // After the clinic's last availability audit, which would otherwise have checked it.
    const queuedAt = new Date();
    const id = await seedChange(seeded.paused!, { auditStatus: "queued", changedAt: queuedAt });
    try {
      await setClinicAudits(true);
      try {
        const on = await listClinicStrip(now);
        expect(rowOf(on, "paused").availability).toEqual({ changedAt: queuedAt.toISOString(), audit: "running" });
        // Nothing is queued at the day-3 clinic: its failing audit stands.
        expect(rowOf(on, "early").availability).toEqual({ changedAt: changedAt.early!.toISOString(), audit: "fail" });
      } finally {
        await setClinicAudits(false);
      }
      expect(rowOf(await listClinicStrip(now), "paused").availability).toEqual({ changedAt: queuedAt.toISOString(), audit: "never" });
    } finally {
      await inTenant(seeded.paused!, (client) => client.query(`delete from clinic_change_events where id = $1`, [id]));
    }
  });

  test("the last reminder counts from the CURRENT window: an extension moves its day, and the outbox is read, not the watch", async () => {
    const before = rowOf(await listClinicStrip(now), "late").lastReminder;
    expect(before).toEqual({ day: 25 });
    const extended = setupDeadline(new Date(now.getTime() - 22 * DAY), ZONE);
    await inTenant(seeded.late!, (client) =>
      client.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [seeded.late, extended]),
    );
    try {
      // Reminder 5 went four days ago: day 18 of a window that began 22 days ago.
      expect(rowOf(await listClinicStrip(now), "late").lastReminder).toEqual({ day: 18 });
    } finally {
      await inTenant(seeded.late!, (client) =>
        client.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
          seeded.late,
          setupDeadline(new Date(now.getTime() - 29 * DAY), ZONE),
        ]),
      );
    }
  });

  test("one clinic that cannot be read fails the whole read: a 500, and no partial list", async () => {
    failing.clinicId = seeded.live!;
    try {
      await expect(listClinicStrip(now)).rejects.toThrow();
      const outcome = await runNamed("listClinicStrip", {});
      expect(outcome).toEqual({ status: 500, body: { error: "The clinics could not be read.", code: "failed" } });
    } finally {
      failing.clinicId = null;
    }
  });
});

describe("the strip's states at their edges (pure)", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");
  const clinic = {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
    timezone: "UTC",
    wentLiveAt: null,
    offboardingStartedAt: null,
    destroyedAt: null,
  } as unknown as ClinicOverview;
  const facts: StripFacts = {
    accountClosedAt: null,
    pausedAt: null,
    pausedUntil: null,
    demo: false,
    voiceStatus: null,
    voiceDriftFlaggedAt: null,
    calendarStatus: null,
    calendarBrokenAt: null,
    entitlements: null,
    channels: [],
    transcripts: { waiting: 0, bounced: 0 },
    audit: { changedAt: null, level: "never" },
    lastReminderAt: null,
  };
  const billing = (status: string) => ({ status, setupDeadlineAt: null }) as unknown as Entitlements;

  test("availability carries the level as given and the change's time; never null", () => {
    const at = new Date("2026-10-22T09:00:00.000Z");
    for (const level of ["pass", "warn", "fail", "running", "never"] as const) {
      expect(availabilityOf({ audit: { changedAt: at, level } })).toEqual({ changedAt: at.toISOString(), audit: level });
    }
    expect(availabilityOf({ audit: { changedAt: null, level: "never" } })).toEqual({ changedAt: null, audit: "never" });
  });

  test("the last reminder: its day in the current window, none with a window and no reminder, not measured without a window", () => {
    const deadline = setupDeadline(new Date("2026-10-01T15:00:00.000Z"), "UTC");
    const ent = { setupDeadlineAt: deadline } as unknown as Entitlements;
    const utc = { timezone: "UTC" };
    expect(lastReminderOf(utc, { entitlements: ent, lastReminderAt: new Date("2026-10-26T08:00:00.000Z") })).toEqual({ day: 25 });
    expect(lastReminderOf(utc, { entitlements: ent, lastReminderAt: null })).toEqual({ day: null });
    expect(lastReminderOf(utc, { entitlements: null, lastReminderAt: new Date() })).toBeNull();
    expect(lastReminderOf(utc, { entitlements: { setupDeadlineAt: null } as unknown as Entitlements, lastReminderAt: null })).toBeNull();
    // A reminder from before an extension moved the start later counts from the new start, never below 0.
    expect(lastReminderOf(utc, { entitlements: ent, lastReminderAt: new Date("2026-09-20T08:00:00.000Z") })).toEqual({ day: 0 });
  });

  test("billing paused or suspended is paused; canceled or purged is closed", () => {
    expect(stageOf(clinic, facts, now, billing("paused"))).toEqual({ kind: "paused", since: null });
    expect(stageOf(clinic, facts, now, billing("suspended"))).toEqual({ kind: "paused", since: null });
    expect(stageOf(clinic, facts, now, billing("canceled"))).toEqual({ kind: "closed", since: null });
    expect(stageOf(clinic, facts, now, billing("purged"))).toEqual({ kind: "closed", since: null });
    expect(stageOf(clinic, facts, now, billing("active"))).toMatchObject({ kind: "setup", day: 3, deadlineAt: null });
  });

  test("a pause whose end has passed is not a pause", () => {
    const over = { ...facts, pausedAt: new Date("2026-10-22T00:00:00Z"), pausedUntil: new Date("2026-10-23T00:00:00Z") };
    expect(stageOf(clinic, over, now, billing("active")).kind).toBe("setup");
    const open = { ...over, pausedUntil: null };
    expect(stageOf(clinic, open, now, billing("active"))).toEqual({ kind: "paused", since: "2026-10-22T00:00:00.000Z" });
  });

  test("the calendar: revoked with no breakage and pending are none; revoked with a breakage is broken", () => {
    expect(calendarOf({ calendarStatus: "revoked", calendarBrokenAt: null })).toBe("none");
    expect(calendarOf({ calendarStatus: "pending", calendarBrokenAt: null })).toBe("none");
    expect(calendarOf({ calendarStatus: "revoked", calendarBrokenAt: now })).toBe("broken");
    expect(calendarOf({ calendarStatus: "error", calendarBrokenAt: null })).toBe("broken");
    expect(calendarOf({ calendarStatus: "degraded", calendarBrokenAt: null })).toBe("degraded");
    expect(calendarOf({ calendarStatus: "active", calendarBrokenAt: null })).toBe("healthy");
  });

  test("a released or releasing agent is not provisioned, whatever drift it had", () => {
    expect(voiceOf({ voiceStatus: "released", voiceDriftFlaggedAt: now })).toBe("not_provisioned");
    expect(voiceOf({ voiceStatus: "deprovisioning", voiceDriftFlaggedAt: now })).toBe("not_provisioned");
    expect(voiceOf({ voiceStatus: "ready", voiceDriftFlaggedAt: now })).toBe("drift");
    expect(voiceOf({ voiceStatus: "failed", voiceDriftFlaggedAt: now })).toBe("failed");
    expect(voiceOf({ voiceStatus: "provisioning", voiceDriftFlaggedAt: null })).toBe("not_provisioned");
  });
});
