import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { chatThreads } from "@/db/schema";
import { auth } from "@/lib/auth";
import { touchChatThread } from "@/lib/chat/threads";
import { assertPayloadAllowed, copyProblems, subjectProblems } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { DAILY_SUMMARY_ENTRY } from "@/lib/email/templates/daily_summary";
import {
  FLAG_ALERT_FIXTURE,
  renderFlagAlert,
  type FlagAlertPayload,
} from "@/lib/email/templates/flag_alert";
import { templateFor, PENDING_TEMPLATES } from "@/lib/email/templates/registry";
import { WEEKLY_RECAP_ENTRY } from "@/lib/email/templates/weekly_recap";
import {
  finishPasskeyAuthentication,
  startPasskeyAuthentication,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { collectDigest } from "@/lib/ops/digest";
import { sendFlagAlert } from "@/lib/ops/flag-alert";
import {
  destroyClinicData,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { saveKnowledge } from "@/lib/portal/knowledge";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { readKnowledge, validateQuickAnswers } from "@/lib/setup/knowledge";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * Wave 2's R2, "Flag this answer" (spec, "When the agent gets something
 * wrong"; plan Part F4, Annex X5's I4 and X6's L14): one click on a
 * conversation flags it behind the passkey step-up, with its access row; an
 * optional correction, typed by staff and screened as Knowledge screens a
 * quick answer, goes into the quick answers at once, tagged, and re-runs the
 * practice questions; the flag opens an ops ticket with ids and counts only,
 * and the second flag in seven days is the alert; the Flagged filter lists
 * the flagged conversations with whether each correction is live; and a flag
 * goes with whatever it points at.
 *
 * Driven through the real Better Auth and the real passkey ceremony, as
 * tests/conversations-screen.test.ts is; only the WebAuthn library's verdict
 * is stubbed. Synthetic clinics, people and words only.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    headers: new Headers(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: mocks.verifyAuthenticationResponse };
});

const { requirePatientPage } = await import("@/lib/portal/patient-page");
const { flagAnswer, parseCorrection } = await import("@/lib/portal/flag-answer");
const { readConversation, readConversationList } = await import("@/lib/portal/conversations");
const actions = await import("@/app/c/[slug]/conversations/actions");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";
const ACTOR = { type: "service", serviceName: "flag-answer-test" } as const;
const OPS = "ops@healdesk.test";
const DAY = 24 * 60 * 60 * 1000;
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

// -----------------------------------------------------------------------------
// Signing in and stepping up, as tests/conversations-screen.test.ts does
// -----------------------------------------------------------------------------

type Signed = { cookie: string; token: string; binding: SessionBinding };

async function signIn(userId: string): Promise<Signed> {
  const started = await auth.api.startLinkSession({
    body: { userId },
    headers: new Headers(),
    asResponse: true,
  });
  const cookie = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("hd.session_token="))!
    .split(";")[0]!;
  const token = decodeURIComponent(cookie.slice("hd.session_token=".length)).split(".")[0]!;
  return { cookie, token, binding: { userId, sessionTokenHash: hashSessionToken(token) } };
}

function browse(who: Signed | null, path: string): void {
  mocks.headers = new Headers({
    ...(who ? { cookie: who.cookie } : {}),
    "x-healdesk-path": path,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "x-forwarded-for": "203.0.113.7",
  });
}

async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; redirect: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false, redirect: error.url };
    throw error;
  }
}

async function addPasskey(userId: string, label: string) {
  const credentialId = b64(randomBytes(16));
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, label, credentialId],
  );
  return { factorId: rows[0]!.id, credentialId };
}

async function stepUp(session: SessionBinding, credentialId: string) {
  const started = await startPasskeyAuthentication({ session });
  if (!started.ok) throw new Error(started.reason);
  mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter: 0,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  });
  const finished = await finishPasskeyAuthentication({
    session,
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64(
          JSON.stringify({
            type: "webauthn.get",
            challenge: started.options.challenge,
            origin: ORIGIN,
          }),
        ),
        authenticatorData: b64(randomBytes(37)),
        signature: b64(randomBytes(64)),
      },
      clientExtensionResults: {},
    },
  });
  if (!finished.ok) throw new Error(finished.reason);
  return finished.stepUp;
}

type Desk = { clinic: SeededClinic; link: Signed; factorId: string; stepUpId: string };

/** A clinic with its agent's words, its sign-in in a browser, and a passkey step-up from "Front desk Mac". */
async function steppedUp(label: string, quickAnswers: unknown[] = []): Promise<Desk> {
  const clinic = await seedClinic(label);
  await inTenant(clinic.clinicId, (c) =>
    c.query(
      `insert into agent_configs (clinic_id, greeting, quick_answers, approved_at)
       values ($1, 'Hello', $2::jsonb, now())`,
      [clinic.clinicId, JSON.stringify(quickAnswers)],
    ),
  );
  const { factorId, credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
  const link = await signIn(clinic.staffUserId);
  const granted = await stepUp(link.binding, credentialId);
  browse(link, `/c/${clinic.slug}/conversations`);
  return { clinic, link, factorId, stepUpId: granted.id };
}

async function pageOf(desk: Desk) {
  return requirePatientPage(desk.clinic.slug);
}

type AuditRow = {
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_ids: string[] | null;
  metadata: Record<string, unknown> | null;
};

async function auditRows(clinicId: string): Promise<AuditRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<AuditRow>(
      `select actor_label, action, resource_type, resource_id, resource_ids, metadata
         from audit_log where clinic_id = $1 order by occurred_at, id`,
      [clinicId],
    );
    return rows;
  });
}

async function accessRows(desk: Desk): Promise<AuditRow[]> {
  return (await auditRows(desk.clinic.clinicId)).filter(
    (r) => r.metadata?.passkeyId === desk.factorId && r.metadata?.stepUpId === desk.stepUpId,
  );
}

async function seedCall(
  clinicId: string,
  options: { startedAt?: Date; phone?: string; name?: string } = {},
): Promise<{ conversationId: string; contactId: string | null }> {
  return inTenant(clinicId, async (client) => {
    let contactId: string | null = null;
    if (options.phone || options.name) {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone, full_name) values ($1, $2, $3) returning id`,
        [clinicId, options.phone ?? null, options.name ?? null],
      );
      contactId = rows[0]!.id;
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into conversations (clinic_id, contact_id, channel, outcome, started_at, ended_at)
       values ($1, $2, 'voice', 'qualified_no_booking', $3, $3::timestamptz + interval '3 minutes') returning id`,
      [clinicId, contactId, options.startedAt ?? new Date(Date.now() - 60 * 60 * 1000)],
    );
    return { conversationId: rows[0]!.id, contactId };
  });
}

type FlagRow = {
  id: string;
  source: string;
  conversation_id: string | null;
  thread_conversation_id: string | null;
  thread_party_ref: string | null;
  channel: string;
  outcome: string | null;
  flagged_at: Date;
  corrected_at: Date | null;
};

async function flagRows(clinicId: string): Promise<FlagRow[]> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<FlagRow>(
      `select id, source, conversation_id, thread_conversation_id, thread_party_ref, channel, outcome,
              flagged_at, corrected_at
         from conversation_flags where clinic_id = $1 order by flagged_at`,
      [clinicId],
    );
    return rows;
  });
}

async function quickAnswers(clinicId: string) {
  return withTenant(
    { clinicId, actor: ACTOR },
    async (tx) => (await readKnowledge(tx.db, tx.clinicId)).quickAnswers,
  );
}

async function ticketRows(flagId?: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    dedupe_key: string;
    fields: Record<string, unknown>;
    sent_at: Date | null;
    last_error: string | null;
  }>(
    `select id, dedupe_key, fields, sent_at, last_error from ops_alerts
      where event = 'flag_alert' ${flagId ? "and dedupe_key = $1" : ""} order by raised_at`,
    flagId ? [`flag=${flagId}`] : [],
  );
  return rows;
}

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `resend-${randomUUID()}` };
  }
}

/** What an email says, as text, to look for what must not be in it. */
function everything(email: OutgoingEmail): string {
  return `${email.subject}\n${email.text}\n${email.html}`;
}

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("I4, the flag's ticket, as an email", () => {
  const ctx = {
    clinicName: null,
    audience: "patients" as const,
    reason: OPS_REASON,
    raisedAt: new Date("2026-10-06T14:32:00Z"),
    timeZone: "UTC",
  };

  test("is templated now, and no longer pending", () => {
    expect(templateFor("flag_alert")).toBeDefined();
    expect(Object.keys(PENDING_TEMPLATES)).not.toContain("flag_alert");
  });

  test("the first flag in seven days is a ticket; the second is the alert, and says so", () => {
    const first = renderFlagAlert({ ...FLAG_ALERT_FIXTURE, flagsCount: 1 }, ctx);
    expect(first.subject).toBe("healdesk ops: a clinic flagged an answer");
    expect(first.text).not.toContain("alert, not a statistic");
    const second = renderFlagAlert(FLAG_ALERT_FIXTURE, ctx);
    expect(second.subject).toBe("healdesk ops: 2 flags in 7 days from one clinic");
    expect(second.text).toContain("Two in a week is an alert, not a statistic.");
    for (const rendered of [first, second]) {
      expect(subjectProblems(rendered.subject)).toEqual([]);
      expect(copyProblems(rendered.text)).toEqual([]);
      for (const id of [
        FLAG_ALERT_FIXTURE.flagId,
        FLAG_ALERT_FIXTURE.clinicId,
        FLAG_ALERT_FIXTURE.conversationId,
      ]) {
        expect(rendered.text).toContain(id);
      }
      // It links nowhere: the console is on the marketing site's origin.
      expect(rendered.text).not.toMatch(/https?:\/\//);
    }
  });

  test("its payload carries ids, counts and categories, and nothing a name or words could go in", () => {
    expect(() => assertPayloadAllowed(FLAG_ALERT_FIXTURE, "flag_alert")).not.toThrow();
    for (const extra of [
      { callerName: "Synthetic Caller" },
      { correction: "We open at nine." },
      { question: "Do you open on Saturdays?" },
    ]) {
      expect(() =>
        assertPayloadAllowed({ ...FLAG_ALERT_FIXTURE, ...extra } as FlagAlertPayload, "flag_alert"),
      ).toThrow(/is not on the allowlist/);
    }
  });
});

describe("L14 points at Flag this answer", () => {
  const ctx = {
    clinicName: "Radiance Med Spa",
    audience: "patients" as const,
    reason: "You're receiving this because this is Radiance Med Spa's address on healdesk.",
    raisedAt: new Date("2026-10-12T14:32:00Z"),
    timeZone: "America/New_York",
  };
  const LINE = "Something look wrong? Open the conversation and use Flag this answer.";

  test("the weekly recap carries the line in a week AYA handled anything, and not in an empty one", () => {
    const fixture = WEEKLY_RECAP_ENTRY.fixture;
    expect(WEEKLY_RECAP_ENTRY.render(fixture, ctx).text).toContain(LINE);
    const empty = {
      ...fixture,
      weekClaims: { ...fixture.weekClaims, handledCount: 0 },
    };
    expect(WEEKLY_RECAP_ENTRY.render(empty, ctx).text).not.toContain(LINE);
  });

  test("so does the week's first daily summary, which carries the recap", () => {
    const recap = WEEKLY_RECAP_ENTRY.fixture;
    const summary = {
      ...DAILY_SUMMARY_ENTRY.fixture,
      weekClaims: recap.weekClaims,
      weekStartOn: recap.weekStartOn,
      weekEndOn: recap.weekEndOn,
    };
    expect(DAILY_SUMMARY_ENTRY.render(summary, ctx).text).toContain(LINE);
    // Any other day's summary has no week, and no line.
    expect(DAILY_SUMMARY_ENTRY.render(DAILY_SUMMARY_ENTRY.fixture, ctx).text).not.toContain(LINE);
  });
});

describe("the correction and its tag", () => {
  test("both boxes empty is a flag without a correction; anything typed is screened as a quick answer", () => {
    expect(parseCorrection({})).toEqual({ kind: "none" });
    expect(parseCorrection({ question: "  ", answer: "" })).toEqual({ kind: "none" });
    expect(parseCorrection({ question: "Do you open on Saturdays?", answer: "" })).toMatchObject({
      status: "refused",
      field: "answer",
    });
    expect(
      parseCorrection({
        question: "When do you open on Saturdays?",
        answer: "It is safe while you are pregnant. We open at nine on Saturdays.",
      }),
    ).toEqual({
      status: "refused",
      field: "answer",
      message: expect.stringContaining("a safety claim"),
      rewrite: "We open at nine on Saturdays.",
    });
  });

  test("every writer of the quick answers keeps a flag's tag, and drops anything that is not one", () => {
    const flagId = randomUUID();
    expect(
      validateQuickAnswers([
        { question: "Saturdays?", answer: "Nine to one.", flagId },
        { question: "Parking?", answer: "Behind the building.", flagId: "not-an-id" },
        { question: "Cards?", answer: "All major cards." },
      ]),
    ).toEqual([
      { question: "Saturdays?", answer: "Nine to one.", flagId },
      { question: "Parking?", answer: "Behind the building." },
      { question: "Cards?", answer: "All major cards." },
    ]);
  });
});

// -----------------------------------------------------------------------------
// The database
// -----------------------------------------------------------------------------

describeDb("Flag this answer", () => {
  const saved = process.env.HEALDESK_OPS_EMAIL;
  let transport: FakeTransport;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    // The ops log is no clinic's, so truncateAll leaves it.
    await getMigratorPool().query(`truncate ops_alerts`);
    mocks.verifyAuthenticationResponse.mockReset();
    mocks.headers = new Headers();
    process.env.HEALDESK_OPS_EMAIL = OPS;
    transport = new FakeTransport();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.HEALDESK_OPS_EMAIL;
    else process.env.HEALDESK_OPS_EMAIL = saved;
  });

  afterAll(async () => {
    await closePools();
  });

  const flag = async (desk: Desk, conversationId: string, input = {}) =>
    flagAnswer(await pageOf(desk), conversationId, input, { email: { transport } });

  test("the table is forced, behind the BAA gate, and the runtime role may change only the correction's stamp", async () => {
    const { rows } = await getMigratorPool().query<Record<string, boolean>>(
      `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
              has_table_privilege('healdesk_app', 'conversation_flags', 'SELECT') as can_select,
              has_table_privilege('healdesk_app', 'conversation_flags', 'INSERT') as can_insert,
              has_table_privilege('healdesk_app', 'conversation_flags', 'DELETE') as can_delete,
              has_column_privilege('healdesk_app', 'conversation_flags', 'corrected_at', 'UPDATE') as corrected,
              has_column_privilege('healdesk_app', 'conversation_flags', 'flagged_at', 'UPDATE') as flagged,
              has_column_privilege('healdesk_app', 'conversation_flags', 'conversation_id', 'UPDATE') as target,
              has_column_privilege('healdesk_app', 'conversation_flags', 'channel', 'UPDATE') as channel
         from pg_class c where c.relname = 'conversation_flags'`,
    );
    expect(rows[0]).toEqual({
      enabled: true,
      forced: true,
      can_select: true,
      can_insert: true,
      can_delete: true,
      corrected: true,
      flagged: false,
      target: false,
      channel: false,
    });

    // A production clinic with no agreement in effect takes no flag.
    const clinic = await seedClinic("flag-gate");
    const { conversationId } = await seedCall(clinic.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now() - interval '1 year' where id = $1`,
      [clinic.clinicId],
    );
    await expect(
      inTenant(clinic.clinicId, (q) =>
        q.query(
          `insert into conversation_flags (clinic_id, source, conversation_id, channel, conversation_started_at)
           values ($1, 'call_or_chat', $2, 'voice', now())`,
          [clinic.clinicId, conversationId],
        ),
      ),
    ).rejects.toThrow(/refusing to write PHI to conversation_flags/);
  });

  test("when a conversation was flagged and corrected are the database's clock, and a correction is recorded once", async () => {
    const clinic = await seedClinic("flag-clock");
    const { conversationId } = await seedCall(clinic.clinicId);
    const [row] = await inTenant(
      clinic.clinicId,
      async (q) =>
        (
          await q.query<{ id: string; flagged_at: Date; corrected_at: Date | null }>(
            `insert into conversation_flags (clinic_id, source, conversation_id, channel, conversation_started_at, flagged_at)
           values ($1, 'call_or_chat', $2, 'voice', now(), now() - interval '30 days')
           returning id, flagged_at, corrected_at`,
            [clinic.clinicId, conversationId],
          )
        ).rows,
    );
    expect(Date.now() - row!.flagged_at.getTime()).toBeLessThan(60_000);
    const corrected = await inTenant(
      clinic.clinicId,
      async (q) =>
        (
          await q.query<{ corrected_at: Date }>(
            `update conversation_flags set corrected_at = now() - interval '30 days' where id = $1 returning corrected_at`,
            [row!.id],
          )
        ).rows[0]!,
    );
    expect(Date.now() - corrected.corrected_at.getTime()).toBeLessThan(60_000);
    for (const change of [
      `update conversation_flags set corrected_at = null where id = $1`,
      `update conversation_flags set corrected_at = now() + interval '1 day' where id = $1`,
      `update conversation_flags set flagged_at = now() - interval '9 days' where id = $1`,
    ]) {
      await expect(inTenant(clinic.clinicId, (q) => q.query(change, [row!.id]))).rejects.toThrow(
        /conversation_flags: /,
      );
    }
  });

  test("without a passkey step-up, flagging goes to the step-up page and writes nothing", async () => {
    const clinic = await seedClinic("flag-no-step");
    const { conversationId } = await seedCall(clinic.clinicId);
    const link = await signIn(clinic.staffUserId);
    await addPasskey(clinic.staffUserId, "Front desk Mac");
    const one = `/c/${clinic.slug}/conversations/${conversationId}`;
    browse(link, one);
    expect(await outcome(() => actions.flagAnswerAction(clinic.slug, conversationId, {}))).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(one)}`,
    });
    expect(
      await outcome(() => actions.findConversationsAction(clinic.slug, { flagged: true })),
    ).toMatchObject({ ok: false });
    expect(await flagRows(clinic.clinicId)).toEqual([]);
    expect(await ticketRows()).toEqual([]);
  });

  test("one click flags a call, with its access row naming the passkey, and opens one ticket with ids and counts only", async () => {
    const desk = await steppedUp("flag-one");
    const { conversationId } = await seedCall(desk.clinic.clinicId, {
      phone: "+14155550134",
      name: "Synthetic Caller",
    });

    // Through the library with a fake transport, so the email can be read;
    // the action's own words are checked on the second click below.
    const result = await flag(desk, conversationId);
    expect(result).toMatchObject({
      status: "flagged",
      corrected: false,
      flagsCount: 1,
      toast:
        "Flagged. healdesk has been told. If you know the right answer, add it below and AYA uses it.",
    });
    const [row] = await flagRows(desk.clinic.clinicId);
    expect(row).toMatchObject({
      source: "call_or_chat",
      conversation_id: conversationId,
      thread_conversation_id: null,
      channel: "voice",
      outcome: "answered",
      corrected_at: null,
    });

    // The access row: the conversation the flag was made from, by the passkey.
    expect(await accessRows(desk)).toEqual([
      expect.objectContaining({
        actor_label: "Front desk Mac",
        action: "read",
        resource_type: "conversation",
        resource_id: conversationId,
      }),
    ]);
    expect(
      (await auditRows(desk.clinic.clinicId)).filter(
        (r) => r.resource_type === "conversation_flag",
      ),
    ).toEqual([
      expect.objectContaining({
        action: "create",
        resource_id: row!.id,
        actor_label: "Front desk Mac",
      }),
    ]);

    // The ticket: the ops log's row and the email, to ops, ids and counts only.
    const tickets = await ticketRows(row!.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.fields).toEqual({
      clinicId: desk.clinic.clinicId,
      flagId: row!.id,
      conversationId,
      flagsCount: 1,
    });
    expect(tickets[0]!.sent_at).not.toBeNull();
    expect(transport.sent).toHaveLength(1);
    const [email] = transport.sent;
    expect(email!.target.to).toBe(OPS);
    expect(email!.message.subject).toBe("healdesk ops: a clinic flagged an answer");
    const all = everything(email!.message);
    for (const id of [row!.id, desk.clinic.clinicId, conversationId]) expect(all).toContain(id);
    expect(all).toContain("Phone");
    expect(all).not.toContain("Synthetic Caller");
    expect(all).not.toMatch(/555.?0134/);

    // A second click is the same flag: no second row, no second ticket.
    expect(await actions.flagAnswerAction(desk.clinic.slug, conversationId, {})).toEqual({
      ok: true,
      message: "This conversation is already flagged, and healdesk has been told.",
    });
    expect(await flagRows(desk.clinic.clinicId)).toHaveLength(1);
    expect(await ticketRows()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    // A ticket asked for again opens nothing more.
    expect(
      await sendFlagAlert(
        {
          flagId: row!.id,
          clinicId: desk.clinic.clinicId,
          conversationId,
          channel: "voice",
          outcome: "answered",
          hasCorrection: false,
          flagsCount: 1,
          flaggedAt: row!.flagged_at.toISOString(),
        },
        { transport },
      ),
    ).toEqual({ status: "already_raised", alertId: null });
    expect(transport.sent).toHaveLength(1);
  });

  test("two clicks at once are one flag and one ticket", async () => {
    const desk = await steppedUp("flag-race");
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    const results = await Promise.all([flag(desk, conversationId), flag(desk, conversationId)]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_flagged", "flagged"]);
    expect(await flagRows(desk.clinic.clinicId)).toHaveLength(1);
    expect(await ticketRows()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  test("another clinic's conversation is not found, and nothing is flagged", async () => {
    const desk = await steppedUp("flag-mine");
    const other = await seedClinic("flag-theirs");
    const { conversationId } = await seedCall(other.clinicId);
    expect(await flag(desk, conversationId)).toEqual({ status: "not_found" });
    expect(await flagRows(other.clinicId)).toEqual([]);
    expect(await ticketRows()).toEqual([]);
    // The attempt is in the access log, by the id asked about.
    expect((await accessRows(desk)).map((r) => r.resource_id)).toEqual([conversationId]);
  });

  test("a refused correction names what was refused, offers a rewrite, and flags nothing", async () => {
    const desk = await steppedUp("flag-refused", [{ question: "Parking?", answer: "Behind." }]);
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    expect(
      await actions.flagAnswerAction(desk.clinic.slug, conversationId, {
        question: "When do you open on Saturdays?",
        answer: "It is safe while you are pregnant. We open at nine on Saturdays.",
      }),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("a safety claim"),
      field: "answer",
      rewrite: "We open at nine on Saturdays.",
    });
    expect(await flagRows(desk.clinic.clinicId)).toEqual([]);
    expect(await ticketRows()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await quickAnswers(desk.clinic.clinicId)).toEqual([
      { question: "Parking?", answer: "Behind." },
    ]);
  });

  test("a correction goes into the quick answers at once, tagged, in place of one to the same question, and re-runs the practice questions", async () => {
    const desk = await steppedUp("flag-correct", [
      { question: "Do you open on Saturdays?", answer: "No." },
      { question: "Where do I park?", answer: "Behind the building." },
    ]);
    const { conversationId } = await seedCall(desk.clinic.clinicId);

    const result = await flag(desk, conversationId, {
      question: "do you open on   saturdays?",
      answer: "Yes, nine to one on Saturdays.",
    });
    expect(result).toMatchObject({ status: "flagged", corrected: true, flagsCount: 1 });
    const [row] = await flagRows(desk.clinic.clinicId);
    expect(row!.corrected_at).not.toBeNull();
    expect(await quickAnswers(desk.clinic.clinicId)).toEqual([
      {
        question: "do you open on saturdays?",
        answer: "Yes, nine to one on Saturdays.",
        flagId: row!.id,
      },
      { question: "Where do I park?", answer: "Behind the building." },
    ]);
    const runs = await inTenant(
      desk.clinic.clinicId,
      async (q) =>
        (
          await q.query<{ status: string; reason: string; trigger_section: string }>(
            `select status, reason, trigger_section from practice_question_runs where clinic_id = $1`,
            [desk.clinic.clinicId],
          )
        ).rows,
    );
    expect(runs).toEqual([
      { status: "queued", reason: "knowledge", trigger_section: "quick_answers" },
    ]);
    expect(transport.sent[0]!.message.text).toContain("Correction: Yes");
    // Before go-live an edit clears the approval, as the wizard's do: saved, waiting for it.
    const [shown] = await readConversationList(await pageOf(desk), { flagged: true });
    expect(shown!.flag).toMatchObject({ id: row!.id, correction: "waiting" });
  });

  test("a flagged conversation takes its correction later, once", async () => {
    const desk = await steppedUp("flag-later");
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    expect(await flag(desk, conversationId)).toMatchObject({ status: "flagged", corrected: false });
    const later = await flag(desk, conversationId, {
      question: "Do you take walk-ins?",
      answer: "Yes, before noon.",
    });
    expect(later).toMatchObject({ status: "corrected" });
    const [row] = await flagRows(desk.clinic.clinicId);
    expect(row!.corrected_at).not.toBeNull();
    expect(await quickAnswers(desk.clinic.clinicId)).toEqual([
      { question: "Do you take walk-ins?", answer: "Yes, before noon.", flagId: row!.id },
    ]);
    expect(
      await flag(desk, conversationId, { question: "Do you take walk-ins?", answer: "No." }),
    ).toEqual({ status: "already_corrected", flagId: row!.id });
    // One ticket, at the flag.
    expect(transport.sent).toHaveLength(1);
  });

  test("the Flagged filter lists only flagged conversations, with whether each correction is live, through Knowledge's own saves", async () => {
    const desk = await steppedUp("flag-filter");
    const flagged = await seedCall(desk.clinic.clinicId, { name: "Synthetic One" });
    const plain = await seedCall(desk.clinic.clinicId, { name: "Synthetic Two" });
    await flag(desk, flagged.conversationId, {
      question: "Do you open on Sundays?",
      answer: "No, Monday to Saturday.",
    });
    const [row] = await flagRows(desk.clinic.clinicId);
    // The approval given again, as the practice questions give it.
    await inTenant(desk.clinic.clinicId, (q) =>
      q.query(`update agent_configs set approved_at = now() where clinic_id = $1`, [
        desk.clinic.clinicId,
      ]),
    );

    const all = await readConversationList(await pageOf(desk), {});
    expect(all.map((r) => [r.id, r.flag?.correction ?? null])).toEqual(
      expect.arrayContaining([
        [flagged.conversationId, "live"],
        [plain.conversationId, null],
      ]),
    );
    const found = await actions.findConversationsAction(desk.clinic.slug, { flagged: true });
    expect(found).toMatchObject({ ok: true });
    const rows = found.ok ? found.rows : [];
    expect(rows.map((r) => r.id)).toEqual([flagged.conversationId]);
    expect(rows[0]).toMatchObject({ openable: true, flag: { id: row!.id, correction: "live" } });
    // The list's access row names exactly what it showed.
    const lists = (await accessRows(desk)).filter((r) => r.resource_ids !== null);
    expect(lists.at(-1)!.resource_ids).toEqual([flagged.conversationId]);
    // The open view says the same.
    const detail = await readConversation(await pageOf(desk), flagged.conversationId);
    expect(detail!.flag).toMatchObject({ id: row!.id, correction: "live" });

    // Knowledge saves the list as the form sends it back, tag and all: still live.
    const ctx = {
      clinicId: desk.clinic.clinicId,
      userId: desk.clinic.staffUserId,
      actorLabel: "Front desk Mac",
    };
    const current = await quickAnswers(desk.clinic.clinicId);
    expect(
      await saveKnowledge(ctx, "quick_answers", {
        quickAnswers: [...current, { question: "Cards?", answer: "All major cards." }],
      }),
    ).toMatchObject({ ok: true });
    await inTenant(desk.clinic.clinicId, (q) =>
      q.query(`update agent_configs set approved_at = now() where clinic_id = $1`, [
        desk.clinic.clinicId,
      ]),
    );
    const still = await readConversationList(await pageOf(desk), { flagged: true });
    expect(still[0]!.flag!.correction).toBe("live");

    // Removed in Knowledge: the Flagged view says so.
    await saveKnowledge(ctx, "quick_answers", {
      quickAnswers: [{ question: "Cards?", answer: "All major cards." }],
    });
    const removed = await readConversationList(await pageOf(desk), { flagged: true });
    expect(removed[0]!.flag!.correction).toBe("removed");
  });

  test("two flags from one clinic in seven days make the second ticket the alert; one older than that does not count", async () => {
    const desk = await steppedUp("flag-two");
    const first = await seedCall(desk.clinic.clinicId);
    const second = await seedCall(desk.clinic.clinicId);
    const third = await seedCall(desk.clinic.clinicId);
    expect(await flag(desk, first.conversationId)).toMatchObject({ flagsCount: 1 });
    expect(await flag(desk, second.conversationId)).toMatchObject({ flagsCount: 2 });
    expect(transport.sent.map((e) => e.message.subject)).toEqual([
      "healdesk ops: a clinic flagged an answer",
      "healdesk ops: 2 flags in 7 days from one clinic",
    ]);

    // Both earlier flags moved past the window, as the owner, around the
    // clock trigger, in one transaction.
    const client = await getMigratorPool().connect();
    try {
      await client.query("begin");
      await client.query(`alter table conversation_flags disable trigger conversation_flags_clock`);
      await client.query(`select set_config('app.clinic_id', $1, true)`, [desk.clinic.clinicId]);
      await client.query(
        `update conversation_flags set flagged_at = flagged_at - interval '8 days' where clinic_id = $1`,
        [desk.clinic.clinicId],
      );
      await client.query(`alter table conversation_flags enable trigger conversation_flags_clock`);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await flag(desk, third.conversationId)).toMatchObject({ flagsCount: 1 });
    expect(transport.sent.at(-1)!.message.subject).toBe("healdesk ops: a clinic flagged an answer");
  });

  test("a Meta conversation is flagged by its thread, stays in the Flagged view once the thread moves on, and goes when the thread does", async () => {
    const desk = await steppedUp("flag-meta");
    const t0 = new Date(Date.now() - 3 * DAY);
    const started = await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      touchChatThread(tx, { channel: "instagram", partyId: "ig-synthetic-1", sentAt: t0 }),
    );
    expect(await flag(desk, started.conversationId)).toMatchObject({ status: "flagged" });
    const [row] = await flagRows(desk.clinic.clinicId);
    expect(row).toMatchObject({
      source: "meta_thread",
      conversation_id: null,
      thread_conversation_id: started.conversationId,
      channel: "instagram",
      outcome: null,
    });
    expect(row!.thread_party_ref).toEqual(expect.any(String));
    expect(transport.sent[0]!.message.text).toContain("Instagram, Messenger or WhatsApp");

    // A message a day later starts the thread's next conversation.
    const next = await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      touchChatThread(tx, {
        channel: "instagram",
        partyId: "ig-synthetic-1",
        sentAt: new Date(t0.getTime() + 2 * DAY),
      }),
    );
    expect(next.startsNew).toBe(true);
    const flaggedView = await readConversationList(await pageOf(desk), { flagged: true });
    expect(flaggedView).toEqual([
      expect.objectContaining({
        id: started.conversationId,
        channel: "instagram",
        openable: false,
        callerName: null,
        flag: expect.objectContaining({ id: row!.id, correction: "none" }),
      }),
    ]);
    const everyone = await readConversationList(await pageOf(desk), {});
    expect(everyone).toEqual([
      expect.objectContaining({ id: next.conversationId, openable: true, flag: null }),
    ]);

    // The thread goes (a quiet thread's purge, an erasure, destruction): its flag with it.
    await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      tx.db.delete(chatThreads).where(sql`${chatThreads.clinicId} = ${desk.clinic.clinicId}`),
    );
    expect(await flagRows(desk.clinic.clinicId)).toEqual([]);
  });

  test("a flag goes with its conversation: an erasure of the person, and the record clock's delete", async () => {
    const desk = await steppedUp("flag-erase");
    const erased = await seedCall(desk.clinic.clinicId, {
      phone: "+14155550177",
      name: "Synthetic Erased",
    });
    const purged = await seedCall(desk.clinic.clinicId);
    await flag(desk, erased.conversationId);
    await flag(desk, purged.conversationId);
    expect(await flagRows(desk.clinic.clinicId)).toHaveLength(2);

    await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      tx.db.execute(sql`select * from app_erase_contacts(array[${erased.contactId!}]::uuid[])`),
    );
    expect((await flagRows(desk.clinic.clinicId)).map((r) => r.conversation_id)).toEqual([
      purged.conversationId,
    ]);
    // The purge deletes a conversation as the runtime role (lib/retention/purge.ts).
    await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      tx.db.execute(sql`delete from conversations where id = ${purged.conversationId}`),
    );
    expect(await flagRows(desk.clinic.clinicId)).toEqual([]);
  });

  test("destruction deletes the clinic's flags, counted, before the database records it", async () => {
    const desk = await steppedUp("flag-destroy");
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    await flag(desk, conversationId);
    const clinicId = desk.clinic.clinicId;
    await withTenant({ clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = offboarding_started_at - interval '31 days',
              destroy_after = destroy_after - interval '31 days'
        where id = $1`,
      [clinicId],
    );
    await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );
    const result = await withTenant({ clinicId, actor: ACTOR }, (tx) => destroyClinicData(tx));
    expect(result.deleted.conversation_flags).toBe(1);
    expect(await flagRows(clinicId)).toEqual([]);
  });

  test("a closed account flags nothing", async () => {
    const desk = await steppedUp("flag-closed");
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    await withTenant({ clinicId: desk.clinic.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    expect(await actions.flagAnswerAction(desk.clinic.slug, conversationId, {})).toEqual({
      ok: false,
      message: "This account has closed, so nothing can be flagged.",
    });
    expect(await flagRows(desk.clinic.clinicId)).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  test("a ticket whose email cannot go keeps its row with the error, and the digest counts I4 under its own kind", async () => {
    const desk = await steppedUp("flag-no-ops");
    const { conversationId } = await seedCall(desk.clinic.clinicId);
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    expect(await flag(desk, conversationId)).toMatchObject({ status: "flagged" });
    const [ticket] = await ticketRows();
    expect(ticket).toMatchObject({ sent_at: null, last_error: "HEALDESK_OPS_EMAIL is not set." });
    expect(transport.sent).toEqual([]);

    process.env.HEALDESK_OPS_EMAIL = OPS;
    const second = await seedCall(desk.clinic.clinicId);
    await flag(desk, second.conversationId);
    const digest = await collectDigest(new Date());
    const rows = digest.emailRows.filter((r) => r.kind === "flag_alert" || r.kind === "ops_alert");
    expect(rows).toEqual([
      expect.objectContaining({ kind: "flag_alert", sentCount: 1, failedCount: 1 }),
    ]);
    expect(digest.queueRows.find((q) => q.kind === "ops_alerts_unsent")).toMatchObject({
      count: 1,
    });
  });
});
