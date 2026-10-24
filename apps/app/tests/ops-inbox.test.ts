import { randomUUID } from "node:crypto";

import { sign as signOps, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// One clinic's first-weeks read can be made to fail, to prove the source says
// so rather than leaving the clinic out in silence.
const failing = vi.hoisted(() => ({ clinicId: null as string | null }));
vi.mock("@/lib/reporting/recipients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reporting/recipients")>();
  return {
    ...actual,
    listRecipients: async (...args: Parameters<typeof actual.listRecipients>) => {
      if (failing.clinicId && args[0].clinicId === failing.clinicId) throw new Error("synthetic read failure");
      return actual.listRecipients(...args);
    },
  };
});

// Lane A4: one clinic's audit facts, or the whole lifecycle read, can be
// made to fail, to prove each new source degrades on its own.
const failingA4 = vi.hoisted(() => ({
  auditClinicId: null as string | null,
  lifecycle: false,
  lifecycleClinicId: null as string | null,
}));
vi.mock("@/lib/lifecycle/watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/watch")>();
  return {
    ...actual,
    readLifecycleRow: async (...args: Parameters<typeof actual.readLifecycleRow>) => {
      if (failingA4.lifecycleClinicId && args[0].clinicId === failingA4.lifecycleClinicId) throw new Error("synthetic read failure");
      return actual.readLifecycleRow(...args);
    },
  };
});
vi.mock("@/lib/ops/audit-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/audit-ops")>();
  return {
    ...actual,
    readClinicAuditFacts: async (...args: Parameters<typeof actual.readClinicAuditFacts>) => {
      if (failingA4.auditClinicId && args[0].clinicId === failingA4.auditClinicId) throw new Error("synthetic read failure");
      return actual.readClinicAuditFacts(...args);
    },
  };
});
vi.mock("@/lib/ops/lifecycle-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/lifecycle-ops")>();
  return {
    ...actual,
    readLifecycleViews: async (...args: Parameters<typeof actual.readLifecycleViews>) => {
      if (failingA4.lifecycle) throw new Error("synthetic read failure");
      return actual.readLifecycleViews(...args);
    },
  };
});

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { POST as opsRoute } from "@/app/api/ops/route";
import { setupDeadline } from "@/lib/clinic/setup-window";
import { AVAILABILITY_WORDS } from "@/lib/ops/inbox/availability";
import { isMutating, isOpName, parseEnvelope, runOperation, type Operator } from "@/lib/ops/api";
import { orderInbox, readOpsInbox } from "@/lib/ops/inbox/run";
import { INBOX_SOURCES } from "@/lib/ops/inbox/sources";
import { INBOX_KINDS, type InboxRow, type InboxSource } from "@/lib/ops/inbox/types";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedAudit, seedChange, seedLifecycleRow, setClinicAudits } from "./setup/audit-lifecycle-seeds";
import { inTenant, seedClinic, seedDemoClinic } from "./setup/factories";

/**
 * Lane A2: opsInbox, the redone admin's Home. Each source's row from its
 * own fixture, a source that throws reported rather than zeroed, the empty
 * database, the order, the links, and the envelope around both of lane A2's
 * operations. HEALDESK_OPS_EMAIL is unset, so nothing is mailed.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

const ROW_KEYS = ["button", "clinic", "count", "dueAt", "id", "kind", "sentence", "tone"];

async function raiseAlert(event: string, fields: Record<string, unknown>, raisedAgoMs = 0): Promise<void> {
  const at = new Date(Date.now() - raisedAgoMs);
  await getMigratorPool().query(
    `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at) values ($1, $2, $3, $4, $4)`,
    [event, `${event}|${randomUUID()}`, JSON.stringify(fields), at],
  );
}

/**
 * pg-boss's schema is installed on the host by `queue:install`, which the
 * test database (CI's included) does not run: the queues source then cannot
 * read pg-boss's jobs, and Home says so instead of counting them as empty.
 */
async function expectedUnreadable(): Promise<{ source: string; reason: string }[]> {
  const { rows } = await getMigratorPool().query<{ t: string | null }>(`select to_regclass('pgboss.job')::text as t`);
  return rows[0]!.t ? [] : [{ source: "the queues", reason: "Could not read: pg-boss." }];
}

function row(rows: InboxRow[], id: string): InboxRow {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no inbox row ${id}; have ${rows.map((r) => r.id).join(", ")}`);
  return found;
}

/** apps/web's routes, read from its source: the inbox may only link to a page that exists and is not a redirect. */
const WEB_APP = resolve(__dirname, "..", "..", "web", "src", "app");
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_ANCHOR = /^[a-z0-9_]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

/**
 * The href is a console page: under /admin/, a page.tsx that is not a
 * permanent redirect, and a fixed anchor that some component on that route
 * renders as an id. An issue anchor (`#<event>-<alert id>`) is drawn by the
 * tab's issue list from the alert itself, so only its page is checked.
 */
function expectConsolePage(href: string): void {
  expect(href.startsWith("/admin/"), href).toBe(true);
  const [path, anchor] = href.split("#") as [string, string | undefined];
  const segments = path.split("/").filter(Boolean).map((seg) => (UUID_SEGMENT.test(seg) ? "[clinicId]" : seg));
  const dir = join(WEB_APP, ...segments);
  const page = join(dir, "page.tsx");
  expect(existsSync(page), `${href}: no page at ${page}`).toBe(true);
  expect(readFileSync(page, "utf8"), `${href} is a retired address`).not.toMatch(/permanentRedirect\(/);
  if (anchor && !ISSUE_ANCHOR.test(anchor)) {
    expect(
      sourcesUnder(dir).some((text) => text.includes(`id="${anchor}"`)),
      `${href}: no element with id="${anchor}"`,
    ).toBe(true);
  }
}

function fake(id: string, over: Partial<InboxRow> = {}): InboxRow {
  return {
    id,
    kind: "queue",
    count: 1,
    sentence: "Something.",
    clinic: null,
    button: { label: "Open", kind: "link", href: "/admin/ops" },
    tone: "info",
    dueAt: null,
    ...over,
  };
}

describe("the inbox's order (pure)", () => {
  test("earliest due first, undated after every dated row; then bad, warn, info; then the larger count; then id", () => {
    const rows = [
      fake("e", { tone: "bad", count: 1 }),
      fake("d", { tone: "warn", count: 9 }),
      fake("c", { tone: "warn", count: 2 }),
      fake("b", { dueAt: "2026-10-25", tone: "info" }),
      fake("a", { dueAt: "2026-10-24", tone: "info" }),
      fake("f", { tone: "info", count: 3 }),
      fake("g", { tone: "info", count: 3 }),
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual(["a", "b", "e", "d", "c", "f", "g"]);
  });

  test("the registry's sources each have a name, and the kinds list is closed", () => {
    expect(INBOX_SOURCES.map((s) => s.name)).toEqual([
      "ops alerts",
      "the queues",
      "the first-weeks flags",
      "the practice reviews",
      "the support replies",
      "the Retell deletions",
      "the site reads",
      "the availability audits",
      "the setup decisions",
      "the transcript deliveries",
    ]);
    expect([...INBOX_KINDS]).toEqual([
      "ops_alert",
      "queue",
      "health_flag",
      "practice_review",
      "support_reply",
      "recording_alert",
      "site_read",
      "availability",
      "decision",
    ]);
  });
});

describeDb("opsInbox (lane A2)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  });

  const secretBefore = process.env.HEALDESK_PROVISION_SECRET;

  afterAll(async () => {
    if (secretBefore === undefined) delete process.env.HEALDESK_PROVISION_SECRET;
    else process.env.HEALDESK_PROVISION_SECRET = secretBefore;
    failing.clinicId = null;
    await closePools();
  });

  test("an empty database lists nothing, says when it looked, and names only what it could not read", async () => {
    const now = new Date();
    const inbox = await readOpsInbox(OPERATOR, { now });
    expect(inbox).toEqual({ rows: [], checkedAt: now.toISOString(), unreadable: await expectedUnreadable() });
  });

  test("each source produces its row, worded, linked and toned", async () => {
    const a = await seedClinic("inbox-a");
    const b = await seedClinic("inbox-b");
    const live = await seedClinic("inbox-live");

    // Ops alerts: two calendar breaks for A (one row, count 2), one email
    // count alert with no clinic, a flag from B; and what is left out: an
    // alert another source lists, good news, the digest's row, a day-old one.
    await raiseAlert("calendar_broken", { clinicId: a.clinicId });
    await raiseAlert("calendar_broken", { clinicId: a.clinicId });
    await raiseAlert("daily_email_count_70", { count: 71 });
    await raiseAlert("flag_alert", { clinicId: b.clinicId });
    await raiseAlert("support_reply_past_due", { clinicId: a.clinicId });
    await raiseAlert("calendar_recovered", { clinicId: a.clinicId });
    await raiseAlert("ops_digest", {});
    await raiseAlert("transcript_undelivered", { clinicId: b.clinicId }, 2 * DAY);

    // The queues: a paid order with no account (always a row), and a Stripe
    // event retrying for ten minutes, younger than its hour (no row).
    await getMigratorPool().query(
      `insert into checkout_intents (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at, paid_seen_at)
       values ($1, '{"clinicName": "Paid Practice"}'::jsonb, $2, 'owner@example-clinic.test', 'voice-webchat-500-300', 'month', now() + interval '14 days', now() - interval '3 hours')`,
      [randomUUID(), randomUUID()],
    );
    await getMigratorPool().query(
      `insert into billing_events (stripe_event_id, type, outcome, failures, error, payload, received_at)
       values ('evt_inbox_young', 'customer.created', 'failed', 1, 'Error: boom', '{}'::jsonb, now() - interval '10 minutes')`,
    );

    // First weeks: live 8 days, no conversation at all.
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', went_live_at = $2 where id = $1`,
      [live.clinicId, new Date(Date.now() - 8 * DAY)],
    );

    // A practice review past its day, for B.
    await inTenant(b.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into practice_question_runs (clinic_id, status, reason) values ($1, 'queued', 'knowledge') returning id`,
        [b.clinicId],
      );
      await client.query(
        `insert into audit_review_queue (clinic_id, kind, run_id, due_on, due_at)
         values ($1, 'practice_questions', $2, '2000-01-03', '2000-01-03T23:00:00Z')`,
        [b.clinicId, rows[0]!.id],
      );
    });

    // Two support replies owed by A, one past its day.
    for (const replyByOn of ["2000-01-03", "2999-01-01"]) {
      const requestId = randomUUID();
      await inTenant(a.clinicId, (client) =>
        client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload) values ($1, 'support_request', $2, $3)`,
          [a.clinicId, `support_request:${requestId}`, JSON.stringify({ requestId, topic: "billing", replyByOn, helpPhoneE164: null })],
        ),
      );
    }

    // A call Retell still holds, for B, and one already deleted.
    for (const resolved of [false, true]) {
      await inTenant(b.clinicId, (client) =>
        client.query(
          `insert into retell_recording_alerts (clinic_id, retell_call_id, detected_at, resolved_at)
           values ($1, $2, now() - interval '1 hour', case when $3 then now() else null end)`,
          [b.clinicId, `call_${randomUUID().slice(0, 8)}`, resolved],
        ),
      );
    }

    // A purchase whose website could not be read, and one whose site was
    // read since (its clinic has a profile now): only the first is owed.
    const readSince = await seedClinic("inbox-read-since");
    await getMigratorPool().query(`update clinics set site_profile = '{"services": []}'::jsonb where id = $1`, [
      readSince.clinicId,
    ]);
    await getMigratorPool().query(
      `insert into checkout_intents (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at, profile_status, provisioned_clinic_id, consumed_at)
       values ($1, '{"clinicName": "Read Practice"}'::jsonb, $2, 'read@example-clinic.test', 'voice-webchat-500-300', 'month', now() + interval '14 days', 'failed', $3, now())`,
      [randomUUID(), randomUUID(), readSince.clinicId],
    );
    await getMigratorPool().query(
      `insert into checkout_intents (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at, profile_status)
       values ($1, '{"clinicName": "Unread Practice", "website": "unread.example-clinic.test"}'::jsonb, $2, 'other@example-clinic.test', 'voice-webchat-500-300', 'month', now() + interval '14 days', 'failed')`,
      [randomUUID(), randomUUID()],
    );

    const inbox = await readOpsInbox(OPERATOR);
    expect(inbox.unreadable).toEqual(await expectedUnreadable());
    const { rows } = inbox;

    expect(row(rows, `alert:calendar_broken:${a.clinicId}`)).toEqual({
      id: `alert:calendar_broken:${a.clinicId}`,
      kind: "ops_alert",
      count: 2,
      sentence: expect.stringMatching(/\.$/),
      clinic: { id: a.clinicId, name: "inbox-a Clinic" },
      button: { label: "Open clinic", kind: "link", href: expect.stringMatching(new RegExp(`^/admin/clinics/${a.clinicId}/setup#calendar_broken-[0-9a-f-]{36}$`)) },
      tone: "bad",
      dueAt: null,
    });
    // The anchor names the newest of the clinic's calendar_broken alerts.
    const anchored = row(rows, `alert:calendar_broken:${a.clinicId}`).button;
    const { rows: newest } = await getMigratorPool().query<{ id: string }>(
      `select id from ops_alerts where event = 'calendar_broken' and fields->>'clinicId' = $1 order by last_raised_at desc, id`,
      [a.clinicId],
    );
    expect(newest.map((r) => r.id)).toContain(anchored.kind === "link" ? anchored.href.split("#calendar_broken-")[1] : null);
    expect(row(rows, "alert:daily_email_count_70:all")).toMatchObject({
      count: 1,
      clinic: null,
      // The page that owns a clinic-less alert (lane N3, NO_CLINIC_PAGE).
      button: { kind: "link", href: "/admin/queues#setup-requests" },
      tone: "warn",
    });
    expect(row(rows, `alert:flag_alert:${b.clinicId}`)).toMatchObject({
      sentence: "A clinic flagged one of AYA's answers.",
      button: { href: `/admin/clinics/${b.clinicId}/care` },
    });
    expect(rows.some((r) => r.id === "queue:billing_events_retrying")).toBe(false);
    for (const gone of ["support_reply_past_due", "calendar_recovered", "ops_digest", "transcript_undelivered"]) {
      expect(rows.some((r) => r.id.startsWith(`alert:${gone}:`)), gone).toBe(false);
    }

    expect(row(rows, "queue:orders_without_account")).toMatchObject({
      kind: "queue",
      count: 1,
      sentence: "Paid orders without an account; the oldest is 3 h old; the morning email counts it too, and the console has no page for it yet.",
      tone: "bad",
    });

    expect(row(rows, `health:no_calls_after_day_7:${live.clinicId}`)).toEqual({
      id: `health:no_calls_after_day_7:${live.clinicId}`,
      kind: "health_flag",
      count: 1,
      sentence: "No conversations since going live, past day 7: check the call forwarding.",
      clinic: { id: live.clinicId, name: "inbox-live Clinic" },
      button: { label: "Open clinic", kind: "link", href: `/admin/clinics/${live.clinicId}/setup` },
      tone: "warn",
      dueAt: null,
    });

    expect(row(rows, `review:${b.clinicId}`)).toEqual({
      id: `review:${b.clinicId}`,
      kind: "practice_review",
      count: 1,
      sentence: "Practice question reviews past the day promised.",
      clinic: { id: b.clinicId, name: "inbox-b Clinic" },
      button: { label: "Open reviews", kind: "link", href: "/admin/queues#reviews" },
      tone: "bad",
      dueAt: "2000-01-03",
    });

    expect(row(rows, `support:${a.clinicId}`)).toEqual({
      id: `support:${a.clinicId}`,
      kind: "support_reply",
      count: 2,
      sentence: "Support replies past the day promised.",
      clinic: { id: a.clinicId, name: "inbox-a Clinic" },
      button: { label: "Open support", kind: "link", href: "/admin/queues#support" },
      tone: "warn",
      dueAt: "2000-01-03",
    });

    expect(row(rows, `recording:${b.clinicId}`)).toMatchObject({
      count: 1,
      clinic: { id: b.clinicId, name: "inbox-b Clinic" },
      button: { href: "/admin/queues#retell-deletions" },
    });

    expect(row(rows, "site-read:all")).toMatchObject({
      count: 1,
      clinic: null,
      button: { href: "/admin/queues#site-reads" },
    });

    // Every row: the contract's keys, a known kind, one sentence that does
    // not repeat the clinic's name, a link into the console.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
      expect((INBOX_KINDS as readonly string[]).includes(r.kind)).toBe(true);
      expect(r.button.kind).toBe("link");
      if (r.button.kind === "link") expectConsolePage(r.button.href);
      expect(r.sentence).toMatch(/^[A-Z0-9][^\n]*\.$/);
      if (r.clinic) expect(r.sentence).not.toContain(r.clinic.name);
      expect(r.sentence).not.toMatch(/Paid Practice|Unread Practice|unread\.example/);
    }

    // The dated rows lead, oldest day first.
    expect(rows.slice(0, 2).map((r) => r.dueAt)).toEqual(["2000-01-03", "2000-01-03"]);
    expect(rows.slice(0, 2).map((r) => r.tone)).toEqual(["bad", "warn"]);
    expect(rows.slice(2).every((r) => r.dueAt === null)).toBe(true);
    expect(rows[2]!.tone).toBe("bad");
  });

  test("a source that throws is reported by name, never as a zero, and the others still render", async () => {
    const throwing: InboxSource = {
      name: "a broken source",
      async read() {
        throw new Error("select * from secrets where token = 'xyz'");
      },
    };
    const partial: InboxSource = {
      name: "a partial source",
      async read() {
        return { rows: [fake("ok:1")], partial: "1 clinic(s) could not be read." };
      },
    };
    const fine: InboxSource = { name: "a fine source", read: async () => ({ rows: [fake("ok:2")] }) };
    const inbox = await readOpsInbox(OPERATOR, { sources: [throwing, partial, fine] });
    expect(inbox.rows.map((r) => r.id)).toEqual(["ok:1", "ok:2"]);
    expect(inbox.unreadable).toEqual([
      { source: "a broken source", reason: "The read failed." },
      { source: "a partial source", reason: "1 clinic(s) could not be read." },
    ]);
  });

  test("both operations are reads on the closed list, refuse any argument, and need the signed envelope", async () => {
    for (const op of ["listClinicStrip", "opsInbox"] as const) {
      expect(isOpName(op)).toBe(true);
      expect(mutatingNamed(op)).toBe(false);
      const refused = await runNamed(op, { anything: true });
      expect(refused).toEqual({ status: 400, body: { error: `${op} takes no arguments.`, code: "invalid_args" } });
    }
    const read = await runNamed("opsInbox", {});
    expect(read.status).toBe(200);
    expect((read.body as { data: { rows: unknown[] } }).data.rows).toEqual([]);

    const secret = "provision_secret_for_tests_0123456789";
    process.env.HEALDESK_PROVISION_SECRET = secret;
    process.env.HEALDESK_ADMIN_EMAIL = "ops@healdesk.test";
    try {
      for (const op of ["listClinicStrip", "opsInbox"]) {
        const body = JSON.stringify({ op, args: {} });
        const unsigned = await opsRoute(
          new Request("http://localhost/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body }),
        );
        expect(unsigned.status, op).toBe(401);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const forged = await opsRoute(
          new Request("http://localhost/api/ops", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [TIMESTAMP_HEADER]: timestamp,
              [SIGNATURE_HEADER]: signOps(body, timestamp, "another_secret_0123456789abcdef"),
            },
            body,
          }),
        );
        expect(forged.status, op).toBe(401);
        const signed = await opsRoute(
          new Request("http://localhost/api/ops", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [TIMESTAMP_HEADER]: timestamp,
              [SIGNATURE_HEADER]: signOps(body, timestamp, secret),
            },
            body,
          }),
        );
        expect(signed.status, op).toBe(200);
      }
    } finally {
      delete process.env.HEALDESK_ADMIN_EMAIL;
    }
  });
  test("one opsInbox call writes no access row as the digest, and every row it writes names the operator", async () => {
    const live = await seedClinic("inbox-audit-live");
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', went_live_at = $2 where id = $1`,
      [live.clinicId, new Date(Date.now() - 8 * DAY)],
    );
    const other = await seedClinic("inbox-audit-other");
    await inTenant(other.clinicId, (client) =>
      client.query(
        `insert into retell_recording_alerts (clinic_id, retell_call_id, detected_at) values ($1, $2, now() - interval '1 hour')`,
        [other.clinicId, `call_${randomUUID().slice(0, 8)}`],
      ),
    );
    // audit_log forces row-level security, so each clinic's rows are read in its tenant.
    const start = new Date(Date.now() - 1000);
    await readOpsInbox(OPERATOR);
    const rows: { service: string | null; purpose: string | null }[] = [];
    for (const clinicId of [live.clinicId, other.clinicId]) {
      const found = await inTenant(clinicId, (client) =>
        client.query<{ service: string | null; purpose: string | null }>(
          `select actor_service_name as service, metadata->>'purpose' as purpose from audit_log where occurred_at >= $1`,
          [start],
        ),
      );
      rows.push(...found.rows);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.purpose === "ops_digest")).toEqual([]);
    expect(new Set(rows.map((r) => r.service))).toEqual(new Set([OPERATOR.email]));
  });

  test("a first-weeks clinic that cannot be read makes that source partial, and the others still list", async () => {
    const good = await seedClinic("inbox-health-good");
    const bad = await seedClinic("inbox-health-bad");
    for (const c of [good, bad]) {
      await getMigratorPool().query(
        `update clinics set data_classification = 'production', went_live_at = $2 where id = $1`,
        [c.clinicId, new Date(Date.now() - 8 * DAY)],
      );
    }
    failing.clinicId = bad.clinicId;
    try {
      const inbox = await readOpsInbox(OPERATOR);
      expect(inbox.unreadable).toContainEqual({ source: "the first-weeks flags", reason: "1 clinic(s) could not be read." });
      expect(inbox.rows.map((r) => r.id)).toContain(`health:no_calls_after_day_7:${good.clinicId}`);
      expect(inbox.rows.some((r) => r.clinic?.id === bad.clinicId)).toBe(false);
    } finally {
      failing.clinicId = null;
    }
  });

  test("the alerts source reports its cap as partial instead of a complete list", async () => {
    await getMigratorPool().query(
      `insert into ops_alerts (event, dedupe_key, fields)
       select 'daily_email_count_70', 'cap|' || g, '{}'::jsonb from generate_series(1, 500) g`,
    );
    const inbox = await readOpsInbox(OPERATOR);
    expect(inbox.unreadable).toContainEqual({
      source: "ops alerts",
      reason: "Only the newest 500 alerts of the last day were read.",
    });
    expect(inbox.rows.find((r) => r.id === "alert:daily_email_count_70:all")?.count).toBe(500);
  });
  test("the two anchors Home's new rows open are rendered by apps/web's Setup tab", () => {
    const setup = sourcesUnder(join(WEB_APP, "admin", "clinics", "[clinicId]", "setup")).join("\n");
    expect(setup).toContain('id="availability"');
    expect(setup).toContain('id="setup-window"');
    expectConsolePage(`/admin/clinics/${randomUUID()}/setup#availability`);
    expectConsolePage(`/admin/clinics/${randomUUID()}/setup#setup-window`);
    // And the guard catches a retired address and a missing anchor.
    expect(() => expectConsolePage(`/admin/ops/${randomUUID()}/care`)).toThrow();
    expect(() => expectConsolePage(`/admin/clinics/${randomUUID()}/setup#no-such-card`)).toThrow();
  });

  test("availability: a failure, a warning a change brought, a change nobody audits, and changes unseen for a day are one row per clinic; setup-state results are not", async () => {
    await setClinicAudits(false);
    const ago = (ms: number) => new Date(Date.now() - ms);
    // Failing: the availability pack failed after an audited change.
    const failing = await seedClinic("inbox-av-fail");
    await seedChange(failing.clinicId, { auditStatus: "attention", changedAt: ago(2 * HOUR), seenAt: new Date() });
    await seedAudit(failing.clinicId, "availability", "fail", ago(HOUR));
    await seedAudit(failing.clinicId, "roster", "pass", ago(HOUR));
    // A warning a change brought: the roster passed, then a change, then it warned.
    const warned = await seedClinic("inbox-av-warn");
    await seedAudit(warned.clinicId, "roster", "pass", ago(3 * HOUR));
    await seedChange(warned.clinicId, { auditStatus: "attention", changedAt: ago(2 * HOUR), seenAt: new Date() });
    await seedAudit(warned.clinicId, "roster", "warn", ago(HOUR));
    // Audited before, then changed while the audits are off: no status, newer than the audit.
    const unchecked = await seedClinic("inbox-av-off");
    await seedAudit(unchecked.clinicId, "availability", "pass", ago(2 * HOUR));
    await seedChange(unchecked.clinicId, { auditStatus: null, changedAt: ago(HOUR) });
    // Three changes audited and passed, never marked seen, older than a day; one seen.
    const unseen = await seedClinic("inbox-av-unseen");
    for (const days of [2, 3, 4]) {
      await seedChange(unseen.clinicId, { auditStatus: "passed", changedAt: ago(days * DAY) });
    }
    await seedChange(unseen.clinicId, { auditStatus: "passed", changedAt: ago(5 * DAY), seenAt: new Date() });
    await seedAudit(unseen.clinicId, "availability", "pass", ago(HOUR));
    // No row:
    // still in setup, go-live failing (every clinic not in production), transcripts
    // warning, and availability warning for a setup state after a pass, no change;
    const setup = await seedClinic("inbox-av-setup");
    await seedAudit(setup.clinicId, "availability", "pass", ago(2 * DAY));
    await seedAudit(setup.clinicId, "availability", "warn", ago(HOUR));
    await seedAudit(setup.clinicId, "golive", "fail", ago(HOUR));
    await seedAudit(setup.clinicId, "transcripts", "warn", ago(HOUR));
    // an old change the hourly run audited since (no status, older than the last audit);
    const reaudited = await seedClinic("inbox-av-reaudited");
    await seedChange(reaudited.clinicId, { auditStatus: null, changedAt: ago(2 * HOUR), seenAt: new Date() });
    await seedAudit(reaudited.clinicId, "availability", "pass", ago(HOUR));
    // a change an hour old, audited and passed;
    const fresh = await seedClinic("inbox-av-fresh");
    await seedChange(fresh.clinicId, { auditStatus: "passed", changedAt: ago(HOUR) });
    await seedAudit(fresh.clinicId, "availability", "pass");
    // healdesk's demo clinic and a closed account, each with a change nobody audits.
    const demo = await seedDemoClinic("inbox-av-demo");
    await seedChange(demo.clinicId, { auditStatus: null, changedAt: ago(2 * DAY) });
    const closed = await seedClinic("inbox-av-closed");
    await seedChange(closed.clinicId, { auditStatus: null, changedAt: ago(2 * DAY) });
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [closed.clinicId]);

    const { rows, unreadable } = await readOpsInbox(OPERATOR);
    expect(unreadable).toEqual(await expectedUnreadable());
    const mine = rows.filter((r) => r.kind === "availability");
    expect(mine.map((r) => r.clinic?.id).sort()).toEqual(
      [failing.clinicId, warned.clinicId, unchecked.clinicId, unseen.clinicId].sort(),
    );
    const link = (id: string) => ({ label: "Open availability", kind: "link", href: `/admin/clinics/${id}/setup#availability` });
    expect(row(rows, `availability:${failing.clinicId}`)).toEqual({
      id: `availability:${failing.clinicId}`,
      kind: "availability",
      count: 1,
      sentence: AVAILABILITY_WORDS.fail,
      clinic: { id: failing.clinicId, name: "inbox-av-fail Clinic" },
      button: link(failing.clinicId),
      tone: "warn",
      dueAt: null,
    });
    expect(row(rows, `availability:${warned.clinicId}`)).toMatchObject({ count: 1, sentence: AVAILABILITY_WORDS.warn });
    expect(row(rows, `availability:${unchecked.clinicId}`)).toMatchObject({
      count: 1,
      sentence: AVAILABILITY_WORDS.audits_off,
      button: link(unchecked.clinicId),
    });
    expect(row(rows, `availability:${unseen.clinicId}`)).toMatchObject({ count: 3, sentence: AVAILABILITY_WORDS.unseen });

    // A change queued while the audits are on is being checked: no row for it.
    const queued = await seedClinic("inbox-av-queued");
    await seedChange(queued.clinicId, { auditStatus: "queued", changedAt: ago(HOUR) });
    await setClinicAudits(true);
    try {
      const on = await readOpsInbox(OPERATOR);
      expect(on.rows.some((r) => r.id === `availability:${queued.clinicId}`)).toBe(false);
    } finally {
      await setClinicAudits(false);
    }
    // Queued, and the audits are now off: nobody will check it.
    expect((await readOpsInbox(OPERATOR)).rows.map((r) => r.id)).toContain(`availability:${queued.clinicId}`);
  });

  test("one issue, one row: an availability change and a decision owed are not said again by their ops alerts", async () => {
    await setClinicAudits(false);
    const changed = await seedClinic("inbox-once-changed");
    await seedChange(changed.clinicId, { auditStatus: null, changedAt: new Date(Date.now() - HOUR) });
    await raiseAlert("clinic_availability_changed", { clinicId: changed.clinicId });
    const owed = await seedClinic("inbox-once-owed");
    await seedLifecycleRow(owed.clinicId, { stage: "waiting_on_us", stageSince: new Date(Date.now() - 5 * DAY) });
    for (const event of [
      "lifecycle_decision_due",
      "lifecycle_waiting_on_us",
      "lifecycle_waiting_on_us_long",
      "lifecycle_closing_waiting_on_us",
    ]) {
      await raiseAlert(event, { clinicId: owed.clinicId });
    }
    const { rows } = await readOpsInbox(OPERATOR);
    expect(rows.filter((r) => r.clinic?.id === changed.clinicId).map((r) => r.id)).toEqual([`availability:${changed.clinicId}`]);
    expect(rows.filter((r) => r.clinic?.id === owed.clinicId).map((r) => r.id)).toEqual([`decision:${owed.clinicId}`]);
  });

  test("needs a decision: every clinic the lifecycle view says owes one, with the recommendation, due on the window's last day", async () => {
    const zone = "America/New_York";
    const now = Date.now();
    // In setup, stalled, two days left: red.
    const closing = await seedClinic("inbox-dec-closing");
    await seedLifecycleRow(closing.clinicId, {
      stage: "in_setup",
      stageSince: new Date(now - 20 * DAY),
      stepsLeft: 3,
      lastProgressAt: new Date(now - 12 * DAY),
      deadlineAt: setupDeadline(new Date(now - 28 * DAY), zone),
    });
    // In setup, stalled, six days left: amber.
    const stalled = await seedClinic("inbox-dec-stalled");
    await seedLifecycleRow(stalled.clinicId, {
      stage: "in_setup",
      stageSince: new Date(now - 20 * DAY),
      stepsLeft: 2,
      lastProgressAt: new Date(now - 2 * DAY),
      deadlineAt: setupDeadline(new Date(now - 24 * DAY), zone),
    });
    // Waiting on us for five days, twenty days left, its routine alerts snoozed: the row stays.
    const waiting = await seedClinic("inbox-dec-waiting");
    await seedLifecycleRow(waiting.clinicId, {
      stage: "waiting_on_us",
      stageSince: new Date(now - 5 * DAY),
      deadlineAt: setupDeadline(new Date(now - 10 * DAY), zone),
      snoozedUntil: new Date(now + 3 * DAY),
    });
    // Owing nothing: decided already; early in the window; no lifecycle row.
    const decided = await seedClinic("inbox-dec-decided");
    await seedLifecycleRow(decided.clinicId, {
      stage: "in_setup",
      stepsLeft: 3,
      deadlineAt: setupDeadline(new Date(now - 28 * DAY), zone),
      decision: "let_close",
    });
    const early = await seedClinic("inbox-dec-early");
    await seedLifecycleRow(early.clinicId, { stage: "in_setup", stepsLeft: 3, deadlineAt: setupDeadline(new Date(now - 3 * DAY), zone) });
    const unwatched = await seedClinic("inbox-dec-unwatched");
    for (const c of [closing, stalled, waiting, decided, early, unwatched]) {
      await getMigratorPool().query(`update clinics set timezone = $2 where id = $1`, [c.clinicId, zone]);
    }

    const { rows, unreadable } = await readOpsInbox(OPERATOR);
    expect(unreadable).toEqual(await expectedUnreadable());
    const mine = rows.filter((r) => r.kind === "decision");
    expect(mine.map((r) => r.clinic?.id).sort()).toEqual([closing.clinicId, stalled.clinicId, waiting.clinicId].sort());
    const link = (id: string) => ({ label: "Decide", kind: "link", href: `/admin/clinics/${id}/setup#setup-window` });
    const lastDay = (start: number) => {
      const deadline = setupDeadline(new Date(start), zone);
      return new Date(deadline.getTime() + 1 - DAY).toLocaleDateString("en-CA", { timeZone: zone });
    };
    expect(row(rows, `decision:${closing.clinicId}`)).toEqual({
      id: `decision:${closing.clinicId}`,
      kind: "decision",
      count: 1,
      sentence: expect.stringMatching(/^Setup has stalled with 2 days left; recommended: [a-z].*\.$/),
      clinic: { id: closing.clinicId, name: "inbox-dec-closing Clinic" },
      button: link(closing.clinicId),
      tone: "bad",
      dueAt: lastDay(now - 28 * DAY),
    });
    expect(row(rows, `decision:${stalled.clinicId}`)).toMatchObject({
      sentence: expect.stringMatching(/^Setup has stalled with 6 days left; recommended: [a-z].*\.$/),
      tone: "warn",
      dueAt: lastDay(now - 24 * DAY),
    });
    // The work owed is ours: the button opens the window rather than asking for a decision.
    expect(row(rows, `decision:${waiting.clinicId}`)).toMatchObject({
      sentence: expect.stringMatching(
        /^The clinic has been waiting on us for over a business day; recommended: [a-z].*; routine alerts are snoozed\.$/,
      ),
      tone: "warn",
      button: { ...link(waiting.clinicId), label: "Open setup window" },
    });
    expect(row(rows, `decision:${closing.clinicId}`).sentence).not.toContain("snoozed");
    for (const r of mine) {
      expect(r.sentence).not.toMatch(/_|\bnull\b|undefined/);
      expect(r.sentence).not.toContain(r.clinic!.name);
      expectConsolePage((r.button as { href: string }).href);
    }
    // Dated rows lead: the window closing soonest first.
    expect(rows.filter((r) => r.dueAt !== null).map((r) => r.id).slice(0, 2)).toEqual([
      `decision:${closing.clinicId}`,
      `decision:${stalled.clinicId}`,
    ]);
  });

  test("each new source degrades on its own: an unreadable clinic makes either partial; an unreadable lifecycle loses only the decisions", async () => {
    await setClinicAudits(false);
    const good = await seedClinic("inbox-a4-good");
    await seedChange(good.clinicId, { auditStatus: null });
    const bad = await seedClinic("inbox-a4-bad");
    await seedChange(bad.clinicId, { auditStatus: null });
    const owed = await seedClinic("inbox-a4-owed");
    await seedLifecycleRow(owed.clinicId, { stage: "waiting_on_us", stageSince: new Date(Date.now() - 5 * DAY) });
    const owedToo = await seedClinic("inbox-a4-owed-too");
    await seedLifecycleRow(owedToo.clinicId, { stage: "waiting_on_us", stageSince: new Date(Date.now() - 5 * DAY) });

    failingA4.auditClinicId = bad.clinicId;
    try {
      const inbox = await readOpsInbox(OPERATOR);
      expect(inbox.unreadable).toContainEqual({ source: "the availability audits", reason: "1 clinic(s) could not be read." });
      expect(inbox.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([`availability:${good.clinicId}`, `decision:${owed.clinicId}`]),
      );
      expect(inbox.rows.some((r) => r.id === `availability:${bad.clinicId}`)).toBe(false);
    } finally {
      failingA4.auditClinicId = null;
    }

    // One clinic's lifecycle cannot be read: the others' decisions still list.
    failingA4.lifecycleClinicId = owedToo.clinicId;
    try {
      const inbox = await readOpsInbox(OPERATOR);
      expect(inbox.unreadable).toContainEqual({ source: "the setup decisions", reason: "1 clinic(s) could not be read." });
      expect(inbox.rows.map((r) => r.id)).toContain(`decision:${owed.clinicId}`);
      expect(inbox.rows.some((r) => r.id === `decision:${owedToo.clinicId}`)).toBe(false);
    } finally {
      failingA4.lifecycleClinicId = null;
    }

    failingA4.lifecycle = true;
    try {
      const inbox = await readOpsInbox(OPERATOR);
      expect(inbox.unreadable).toContainEqual({ source: "the setup decisions", reason: "The read failed." });
      expect(inbox.unreadable.some((u) => u.source === "the availability audits")).toBe(false);
      expect(inbox.rows.some((r) => r.kind === "decision")).toBe(false);
      expect(inbox.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([`availability:${good.clinicId}`, `availability:${bad.clinicId}`]),
      );
    } finally {
      failingA4.lifecycle = false;
    }
  });
});
