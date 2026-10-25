import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { LINK_PLACEHOLDER, renderContactDraft, renderContactEmail, emailPayloadOf } from "@/lib/approvals/contact-drafts";
import { DRAFT_KINDS, EDITABLE, parseContactPayload, parseFields, type ContactPayloads } from "@/lib/approvals/contact-payloads";
import { decideDraft, NOT_FIELDS, serialiseDraft } from "@/lib/approvals/drafts";
import { CONTACT_KINDS, draftHash, KIND_SPECS } from "@/lib/approvals/kinds";
import { proposeApprovals } from "@/lib/approvals/proposers";
import { getApproval } from "@/lib/approvals/store";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import { flagInsuranceMismatch } from "@/lib/agreements/misclassification";
import { openAgreementResign, readResignToken, sendAgreementToSign } from "@/lib/agreements/resign";
import { assertPayloadAllowed, copyProblems, linkProblems, subjectProblems } from "@/lib/email/lint";
import { NOTES, PHRASES } from "@/lib/email/templates/contact-words";
import { watchLifecycles } from "@/lib/lifecycle/watch";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { opDecideApproval } from "@/lib/ops/approval-ops";
import { approvalSentence } from "@/lib/ops/inbox/approvals";
import { opPullReminderForward } from "@/lib/ops/notice-ops";
import { queueSetupReminder, queueSetupReminderNow } from "@/lib/setup/reminders";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedChannels } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The clinic-contact approvals (ops automation lane P6f; design E6 §3 items
 * 13 and 14, E2 "Manual buttons"; owner decisions D4, D6, D12): the five
 * emails the owner sends a clinic by hand and "Send reminder now", each only
 * through the approval inbox. Synthetic clinics, Resend faked.
 *
 * Times are anchored on the real clock (the ledger stamps sent_at from it),
 * and every function under test is handed its `now`.
 */

vi.setConfig({ testTimeout: 90_000 });

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" },
};
const ENV = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "BETTER_AUTH_URL",
  "HEALDESK_APP_URL",
  "HEALDESK_CALL_BOOKING_URL",
] as const;
const SAVED: Record<string, string | undefined> = {};
let keys = 0;

/** Noon in New York today, by the real clock. */
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 16 * HOUR);
const at = (ms: number) => new Date(NOW.getTime() + ms);

const CTX = { clinicName: "Radiance Med Spa", audience: "patients" as const, timeZone: "America/New_York" };
const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const FIXTURES: { [K in (typeof DRAFT_KINDS)[number]]: ContactPayloads[K] } = {
  baa_resign_chase: {
    ...CTX,
    clinicId: ID,
    resignId: ID,
    round: 1,
    fromVersion: "1.5.0",
    toVersion: "1.6.0",
    isAnswering: true,
    note: null,
  },
  agreement_question: { ...CTX, clinicId: ID, reviewId: ID, locations: 3, isAnswering: true, note: null },
  setup_extended: {
    ...CTX,
    clinicId: ID,
    clinicSlug: "radiance-med-spa",
    fromDeadline: "2026-11-06T04:59:59.999Z",
    days: 14,
    stepsLeftCount: 1,
    rows: [{ channel: "voice", status: "forwarding" }],
    note: null,
  },
  setup_waiting_on_us: { ...CTX, clinicId: ID, stageSince: "2026-10-20T16:00:00.000Z", phrase: "phone", note: null },
  setup_help_offer: {
    ...CTX,
    clinicId: ID,
    stage: "in_setup",
    stageSince: "2026-10-20T16:00:00.000Z",
    phrase: "website_chat",
    note: null,
  },
};

function saveEnv() {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
  process.env.RESEND_API_KEY = `re_stub_${keys++}`;
  process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  delete process.env.HEALDESK_APP_URL;
  delete process.env.HEALDESK_CALL_BOOKING_URL;
}
function restoreEnv() {
  for (const key of ENV) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

describe("the drafts: fixed words from closed fields only (D12)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  test("each kind's draft is its template's text, and changes only where a field changes", () => {
    for (const kind of DRAFT_KINDS) {
      const payload = FIXTURES[kind] as ContactPayloads[typeof kind];
      expect(parseContactPayload(kind, payload), kind).not.toBeNull();
      const draft = renderContactDraft(kind, payload);
      expect(subjectProblems(draft.subject), kind).toEqual([]);
      expect(copyProblems(`${draft.subject}\n${draft.body}`), kind).toEqual([]);
      // The same payload renders the same bytes: the stored hash is stable.
      expect(draftHash(serialiseDraft(renderContactDraft(kind, payload)))).toBe(draftHash(serialiseDraft(draft)));
      const note = EDITABLE[kind].find((f) => f.field === "note");
      if (note && note.type === "choice") {
        for (const code of note.options) {
          const withNote = renderContactDraft(kind, { ...payload, note: code } as never);
          expect(withNote.body.length, `${kind} ${code}`).toBeGreaterThan(draft.body.length);
          expect(withNote.subject).toBe(draft.subject);
        }
      }
    }
    const longer = renderContactDraft("setup_extended", { ...FIXTURES.setup_extended, days: 20 });
    expect(longer.body).toContain("20 more days");
    expect(renderContactDraft("setup_extended", FIXTURES.setup_extended).body).toContain("14 more days");
  });

  test("hostile field values are all refused, and no typed text is accepted as an edit", () => {
    const hostile: unknown[] = [
      { note: "Call us on 555 123 4567" },
      { note: "<script>alert(1)</script>" },
      { note: "reply_questions", body: "free text" },
      { subject: "x", body: "y" },
      "a sentence",
      null,
      [],
    ];
    for (const fields of hostile) expect(parseFields("baa_resign_chase", fields).ok, JSON.stringify(fields)).toBe(false);
    // reply_questions repeats the chase's own last line, so it is not offered there.
    expect(parseFields("baa_resign_chase", { note: "reply_questions" }).ok).toBe(false);
    for (const days of [0, 31, 1.5, "7", -3, null]) {
      expect(parseFields("setup_extended", { days, note: null }).ok, String(days)).toBe(false);
    }
    for (const phrase of ["pause", "your phone", "", 3]) {
      expect(parseFields("setup_help_offer", { phrase, note: null }).ok, String(phrase)).toBe(false);
    }
    expect(parseFields("setup_extended", { days: 30, note: "thanks" })).toEqual({ ok: true, fields: { days: 30, note: "thanks" } });
    // The decision refuses a subject-and-body edit outright, and a hostile field.
    const payload = FIXTURES.setup_help_offer;
    const stored = serialiseDraft(renderContactDraft("setup_help_offer", payload));
    const item = { draft: stored, draftHash: draftHash(stored), kind: "setup_help_offer", payload };
    expect(decideDraft(true, item, { subject: "Hi", body: "Anything I like" })).toEqual({
      ok: false,
      code: "draft_refused",
      problems: [NOT_FIELDS],
    });
    expect(decideDraft(true, item, { fields: { phrase: "phone", note: "<b>x</b>" } })).toMatchObject({ ok: false, code: "draft_refused" });
    const edited = decideDraft(true, item, { fields: { phrase: "calendar", note: "thanks" } });
    expect(edited).toMatchObject({ ok: true, edited: true });
    if (!edited.ok || !edited.draft) throw new Error("expected a draft");
    expect(edited.draft.body).toContain("your Google Calendar connection");
    expect(edited.draft.fields).toEqual({ phrase: "calendar", note: "thanks" });
    expect(decideDraft(true, item, undefined)).toMatchObject({ ok: true, edited: false, hashApproved: draftHash(stored) });
  });

  test("the chase names no pause, suspension or deadline, and its draft holds no link", () => {
    for (const isAnswering of [true, false]) {
      for (const note of [null, "call_offer", "thanks"] as const) {
        const payload = { ...FIXTURES.baa_resign_chase, isAnswering, note };
        const draft = renderContactDraft("baa_resign_chase", payload);
        const sent = renderContactEmail("baa_resign_chase", payload, "https://app.healdesk.test/agreement/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf0hIj3kLm6nOp9qRs2tUv5wXy8zAb1dEf4hIj7kLm0nOp3qRs6tUv9w");
        for (const text of [draft.subject, draft.body, sent.text, sent.html]) {
          expect(text).not.toMatch(/\b(pause|paused|pauses|suspend|suspended|suspension|deadline|until \w+ \d)/i);
        }
        expect(draft.body).toContain(LINK_PLACEHOLDER);
        expect(draft.body).not.toMatch(/\/agreement\/[A-Za-z0-9_-]{32,}/);
        expect(linkProblems({ subject: sent.subject, text: sent.text, html: sent.html }, "baa_resign_chase")).toEqual([]);
      }
    }
    expect(renderContactDraft("baa_resign_chase", FIXTURES.baa_resign_chase).body).toContain(
      "AYA keeps answering as normal under the version you signed (1.5.0).",
    );
  });

  test("the question says plainly that AYA pauses until it is signed, at every location", () => {
    const one = renderContactDraft("agreement_question", { ...FIXTURES.agreement_question, locations: 1 });
    expect(one.body).toContain("AYA pauses until it's signed");
    const three = renderContactDraft("agreement_question", FIXTURES.agreement_question);
    expect(three.body).toContain("AYA pauses at all 3 of your locations until it's signed");
    expect(three.body).toContain("Yes, No or Not sure");
    const notLive = renderContactDraft("agreement_question", { ...FIXTURES.agreement_question, isAnswering: false });
    expect(notLive.body).toContain("AYA starts answering only once it's signed");
  });

  test("the waiting-on-us note extends nothing and promises no credited time (D6)", () => {
    const draft = renderContactDraft("setup_waiting_on_us", FIXTURES.setup_waiting_on_us);
    expect(draft.subject).toBe("Nothing for you to do: we're finishing your phone line");
    expect(draft.body).not.toMatch(/count against|extend|more time|deadline/i);
    for (const phrase of PHRASES) {
      const subject = renderContactDraft("setup_waiting_on_us", { ...FIXTURES.setup_waiting_on_us, phrase }).subject;
      expect(subjectProblems(subject), phrase).toEqual([]);
    }
  });

  test("each email's payload passes the payload allowlist and its links the scanner; a sentence in a code field is refused", () => {
    const chase = emailPayloadOf("baa_resign_chase", FIXTURES.baa_resign_chase, "https://app.healdesk.test/agreement/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf0hIj3kLm6nOp9qRs2tUv5wXy8zAb1dEf4hIj7kLm0nOp3qRs6tUv9w");
    assertPayloadAllowed(chase, "baa_resign_chase");
    assertPayloadAllowed(emailPayloadOf("agreement_question", FIXTURES.agreement_question), "agreement_question");
    assertPayloadAllowed(emailPayloadOf("setup_extended", FIXTURES.setup_extended), "setup_extended");
    assertPayloadAllowed(emailPayloadOf("setup_waiting_on_us", FIXTURES.setup_waiting_on_us), "setup_waiting_on_us");
    assertPayloadAllowed(emailPayloadOf("setup_help_offer", FIXTURES.setup_help_offer), "setup_help_offer");
    expect(() => assertPayloadAllowed({ note: "free words in a note" }, "setup_help_offer")).toThrow();
    expect(() => assertPayloadAllowed({ phrase: "call 5551234567 now" }, "setup_help_offer")).toThrow();
    expect(() => assertPayloadAllowed({ fromVersion: "one point five" }, "baa_resign_chase")).toThrow();
    // A signing token is a link email's alone: in any outbox kind it is refused.
    const tokenLink = "https://app.healdesk.test/agreement/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf0hIj3kLm6n";
    expect(linkProblems({ subject: "s", text: tokenLink, html: "" }, "setup_help_offer")).not.toEqual([]);
    expect(linkProblems({ subject: "s", text: tokenLink, html: "" }, "baa_resign_chase")).toEqual([]);
    for (const note of NOTES) expect(note).toMatch(/^[a-z_]+$/);
  });

  test("the kinds: routine, a fresh code, a 14-day window for each email (3 for the reminder); Home's words plain", () => {
    for (const kind of CONTACT_KINDS) {
      expect(KIND_SPECS[kind], kind).toMatchObject({ urgency: "routine", irreversible: true, retriedBy: null });
      expect(KIND_SPECS[kind].expiryDays).toBe(kind === "setup_reminder_now" ? 3 : 14);
      expect(approvalSentence(kind, 1)).not.toMatch(/_/);
      expect(approvalSentence(kind, 2)).toMatch(/^2 /);
    }
    for (const op of ["proposeAgreementQuestion", "recordAgreementAnswer", "proposeLifecycleNotice", "pullReminderForward"]) {
      expect(isOpName(op), op).toBe(true);
      expect(isMutating(op as never), op).toBe(true);
    }
    for (const op of ["listOpenResigns", "previewApprovalDraft"]) {
      expect(isOpName(op), op).toBe(true);
      expect(isMutating(op as never), op).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

type Data = Record<string, unknown>;
function data(out: { status: number; body: unknown }): Data {
  expect(out.status).toBe(200);
  return (out.body as { data: Data }).data;
}

async function decide(id: string, extra: Data = {}, now = at(HOUR)) {
  return data(await opDecideApproval({ id, action: "approve", reasonCode: "owner_checked", codeChecked: true, ...extra }, OPERATOR, { now }));
}

async function eventsOf(approvalId: string) {
  const { rows } = await getMigratorPool().query<{
    event: string;
    actor_label: string;
    outcome_code: string | null;
    draft_hash_approved: string | null;
    draft_hash_sent: string | null;
  }>(`select event, actor_label, outcome_code, draft_hash_approved, draft_hash_sent from ops_approval_events where approval_id = $1 order by at, event`, [approvalId]);
  return rows;
}

async function itemsOf(clinicId: string, kind: string) {
  const { rows } = await getMigratorPool().query<{ id: string; status: string; subject_ref: string; draft: string | null; outcome_code: string | null }>(
    `select id, status, subject_ref, draft, outcome_code from ops_approvals where subject_clinic_id = $1 and kind = $2 order by proposed_at`,
    [clinicId, kind],
  );
  return rows;
}

async function notices(c: PortalClinic, kind: string) {
  return inTenant(c.clinicId, async (q) =>
    (
      await q.query<{ dedupe_key: string; payload: Data }>(
        `select dedupe_key, payload from billing_notices where clinic_id = $1 and kind = $2 order by created_at`,
        [c.clinicId, kind],
      )
    ).rows,
  );
}

async function setAsideWaiting(): Promise<void> {
  await getMigratorPool().query(`update ops_approvals set status = 'expired', decided_at = now() where status = 'waiting'`);
}

/** A paying clinic in setup, `day` days into its 30-day window, its lifecycle row written by the real watch. */
async function setupClinic(label: string, day: number): Promise<PortalClinic> {
  const c = await provisionPortalClinic(`${label}-${randomUUID().slice(0, 4)}`, { plan: "voice-metachat-1000-1000" });
  await getMigratorPool().query(`update clinics set timezone = 'America/New_York' where id = $1`, [c.clinicId]);
  await inTenant(c.clinicId, (q) =>
    q.query(
      `update entitlements set stripe_customer_id = $2, stripe_subscription_id = $3, status = 'active', setup_deadline_at = $4 where clinic_id = $1`,
      [c.clinicId, `cus_test_${randomUUID().slice(0, 8)}`, `sub_test_${randomUUID().slice(0, 8)}`, new Date(NOW.getTime() + (31 - day) * DAY - 11 * HOUR)],
    ),
  );
  await watchLifecycles(NOW);
  return c;
}

describeDb("the clinic-contact approvals, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);
  beforeEach(async () => {
    saveEnv();
    send.mockReset();
    send.mockResolvedValue({ data: { id: "msg_test" }, error: null, headers: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  }, 60_000);
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await setAsideWaiting();
    await closePools();
  });

  test("the CHECK on ops_approvals.kind takes the new kinds and nothing else", async () => {
    const pool = getMigratorPool();
    const insert = (kind: string) =>
      pool.query(
        `insert into ops_approvals (kind, subject_ref, payload, due_at, urgency, proposed_by) values ($1, $2, '{}'::jsonb, now() + interval '1 day', 'routine', 'ops-console') returning id`,
        [kind, `check-${randomUUID()}`],
      );
    for (const kind of CONTACT_KINDS) await expect(insert(kind), kind).resolves.toBeDefined();
    await expect(insert("support_reply")).rejects.toThrow(/ops_approvals_kind_check/);
    await expect(insert("free_text_email")).rejects.toThrow(/ops_approvals_kind_check/);
    await setAsideWaiting();
  });

  test("the chase: proposed only after day 7 with L22 spent, once a round, never within 7 days; sent once with a link minted at send", async () => {
    const c = await setupClinic("chase", 10);
    const started = at(-10 * DAY);
    const resignId = await withTenant({ clinicId: c.clinicId, actor: { type: "service", serviceName: "test" } }, async (tx) => {
      const agreement = await agreementInEffect(tx);
      return (
        await openAgreementResign(tx, {
          fromAgreementId: agreement!.agreementId,
          reason: "baa_version",
          source: "operator",
          requestedBy: "ops@healdesk.test",
          pause: false,
          now: started,
        })
      ).resignId;
    });
    // L22 and its first reminder, as the hourly job sends them: not yet spent at day 6.
    expect(await sendAgreementToSign({ clinicId: c.clinicId, resignId, waitingDays: 0 }, { now: started })).toBe(true);
    expect(await sendAgreementToSign({ clinicId: c.clinicId, resignId, waitingDays: 3 }, { now: at(-7 * DAY) })).toBe(true);
    await proposeApprovals(at(-4 * DAY));
    expect(await itemsOf(c.clinicId, "baa_resign_chase")).toEqual([]);
    // Day 7's reminder, then day 8: proposed once, however often the job runs.
    expect(await sendAgreementToSign({ clinicId: c.clinicId, resignId, waitingDays: 7 }, { now: at(-3 * DAY) })).toBe(true);
    await proposeApprovals(at(-2 * DAY));
    await proposeApprovals(at(-2 * DAY + HOUR));
    const items = await itemsOf(c.clinicId, "baa_resign_chase");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "waiting", subject_ref: `${resignId}:1` });
    expect(items[0]!.draft).toContain(LINK_PLACEHOLDER);
    expect(items[0]!.draft).not.toMatch(/\/agreement\/[A-Za-z0-9_-]{32,}/);
    expect(items[0]!.draft).not.toMatch(/paus|suspen|deadline/i);
    // The cross-clinic list shows it, chaseable.
    const list = data(await runOperation("listOpenResigns", {}, OPERATOR));
    const row = (list.resigns as Data[]).find((r) => r.resignId === resignId);
    expect(row).toMatchObject({ reason: "baa_version", holdsPause: false, chaseBlocked: null, belowFloor: false });
    expect(row!.daysOpen).toBeGreaterThanOrEqual(9);
    expect(row!.lastL22SentAt).not.toBeNull();

    send.mockClear();
    const out = await decide(items[0]!.id, { editedDraft: { fields: { note: "thanks" } } }, NOW);
    expect(out).toMatchObject({ status: "executed", outcomeCode: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0]![0] as { to: string; text: string; subject: string };
    expect(mail.to).toBe(c.email);
    expect(mail.subject).toBe("Your updated business associate agreement is waiting");
    const token = /\/agreement\/([A-Za-z0-9_-]{92})/.exec(mail.text)?.[1];
    expect(token).toBeDefined();
    expect(readResignToken(token, NOW)).toMatchObject({ ok: true, resignId, clinicId: c.clinicId });
    expect(mail.text).toContain("Thank you for your patience");
    // Both hashes kept: the edit's, approved, and what was sent, equal word for word.
    const events = await eventsOf(items[0]!.id);
    expect(events.map((e) => e.event)).toEqual(["proposed", "edited", "approved", "executed"]);
    const approved = events.find((e) => e.event === "approved")!.draft_hash_approved;
    expect(approved).toMatch(/^[0-9a-f]{64}$/);
    expect(events.find((e) => e.event === "executed")!.draft_hash_sent).toBe(approved);
    // The token is in no row: the approval, its events or the ledger.
    const stored = await getMigratorPool().query(`select draft, payload::text as payload from ops_approvals where id = $1`, [items[0]!.id]);
    expect(JSON.stringify(stored.rows)).not.toContain(token!);

    // Round 2 begins on day 15, but the chase went less than 7 days ago: nothing.
    await proposeApprovals(at(5 * DAY));
    expect((await itemsOf(c.clinicId, "baa_resign_chase")).filter((i) => i.status === "waiting")).toEqual([]);
    // Seven days on, the second round's chase.
    await proposeApprovals(at(7 * DAY + HOUR));
    const later = (await itemsOf(c.clinicId, "baa_resign_chase")).filter((i) => i.status === "waiting");
    expect(later.map((i) => i.subject_ref)).toEqual([`${resignId}:2`]);

    // Rejecting sends nothing; a window passed cannot be approved.
    send.mockClear();
    const rejected = data(
      await opDecideApproval({ id: later[0]!.id, action: "reject", reasonCode: "not_needed", codeChecked: true }, OPERATOR, { now: at(7 * DAY + 2 * HOUR) }),
    );
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(send).not.toHaveBeenCalled();
  });

  test("an email item past its 14 days cannot be approved and sends nothing", async () => {
    const c = await setupClinic("expiry", 12);
    const proposed = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_help_offer", phrase: "phone" }, OPERATOR));
    expect(proposed).toMatchObject({ status: "proposed" });
    const out = await decide(proposed.approvalId as string, {}, at(15 * DAY));
    expect(out.status).toBe("error");
    expect((await getApproval(proposed.approvalId as string))?.status).toBe("expired");
    expect(await notices(c, "setup_help_offer")).toEqual([]);
  });

  test("the agreement question: proposed by the button, approved once into the outbox; the answer needs a fresh code and is the owner's", async () => {
    const c = await setupClinic("question", 8);
    await getMigratorPool().query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false,
              site_profile = coalesce(site_profile, '{}'::jsonb) || '{"acceptsInsurance": "yes"}'::jsonb
        where id = $1`,
      [c.clinicId],
    );
    const opened = await withTenant({ clinicId: c.clinicId, actor: { type: "service", serviceName: "test" } }, (tx) =>
      flagInsuranceMismatch(tx, NOW),
    );
    expect(opened).toBe(true);
    // Forced row-level security: read in the clinic's tenant.
    const reviewOf = async () =>
      (
        await inTenant(c.clinicId, (q) =>
          q.query<{ id: string; status: string }>(`select id, status from audit_review_queue where clinic_id = $1 and kind = 'agreement_kind'`, [c.clinicId]),
        )
      ).rows[0]!;
    const reviewId = (await reviewOf()).id;
    const proposed = data(await runOperation("proposeAgreementQuestion", { clinicId: c.clinicId, reviewId }, OPERATOR));
    expect(proposed).toMatchObject({ status: "proposed" });
    // Proposing twice proposes nothing new.
    expect(data(await runOperation("proposeAgreementQuestion", { clinicId: c.clinicId, reviewId }, OPERATOR))).toMatchObject({ status: "refused" });
    const listed = data(await runOperation("listApprovals", {}, OPERATOR));
    const item = (listed.items as Data[]).find((i) => i.id === proposed.approvalId)!;
    const packet = item.packet as Data;
    expect(Object.keys(packet).sort()).toEqual(["draft", "editable", "effect", "facts", "fields", "irreversible", "operation", "stillNeeded"]);
    expect(packet.facts).toMatchObject({ kind: "agreement_question", locationsToPause: 1, reviewStatus: "open", siteAcceptsInsurance: "yes", coveredAnswer: "no" });
    // Not live yet: nothing answers to pause, and both say so.
    expect(packet.facts).toMatchObject({ isAnswering: false });
    expect(packet.effect).toContain("starts only once it is signed (1 location)");
    expect((packet.draft as Data).body).toContain("AYA starts answering only once it's signed");
    expect(JSON.stringify(packet)).not.toContain("@");

    expect(await decide(proposed.approvalId as string)).toMatchObject({ status: "executed", outcomeCode: "queued" });
    expect((await notices(c, "agreement_question")).map((n) => n.dedupe_key)).toEqual([`agreement_question:${proposed.approvalId}`]);
    expect((await decide(proposed.approvalId as string)).status).toBe("error");
    expect(await notices(c, "agreement_question")).toHaveLength(1);

    // The answer: refused without the fresh-code mark, then recorded as heard.
    expect(data(await runOperation("recordAgreementAnswer", { clinicId: c.clinicId, reviewId, answer: "no" }, OPERATOR))).toMatchObject({ status: "refused" });
    expect(data(await runOperation("recordAgreementAnswer", { clinicId: c.clinicId, reviewId, answer: "maybe", codeChecked: true }, OPERATOR))).toMatchObject({
      status: "refused",
    });
    await runOperation("recordAgreementAnswer", { clinicId: c.clinicId, reviewId, answer: "no", codeChecked: true }, OPERATOR);
    expect((await reviewOf()).status).toBe("passed");
  });

  test("more time: the extension runs first, then the email with the new last day; a refused extension emails nothing", async () => {
    const c = await setupClinic("extend", 23);
    const proposed = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_extended", days: 7 }, OPERATOR));
    expect(proposed).toMatchObject({ status: "proposed" });
    const before = (await inTenant(c.clinicId, (q) => q.query<{ d: Date }>(`select setup_deadline_at as d from entitlements where clinic_id = $1`, [c.clinicId]))).rows[0]!.d;
    // The owner changes the days to 10 before approving.
    const out = await decide(proposed.approvalId as string, { editedDraft: { fields: { days: 10, note: null } } }, NOW);
    expect(out).toMatchObject({ status: "executed", outcomeCode: "queued" });
    const after = (await inTenant(c.clinicId, (q) => q.query<{ d: Date }>(`select setup_deadline_at as d from entitlements where clinic_id = $1`, [c.clinicId]))).rows[0]!.d;
    expect(Math.round((after.getTime() - before.getTime()) / DAY)).toBe(10);
    const queued = await notices(c, "setup_extended");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ extendedDays: 10 });
    expect(typeof queued[0]!.payload.closesOn).toBe("string");

    // A second proposal for the same deadline, then the deadline moved under it: refused, nothing queued.
    const again = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_extended", days: 5 }, OPERATOR));
    expect(again).toMatchObject({ status: "proposed" });
    await inTenant(c.clinicId, (q) =>
      q.query(`update entitlements set setup_deadline_at = setup_deadline_at + interval '1 day' where clinic_id = $1`, [c.clinicId]),
    );
    const failed = await decide(again.approvalId as string, {}, NOW);
    expect(failed).toMatchObject({ status: "failed", outcomeCode: "extension_refused" });
    expect(await notices(c, "setup_extended")).toHaveLength(1);
  });

  test("the five-minute call is offered once per stage entry; waiting-on-us only while the clinic waits on us", async () => {
    const c = await setupClinic("help", 12);
    const first = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_help_offer", phrase: "phone" }, OPERATOR));
    expect(first).toMatchObject({ status: "proposed" });
    // The approvals job leaves an operator's item waiting (it is no billing
    // subject to resolve), and past its due time raises the email alert, not
    // the billing one.
    await proposeApprovals(at(HOUR));
    expect((await getApproval(first.approvalId as string))?.status).toBe("waiting");
    await proposeApprovals(at(49 * HOUR));
    expect((await getApproval(first.approvalId as string))?.status).toBe("waiting");
    const raised = await getMigratorPool().query<{ event: string; fields: Data }>(
      `select event, fields from ops_alerts where event in ('clinic_email_waiting', 'approval_waiting') and fields->>'kind' = 'setup_help_offer'`,
    );
    expect(raised.rows.map((r) => [r.event, r.fields])).toEqual([["clinic_email_waiting", { kind: "setup_help_offer", count: 1 }]]);
    expect((await eventsOf(first.approvalId as string))[0]).toMatchObject({ event: "proposed", actor_label: OPERATOR.email });
    expect(await decide(first.approvalId as string, {}, at(50 * HOUR))).toMatchObject({ status: "executed", outcomeCode: "queued" });
    expect(await notices(c, "setup_help_offer")).toHaveLength(1);
    const second = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_help_offer", phrase: "phone" }, OPERATOR));
    expect(second).toMatchObject({ status: "refused" });
    expect(data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_help_offer", phrase: "Call 555" }, OPERATOR))).toMatchObject({
      status: "refused",
    });
    expect(data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_waiting_on_us", phrase: "phone" }, OPERATOR))).toMatchObject({
      status: "refused",
    });
  });

  test("isAnswering is the organisation's: a second location live makes the question say AYA pauses, at both", async () => {
    const c = await setupClinic("orgwide", 8);
    await getMigratorPool().query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false,
              site_profile = coalesce(site_profile, '{}'::jsonb) || '{"acceptsInsurance": "yes"}'::jsonb
        where id = $1`,
      [c.clinicId],
    );
    // A second location of the same organisation, answering on website chat.
    const second = (
      await getMigratorPool().query<{ id: string }>(
        `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
         select organization_id, slug || '-loc2', name || ' Downtown', specialty, id from clinics where id = $1 returning id`,
        [c.clinicId],
      )
    ).rows[0]!.id;
    await seedChannels(second, [{ channel: "web", readyAt: at(-3 * DAY), liveAt: at(-2 * DAY) }]);
    await withTenant({ clinicId: c.clinicId, actor: { type: "service", serviceName: "test" } }, (tx) => flagInsuranceMismatch(tx, NOW));
    const reviewId = (
      await inTenant(c.clinicId, (q) => q.query<{ id: string }>(`select id from audit_review_queue where clinic_id = $1 and kind = 'agreement_kind'`, [c.clinicId]))
    ).rows[0]!.id;
    const proposed = data(await runOperation("proposeAgreementQuestion", { clinicId: c.clinicId, reviewId }, OPERATOR));
    expect(proposed).toMatchObject({ status: "proposed" });
    const item = await getApproval(proposed.approvalId as string);
    expect(item?.payload).toMatchObject({ isAnswering: true, locations: 2 });
    expect(item?.draft).toContain("AYA pauses at all 2 of your locations until it's signed");
    const listed = data(await runOperation("listApprovals", {}, OPERATOR));
    const card = (listed.items as Data[]).find((i) => i.id === proposed.approvalId)!;
    expect(card.packet).toMatchObject({ facts: { isAnswering: true, locationsToPause: 2 } });
  });

  test("a setup notice whose stage entry has passed sends nothing, and its card says so", async () => {
    const c = await setupClinic("moved", 12);
    const proposed = data(await runOperation("proposeLifecycleNotice", { clinicId: c.clinicId, kind: "setup_help_offer", phrase: "phone" }, OPERATOR));
    expect(proposed).toMatchObject({ status: "proposed" });
    // The clinic moves on: a new stage entry, as the watch records it.
    await inTenant(c.clinicId, (q) =>
      q.query(`update clinic_lifecycle set stage_since = stage_since + interval '1 hour' where clinic_id = $1`, [c.clinicId]),
    );
    const listed = data(await runOperation("listApprovals", {}, OPERATOR));
    const card = (listed.items as Data[]).find((i) => i.id === proposed.approvalId)!;
    expect(card.packet).toMatchObject({ stillNeeded: false, facts: { stageMoved: true } });
    const out = await decide(proposed.approvalId as string);
    expect(out).toMatchObject({ status: "failed", outcomeCode: "no_longer_needed" });
    expect(out.message).toContain("moved on");
    expect(await notices(c, "setup_help_offer")).toEqual([]);
  });

  test("send reminder now: the next reminder by the real clock, never the sixth, never at night, never twice in five days, never twice on its day", async () => {
    const c = await setupClinic("pull", 7);
    const keysOf = async () => (await notices(c, "setup_reminder")).map((n) => n.dedupe_key).sort();
    const backdate = (days: number) =>
      inTenant(c.clinicId, (q) =>
        q.query(`update billing_notices set created_at = created_at - make_interval(days => $2) where clinic_id = $1 and kind = 'setup_reminder'`, [
          c.clinicId,
          days,
        ]),
      );
    const night = at(-12 * HOUR); // 04:00 in New York
    // Day 5's reminder, as the hourly job sent it, just now: no burst.
    expect(await queueSetupReminder(c.clinicId, at(-2 * DAY))).toBe("queued");
    expect(data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, NOW))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("less than five days ago"),
    });
    await backdate(6);
    // At night the outbox would hold it until morning: refused.
    expect(data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, night))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("night"),
    });
    const proposed = data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, NOW));
    expect(proposed).toMatchObject({ status: "proposed", reminderNumber: 2 });
    // Approved at night: the sender refuses and nothing is queued.
    expect(await decide(proposed.approvalId as string, {}, night)).toMatchObject({ status: "failed", outcomeCode: "reminder_night" });
    expect(await keysOf()).toEqual(["setup_reminder:1"]);
    // Proposed again (the failed item does not block) and approved in the daytime.
    const again = data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, NOW));
    expect(await decide(again.approvalId as string, {}, NOW)).toMatchObject({ status: "executed", outcomeCode: "queued" });
    expect(await keysOf()).toEqual(["setup_reminder:1", "setup_reminder:2"]);
    // Its own day comes: the job sends nothing twice.
    expect(await queueSetupReminder(c.clinicId, at(3 * DAY))).toBe("already_queued");
    // Straight after, a burst is refused.
    expect(data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, NOW))).toMatchObject({ status: "refused" });
    // Reminders 3 to 5 queued long ago: the next is the sixth, never sent sooner.
    for (const n of [3, 4, 5]) {
      await inTenant(c.clinicId, (q) =>
        q.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at) select clinic_id, kind, $2, payload, created_at from billing_notices where clinic_id = $1 and dedupe_key = 'setup_reminder:1'`,
          [c.clinicId, `setup_reminder:${n}`],
        ),
      );
    }
    await backdate(10);
    expect(data(await opPullReminderForward({ clinicId: c.clinicId }, OPERATOR, NOW))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("sixth"),
    });
    expect(await queueSetupReminderNow(c.clinicId, 6, NOW)).toBe("not_due");
    expect((await keysOf()).length).toBe(5);
  });
});
