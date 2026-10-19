import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import {
  deliverTranscriptEmail,
  queueTranscriptEmail,
  recordSesTranscriptEvent,
} from "@/lib/conversations/transcript-outbox";
import { touchChatThread } from "@/lib/chat/threads";
import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import { clinicReason } from "@/lib/email/templates/context";
import {
  SETTING_CHANGED_ENTRY,
  type SettingChangedPayload,
} from "@/lib/email/templates/setting_changed";
import {
  finishPasskeyAuthentication,
  startPasskeyAuthentication,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { startOffboarding } from "@/lib/offboarding/offboarding";
import { exportDigest } from "@/lib/portal/export-receipt";
import { receiptSentence } from "@/lib/portal/conversation-words";
import {
  dayRange,
  deletionAfterDelivery,
  outcomeOf,
  parseSearch,
} from "@/lib/portal/conversations";
import { OPENS_AFTER_GO_LIVE, portalNav } from "@/lib/portal/nav";
import { openPatientScreens } from "@/lib/portal/page";
import { publicUrl } from "@/lib/public-url";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * Package G, the Conversations screen (plan Part F4; spec, "Portal map":
 * "Every call, chat and DM, searchable, with the outcome and whether it
 * produced a booking ... Second factor required to open one. Export
 * available."). Every view and action runs behind requirePatientPage and
 * writes its access row naming the device's passkey; another clinic's
 * records are "not found"; "Send again" holds only until delivery is
 * confirmed; an export is logged and emails O4, and after cancellation the
 * complete one is recorded as delivered; Meta threads are listed with what
 * is stored; the search finds phone digits and names, never words.
 *
 * Driven through the real Better Auth and the real passkey ceremony, as
 * tests/patient-page.test.ts is; only the WebAuthn library's verdict is
 * stubbed. Synthetic clinics, people and words only.
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
const { readConversation, readConversationList, sendTranscriptAgain } =
  await import("@/lib/portal/conversations");
const actions = await import("@/app/c/[slug]/conversations/actions");
const { default: ConversationsPage } = await import("@/app/c/[slug]/conversations/page");
const { default: ConversationPage } = await import("@/app/c/[slug]/conversations/[id]/page");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";
const ACTOR = { type: "service", serviceName: "conversations-test" } as const;
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const HOUR = 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Signing in and stepping up, as tests/patient-page.test.ts does
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

/** A clinic, its sign-in in a browser, and a passkey step-up on that session from "Front desk Mac". */
async function steppedUp(label: string): Promise<Desk> {
  const clinic = await seedClinic(label);
  const { factorId, credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
  const link = await signIn(clinic.staffUserId);
  const granted = await stepUp(link.binding, credentialId);
  browse(link, `/c/${clinic.slug}/conversations`);
  return { clinic, link, factorId, stepUpId: granted.id };
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

/** The access rows: the ones that name the passkey. */
async function accessRows(desk: Desk): Promise<AuditRow[]> {
  return (await auditRows(desk.clinic.clinicId)).filter(
    (r) => r.metadata?.passkeyId === desk.factorId && r.metadata?.stepUpId === desk.stepUpId,
  );
}

// -----------------------------------------------------------------------------
// Records
// -----------------------------------------------------------------------------

async function seedCall(
  clinicId: string,
  options: {
    startedAt: Date;
    phone?: string | null;
    name?: string | null;
    outcome?: string;
    urgent?: boolean;
    channel?: string;
  },
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
      `insert into conversations (clinic_id, contact_id, channel, outcome, urgent, started_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '3 minutes') returning id`,
      [
        clinicId,
        contactId,
        options.channel ?? "voice",
        options.outcome ?? "qualified_no_booking",
        options.urgent ?? false,
        options.startedAt,
      ],
    );
    return { conversationId: rows[0]!.id, contactId };
  });
}

async function seedRequest(
  clinicId: string,
  contactId: string,
  conversationId: string,
): Promise<string> {
  const created = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    createBookingRequest(tx, {
      channel: "voice",
      contactId,
      conversationId,
      preferredWindow: "Thursday afternoon",
      treatment: null,
    }),
  );
  return created.id;
}

async function seedAppointment(clinicId: string, contactId: string, conversationId: string) {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into appointments (clinic_id, contact_id, conversation_id, scheduled_for) values ($1, $2, $3, now() + interval '2 days')`,
      [clinicId, contactId, conversationId],
    ),
  );
}

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${crypto.randomUUID()}` };
  }
}

/** A call's transcript, queued and sent once: `sent`, waiting on SES. */
async function sentTranscript(clinicId: string, conversationId: string) {
  const id = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    queueTranscriptEmail(tx, {
      conversationId,
      channel: "voice",
      startedAt: new Date(),
      turns: [
        {
          speaker: "assistant",
          text: "Hi, I'm the clinic's AI assistant, and this call is transcribed.",
        },
        { speaker: "person", text: "Synthetic caller: I'd like a consultation." },
      ],
    }),
  );
  expect(await deliverTranscriptEmail(clinicId, id!, { transport: new FakeTransport() })).toBe(
    "sent",
  );
  return { id: id!, messageId: await messageIdOf(clinicId, id!) };
}

async function transcriptRow(clinicId: string, id: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ status: string; ses_message_id: string | null; sealed: unknown }>(
      `select status, ses_message_id, sealed from transcript_emails where id = $1`,
      [id],
    ),
  );
  return rows[0]!;
}

async function messageIdOf(clinicId: string, id: string): Promise<string> {
  return (await transcriptRow(clinicId, id)).ses_message_id!;
}

async function exportNotices(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ dedupe_key: string; payload: SettingChangedPayload }>(
      `select dedupe_key, payload from billing_notices
        where kind = 'setting_changed' and dedupe_key like 'setting_changed:export:%' order by created_at`,
    );
    return rows;
  });
}

/** A Meta thread on Instagram for one sender, its conversation started at `startedAt`. */
async function seedThread(clinicId: string, senderId: string, startedAt: Date) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) =>
    touchChatThread(tx, { channel: "instagram", partyId: senderId, sentAt: startedAt }),
  );
}

async function seedMetaRequest(
  clinicId: string,
  senderId: string,
  phone: string,
  firstName: string,
) {
  const created = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    createBookingRequest(tx, {
      channel: "meta",
      thread: { platform: "instagram", externalId: "ig-page-1", senderId },
      connectionId: null,
      fields: { firstName, phone, preferredWindow: "Weekday mornings", alternativeWindows: [] },
    }),
  );
  return created.id;
}

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("the outcome, from the rows", () => {
  const facts = { outcome: "qualified_no_booking", urgent: false, requestId: null, booked: false };
  test("urgent before a handover, a handover before what came of it, then booked, request, answered", () => {
    expect(
      outcomeOf({ ...facts, outcome: "escalated_to_human", urgent: true, requestId: "r" }),
    ).toBe("urgent");
    expect(outcomeOf({ ...facts, outcome: "escalated_to_human", requestId: "r" })).toBe("handover");
    expect(outcomeOf({ ...facts, outcome: "booked", requestId: "r", booked: true })).toBe("booked");
    expect(outcomeOf({ ...facts, outcome: "booked", requestId: "r" })).toBe("request");
    // An outcome label with no request or appointment behind it is not a booking.
    expect(outcomeOf({ ...facts, outcome: "booked" })).toBe("answered");
    expect(outcomeOf({ ...facts, outcome: "abandoned" })).toBe("answered");
    expect(outcomeOf({ ...facts, outcome: null })).toBe("answered");
  });
});

describe("the search box", () => {
  test("a number as people write one is digits; anything else part of a name; too little is refused", () => {
    expect(parseSearch("415 555-0134")).toEqual({ kind: "digits", digits: "4155550134" });
    expect(parseSearch(" +1 (415) 555 0134 ")).toEqual({ kind: "digits", digits: "14155550134" });
    expect(parseSearch("0134")).toEqual({ kind: "digits", digits: "0134" });
    expect(parseSearch("41")).toEqual({ kind: "too_short" });
    expect(parseSearch("Maria  Lopez")).toEqual({ kind: "name", text: "Maria Lopez" });
    expect(parseSearch("J")).toEqual({ kind: "too_short" });
    expect(parseSearch("%%")).toEqual({ kind: "too_short" });
    expect(parseSearch("")).toEqual({ kind: "none" });
    expect(parseSearch(undefined)).toEqual({ kind: "none" });
    expect(parseSearch({ q: "Maria" })).toEqual({ kind: "none" });
  });

  test("the chips are the clinic's own days, and this week starts on Monday", () => {
    // Wednesday 14 October 2026, noon in New York.
    const now = new Date("2026-10-14T16:00:00Z");
    const zone = "America/New_York";
    expect(dayRange("today", now, zone)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
    expect(dayRange("yesterday", now, zone)).toEqual({ from: "2026-10-13", to: "2026-10-13" });
    expect(dayRange("week", now, zone)).toEqual({ from: "2026-10-12", to: "2026-10-14" });
    // 02:00 UTC on the 14th is still the 13th in New York.
    expect(dayRange("today", new Date("2026-10-14T02:00:00Z"), zone)).toEqual({
      from: "2026-10-13",
      to: "2026-10-13",
    });
    // On a Monday, this week is today; on a Sunday, the six days before too.
    expect(dayRange("week", new Date("2026-10-12T16:00:00Z"), zone).from).toBe("2026-10-12");
    expect(dayRange("week", new Date("2026-10-18T16:00:00Z"), zone).from).toBe("2026-10-12");
    // Across a month.
    expect(dayRange("yesterday", new Date("2026-11-01T16:00:00Z"), zone).from).toBe("2026-10-31");
  });
});

describe("the receipt, in words", () => {
  const when = (iso: string) => `[${iso}]`;
  const base = { sentAt: "2026-10-14T15:00:00.000Z", deliveredAt: null, attempts: 1 };
  test("each status says where the transcript stands, and never a word of it", () => {
    expect(receiptSentence(null, when)).toMatch(/No transcript was emailed/);
    expect(receiptSentence({ ...base, status: "open", sentAt: null, attempts: 0 }, when)).toMatch(
      /still going/,
    );
    expect(
      receiptSentence({ ...base, status: "pending", sentAt: null, attempts: 0 }, when),
    ).toMatch(/Waiting to be sent/);
    expect(
      receiptSentence({ ...base, status: "pending", sentAt: null, attempts: 3 }, when),
    ).toMatch(/after 3 tries/);
    expect(receiptSentence({ ...base, status: "sent" }, when)).toBe(
      "Sent at [2026-10-14T15:00:00.000Z]. Waiting for your mail server to confirm it arrived.",
    );
    expect(receiptSentence({ ...base, status: "bounced" }, when)).toMatch(/turned it away/);
    expect(
      receiptSentence(
        { ...base, status: "delivered", deliveredAt: "2026-10-14T15:01:00.000Z" },
        when,
      ),
    ).toBe(
      "Delivered at [2026-10-14T15:01:00.000Z]. healdesk then deleted its copy, so it can't be sent again.",
    );
    expect(receiptSentence({ ...base, status: "expired" }, when)).toMatch(/30 days/);
    expect(receiptSentence({ ...base, status: "unconfirmed" }, when)).toMatch(/72 hours/);
  });
});

describe("the menu", () => {
  test("Conversations links once the clinic opened it, and says when it opens before", () => {
    const closed = portalNav("glow", "home").find((i) => i.section === "conversations")!;
    expect(closed).toMatchObject({ href: null, note: OPENS_AFTER_GO_LIVE });
    const open = portalNav("glow", "conversations", ["conversations"]).find(
      (i) => i.section === "conversations",
    )!;
    expect(open).toEqual({
      section: "conversations",
      label: "Conversations",
      href: "/c/glow/conversations",
      current: true,
    });
    // Bookings links only once the clinic has opened it too (package E).
    expect(
      portalNav("glow", "home", ["conversations"]).find((i) => i.section === "bookings"),
    ).toMatchObject({ href: null });
    expect(
      portalNav("glow", "home", ["conversations", "bookings"]).find(
        (i) => i.section === "bookings",
      ),
    ).toMatchObject({ href: "/c/glow/bookings" });
  });
});

describe("the O4 email for an export", () => {
  // The snapshot carries the link, so the origin is pinned, as
  // tests/email-templates.test.ts pins it.
  const saved = { origin: process.env.BETTER_AUTH_URL, app: process.env.HEALDESK_APP_URL };
  beforeEach(() => {
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    delete process.env.HEALDESK_APP_URL;
  });
  afterEach(() => {
    if (saved.origin === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = saved.origin;
    if (saved.app !== undefined) process.env.HEALDESK_APP_URL = saved.app;
  });
  const ctx = {
    clinicName: "Radiance Med Spa",
    audience: "patients" as const,
    reason: clinicReason("Radiance Med Spa"),
    raisedAt: new Date("2026-10-14T15:00:00Z"),
    timeZone: "America/New_York",
  };
  const payload = (field: "clinic_export" | "person_export"): SettingChangedPayload => ({
    ...SETTING_CHANGED_ENTRY.fixture,
    field,
    beforeMasked: null,
    afterMasked: null,
    settingsUrl: publicUrl("/c/radiance-med-spa/settings#sign-in"),
  });

  for (const field of ["clinic_export", "person_export"] as const) {
    test(`${field}: what, when and which device; never whose, and every lint passes`, () => {
      expect(() => assertPayloadAllowed(payload(field), "setting_changed")).not.toThrow();
      for (const audience of ["patients", "clients"] as const) {
        const r = SETTING_CHANGED_ENTRY.render(payload(field), { ...ctx, audience });
        expect(subjectProblems(r.subject)).toEqual([]);
        expect(
          copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n")),
        ).toEqual([]);
        expect(linkProblems(r, "setting_changed")).toEqual([]);
        expect(r.text).toContain("“Front desk Mac”");
        expect(r.text).toContain("downloaded from Conversations");
        expect(r.text).not.toMatch(/Before|Now:/);
        expect(r.subject).toBe(
          field === "clinic_export"
            ? "Your records were exported"
            : `A ${audience === "clients" ? "client" : "patient"}'s records were exported`,
        );
      }
      expect(SETTING_CHANGED_ENTRY.render(payload(field), ctx)).toMatchSnapshot();
    });
  }
});

describe("what a download after cancellation sets in motion", () => {
  const ended = new Date("2026-10-01T00:00:00Z");
  const plan = {
    rule: "export_or_ninety" as const,
    basis: "agreement" as const,
    agreementVersion: "1.5.0",
    endedAt: ended,
    exportDueBy: new Date("2026-10-30T00:00:00Z"),
    destroyDueAt: new Date("2026-12-29T00:00:00Z"),
    latestDestroyAt: new Date("2026-12-29T00:00:00Z"),
    exportByOn: "2026-10-29",
    destroyByOn: "2026-12-30",
  };
  test("by day 29 the thirty days stand; later, the records go at the download; never past ninety", () => {
    expect(deletionAfterDelivery(plan, null, new Date("2026-10-14T00:00:00Z"))).toEqual(
      plan.exportDueBy,
    );
    const late = new Date("2026-11-10T00:00:00Z");
    expect(deletionAfterDelivery(plan, null, late)).toEqual(late);
    expect(deletionAfterDelivery(plan, null, new Date("2027-01-10T00:00:00Z"))).toEqual(
      plan.latestDestroyAt,
    );
    // Already delivered: the plan's own date, which a second download doesn't move.
    expect(deletionAfterDelivery({ ...plan, destroyDueAt: plan.exportDueBy }, ended, late)).toEqual(
      plan.exportDueBy,
    );
    expect(
      deletionAfterDelivery(
        { ...plan, rule: "thirty_days", destroyDueAt: plan.exportDueBy },
        null,
        late,
      ),
    ).toEqual(plan.exportDueBy);
  });
});

// -----------------------------------------------------------------------------
// The database
// -----------------------------------------------------------------------------

describeDb("Conversations", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.verifyAuthenticationResponse.mockReset();
    mocks.headers = new Headers();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the runtime role may write the urgent flag, and still not a conversation's start", async () => {
    const { rows } = await getMigratorPool().query(
      `select has_column_privilege('healdesk_app', 'conversations', 'urgent', 'UPDATE') as urgent,
              has_column_privilege('healdesk_app', 'conversations', 'started_at', 'UPDATE') as started`,
    );
    expect(rows[0]).toEqual({ urgent: true, started: false });
  });

  test("without a passkey step-up, every view and action goes to the step-up page and logs nothing", async () => {
    const clinic = await seedClinic("conv-no-step");
    const { conversationId } = await seedCall(clinic.clinicId, {
      startedAt: new Date(),
      phone: "+14155550134",
      name: "Synthetic Caller",
    });
    const link = await signIn(clinic.staffUserId);
    await addPasskey(clinic.staffUserId, "Front desk Mac");
    const list = `/c/${clinic.slug}/conversations`;
    const one = `${list}/${conversationId}`;
    const toStepUp = (path: string) => `/c/${clinic.slug}/step-up?next=${encodeURIComponent(path)}`;

    browse(link, list);
    for (const run of [
      (): Promise<unknown> => ConversationsPage({ params: Promise.resolve({ slug: clinic.slug }) }),
      () => actions.findConversationsAction(clinic.slug, { q: "4155" }),
      () => actions.exportAllAction(clinic.slug),
    ]) {
      expect(await outcome(run)).toEqual({ ok: false, redirect: toStepUp(list) });
    }
    browse(link, one);
    for (const run of [
      (): Promise<unknown> =>
        ConversationPage({ params: Promise.resolve({ slug: clinic.slug, id: conversationId }) }),
      () => actions.sendAgainAction(clinic.slug, conversationId),
      () => actions.exportPersonAction(clinic.slug, conversationId, "practice"),
    ]) {
      // A page comes back to the list it is part of; an action to the page it was posted from.
      expect((await outcome(run)).ok).toBe(false);
    }
    expect(
      await outcome(() =>
        ConversationPage({ params: Promise.resolve({ slug: clinic.slug, id: conversationId }) }),
      ),
    ).toEqual({ ok: false, redirect: toStepUp(list) });
    expect(await outcome(() => actions.sendAgainAction(clinic.slug, conversationId))).toEqual({
      ok: false,
      redirect: toStepUp(one),
    });

    // Signed out: to sign in.
    browse(null, list);
    expect(await outcome(() => actions.findConversationsAction(clinic.slug, {}))).toEqual({
      ok: false,
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });
    expect(await auditRows(clinic.clinicId)).toEqual([]);
    expect(await exportNotices(clinic.clinicId)).toEqual([]);
  });

  test("the list: every channel's rows with their outcome and booking, one access row naming what it showed", async () => {
    const desk = await steppedUp("conv-list");
    const c = desk.clinic.clinicId;
    const now = Date.now();
    const answered = await seedCall(c, {
      startedAt: new Date(now - 5 * HOUR),
      phone: "+14155550101",
      name: "Ana",
    });
    const urgent = await seedCall(c, {
      startedAt: new Date(now - 4 * HOUR),
      outcome: "escalated_to_human",
      urgent: true,
    });
    const handover = await seedCall(c, {
      startedAt: new Date(now - 3 * HOUR),
      outcome: "escalated_to_human",
      channel: "web_chat",
    });
    const requested = await seedCall(c, {
      startedAt: new Date(now - 2 * HOUR),
      phone: "+14155550102",
      name: "Bea",
      outcome: "booked",
    });
    const requestId = await seedRequest(c, requested.contactId!, requested.conversationId);
    const booked = await seedCall(c, {
      startedAt: new Date(now - HOUR),
      phone: "+14155550103",
      name: "Cy",
      outcome: "booked",
    });
    await seedAppointment(c, booked.contactId!, booked.conversationId);
    // A web chat with no contact of its own, named through the request it took.
    const chat = await seedCall(c, {
      startedAt: new Date(now - 30 * 60 * 1000),
      channel: "web_chat",
    });
    const chatContact = (
      await seedCall(c, {
        startedAt: new Date(now - 100 * HOUR),
        phone: "+14155550104",
        name: "Dee",
      })
    ).contactId!;
    const chatRequest = await seedRequest(c, chatContact, chat.conversationId);

    const found = await actions.findConversationsAction(desk.clinic.slug, {});
    if (!found.ok) throw new Error(found.message);
    const byId = new Map(found.rows.map((r) => [r.id, r]));
    expect(found.rows[0]!.id).toBe(chat.conversationId);
    expect(byId.get(answered.conversationId)).toMatchObject({
      channel: "voice",
      outcome: "answered",
      callerName: "Ana",
      callerPhone: "+14155550101",
      bookingRequestId: null,
    });
    expect(byId.get(urgent.conversationId)).toMatchObject({ outcome: "urgent" });
    expect(byId.get(handover.conversationId)).toMatchObject({
      outcome: "handover",
      channel: "web_chat",
    });
    expect(byId.get(requested.conversationId)).toMatchObject({
      outcome: "request",
      bookingRequestId: requestId,
    });
    expect(byId.get(booked.conversationId)).toMatchObject({ outcome: "booked" });
    expect(byId.get(chat.conversationId)).toMatchObject({
      outcome: "request",
      callerName: "Dee",
      callerPhone: "+14155550104",
      bookingRequestId: chatRequest,
    });

    // One row for the list as shown, and one for the requests it links to.
    const access = await accessRows(desk);
    expect(access).toHaveLength(2);
    expect(access).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_label: "Front desk Mac",
          action: "read",
          resource_type: "conversation",
          resource_id: null,
          resource_ids: found.rows.map((r) => r.id),
        }),
        expect.objectContaining({
          action: "read",
          resource_type: "booking_request",
          resource_ids: expect.arrayContaining([requestId, chatRequest]),
        }),
      ]),
    );

    // The page itself reads the same way, behind the same step-up, with its own rows.
    await ConversationsPage({ params: Promise.resolve({ slug: desk.clinic.slug }) });
    const lists = (await accessRows(desk)).filter((r) => r.resource_type === "conversation");
    expect(lists).toHaveLength(2);
    expect(lists[1]!.resource_ids).toEqual(found.rows.map((r) => r.id));
  });

  test("search by phone digits however they're typed, by part of a name, and by the day chips", async () => {
    const desk = await steppedUp("conv-search");
    const c = desk.clinic.clinicId;
    const maria = await seedCall(c, {
      startedAt: new Date(),
      phone: "+14155550134",
      name: "Maria Lopez",
    });
    const joe = await seedCall(c, { startedAt: new Date(), phone: "+12125550188", name: "Joey" });
    await seedCall(c, { startedAt: new Date(), name: "Nobody Numbered" });

    const ids = async (q: string) => {
      const found = await actions.findConversationsAction(desk.clinic.slug, { q });
      if (!found.ok) throw new Error(found.message);
      return found.rows.map((r) => r.id);
    };
    expect(await ids("415 555")).toEqual([maria.conversationId]);
    expect(await ids("(212) 555-0188")).toEqual([joe.conversationId]);
    expect(await ids("+1 212 555 0188")).toEqual([joe.conversationId]);
    expect(await ids("0188")).toEqual([joe.conversationId]);
    expect(await ids("555")).toHaveLength(2);
    expect(await ids("maria")).toEqual([maria.conversationId]);
    expect(await ids("LOPEZ")).toEqual([maria.conversationId]);
    // A wildcard typed is a character, not "anything".
    expect(await ids("Jo_y")).toEqual([]);
    expect(await ids("Joey")).toEqual([joe.conversationId]);
    // Words from a conversation find nothing: none are kept.
    expect(await ids("consultation")).toEqual([]);
    expect(await actions.findConversationsAction(desk.clinic.slug, { q: "41" })).toEqual({
      ok: false,
      message: "Type at least 3 digits of a number, or 2 letters of a name.",
    });

    // The chips, in the clinic's zone (New York): Wednesday 14 October at noon.
    const now = new Date("2026-10-14T16:00:00Z");
    const day = await steppedUp("conv-days");
    const d = day.clinic.clinicId;
    const today = await seedCall(d, { startedAt: new Date("2026-10-14T13:00:00Z") });
    const lateYesterday = await seedCall(d, { startedAt: new Date("2026-10-14T03:30:00Z") });
    const monday = await seedCall(d, { startedAt: new Date("2026-10-12T15:00:00Z") });
    const lastWeek = await seedCall(d, { startedAt: new Date("2026-10-11T15:00:00Z") });
    const page = await requirePatientPage(day.clinic.slug);
    const chip = async (chosen: "today" | "yesterday" | "week" | null) =>
      (await readConversationList(page, { day: chosen }, { now })).map((r) => r.id);
    expect(await chip("today")).toEqual([today.conversationId]);
    expect(await chip("yesterday")).toEqual([lateYesterday.conversationId]);
    expect(await chip("week")).toEqual([
      today.conversationId,
      lateYesterday.conversationId,
      monday.conversationId,
    ]);
    expect(await chip(null)).toHaveLength(4);
    expect(await chip(null)).toContain(lastWeek.conversationId);
    // Each list view is its own access row.
    expect((await accessRows(day)).filter((r) => r.resource_type === "conversation")).toHaveLength(
      5,
    );
  });

  test("Meta threads are listed with only what's stored, named through the request their conversation produced", async () => {
    const desk = await steppedUp("conv-meta");
    const c = desk.clinic.clinicId;
    const now = Date.now();
    // One person who asked to book in this conversation.
    const asked = await seedThread(c, "ig-sender-asked", new Date(now - 2 * HOUR));
    const requestId = await seedMetaRequest(c, "ig-sender-asked", "+14155550177", "Maria");
    // One who only asked a question.
    const quiet = await seedThread(c, "ig-sender-quiet", new Date(now - HOUR));
    // One whose request was in an earlier conversation: this one produced none.
    await seedMetaRequest(c, "ig-sender-again", "+14155550166", "Rae");
    const again = await seedThread(c, "ig-sender-again", new Date(now));
    await inTenant(c, (client) =>
      client.query(
        `update chat_threads set conversation_started_at = now() + interval '3 hours', last_inbound_at = now() + interval '3 hours'
          where conversation_id = $1`,
        [again.conversationId],
      ),
    );
    const call = await seedCall(c, { startedAt: new Date(now - 30 * 60 * 1000) });

    const found = await actions.findConversationsAction(desk.clinic.slug, {});
    if (!found.ok) throw new Error(found.message);
    expect(found.rows.map((r) => r.id)).toEqual([
      again.conversationId,
      call.conversationId,
      quiet.conversationId,
      asked.conversationId,
    ]);
    const byId = new Map(found.rows.map((r) => [r.id, r]));
    expect(byId.get(asked.conversationId)).toEqual({
      id: asked.conversationId,
      source: "meta_thread",
      channel: "instagram",
      at: new Date(now - 2 * HOUR).toISOString(),
      outcome: "request",
      callerName: "Maria",
      callerPhone: "+14155550177",
      bookingRequestId: requestId,
      amended: false,
      // Not flagged, and it opens (Flag this answer, wave 2 R2).
      flag: null,
      openable: true,
    });
    expect(byId.get(quiet.conversationId)).toMatchObject({
      source: "meta_thread",
      outcome: null,
      callerName: null,
      callerPhone: null,
      bookingRequestId: null,
    });
    expect(byId.get(again.conversationId)).toMatchObject({ outcome: null, bookingRequestId: null });

    // Found by the number the request carries.
    const search = await actions.findConversationsAction(desk.clinic.slug, { q: "0177" });
    expect(search.ok && search.rows.map((r) => r.id)).toEqual([asked.conversationId]);

    // Opened: what's stored, and no transcript or "Send again".
    const page = await requirePatientPage(desk.clinic.slug);
    const detail = await readConversation(page, asked.conversationId);
    expect(detail).toMatchObject({
      source: "meta_thread",
      channel: "instagram",
      outcome: "request",
      conversationsCount: 1,
      receipt: null,
      canSendAgain: false,
      request: { id: requestId, status: "requested" },
    });
    expect(await sendTranscriptAgain(page, asked.conversationId)).toEqual({ status: "not_found" });
  });

  test("an open view: the record, its request and its amendments, the receipt, and one access row each", async () => {
    const desk = await steppedUp("conv-open");
    const c = desk.clinic.clinicId;
    const call = await seedCall(c, {
      startedAt: new Date(),
      phone: "+14155550134",
      name: "Maria",
      outcome: "booked",
    });
    const requestId = await seedRequest(c, call.contactId!, call.conversationId);
    const transcript = await sentTranscript(c, call.conversationId);
    await inTenant(c, (client) =>
      client.query(
        `insert into record_amendments (clinic_id, target_kind, conversation_id, amendment, requested_by, requested_at, recorded_by)
         values ($1, 'conversation', $2, 'The caller asked for a consultation, not a treatment.', 'practice', now(), 'test')`,
        [c, call.conversationId],
      ),
    );

    browse(desk.link, `/c/${desk.clinic.slug}/conversations/${call.conversationId}`);
    const page = await requirePatientPage(desk.clinic.slug);
    const detail = await readConversation(page, call.conversationId);
    expect(detail).toMatchObject({
      id: call.conversationId,
      source: "call_or_chat",
      channel: "voice",
      outcome: "request",
      callerName: "Maria",
      callerPhone: "+14155550134",
      contactId: call.contactId,
      request: { id: requestId, status: "requested" },
      receipt: { id: transcript.id, status: "sent", attempts: 1, deliveredAt: null },
      canSendAgain: true,
      amendments: [
        expect.objectContaining({
          amendment: "The caller asked for a consultation, not a treatment.",
          on: "conversation",
          requestedBy: "practice",
        }),
      ],
    });
    // No words: the receipt carries none, and nothing else does either.
    expect(JSON.stringify(detail)).not.toContain("Synthetic caller");

    // One transaction's rows share its moment, so their order is not theirs to keep.
    const opened = await accessRows(desk);
    expect(opened).toHaveLength(3);
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "read",
          resource_type: "conversation",
          resource_id: call.conversationId,
        }),
        expect.objectContaining({
          action: "read",
          resource_type: "transcript_email",
          resource_id: transcript.id,
        }),
        expect.objectContaining({
          action: "read",
          resource_type: "booking_request",
          resource_id: requestId,
        }),
      ]),
    );

    // The page reads it the same way.
    await ConversationPage({
      params: Promise.resolve({ slug: desk.clinic.slug, id: call.conversationId }),
    });
    expect(await accessRows(desk)).toHaveLength(6);
    // An id that is no conversation of anyone's: not found, and the attempt is logged by the id asked for.
    const nobody = crypto.randomUUID();
    await expect(
      ConversationPage({ params: Promise.resolve({ slug: desk.clinic.slug, id: nobody }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      ConversationPage({ params: Promise.resolve({ slug: desk.clinic.slug, id: "not-a-uuid" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    const attempts = (await accessRows(desk)).filter((r) => r.resource_id === nobody);
    expect(attempts).toEqual([expect.objectContaining({ resource_type: "conversation" })]);
    expect(await accessRows(desk)).toHaveLength(7);
  });

  test("another clinic's sign-in gets not found, and its conversations are not found from this one", async () => {
    const desk = await steppedUp("conv-mine");
    const theirs = await seedClinic("conv-theirs");
    const their = await seedCall(theirs.clinicId, {
      startedAt: new Date(),
      phone: "+14155550199",
      name: "Theirs",
    });
    const transcript = await sentTranscript(theirs.clinicId, their.conversationId);

    // Their screen, with this sign-in, stepped up: not found.
    browse(desk.link, `/c/${theirs.slug}/conversations`);
    await expect(
      ConversationsPage({ params: Promise.resolve({ slug: theirs.slug }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.findConversationsAction(theirs.slug, {})).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(actions.sendAgainAction(theirs.slug, their.conversationId)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(actions.exportAllAction(theirs.slug)).rejects.toThrow("NEXT_NOT_FOUND");

    // Their conversation by id, from this clinic's own screen.
    browse(desk.link, `/c/${desk.clinic.slug}/conversations`);
    const listed = await actions.findConversationsAction(desk.clinic.slug, { q: "0199" });
    expect(listed).toEqual({ ok: true, rows: [] });
    await expect(
      ConversationPage({
        params: Promise.resolve({ slug: desk.clinic.slug, id: their.conversationId }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await actions.sendAgainAction(desk.clinic.slug, their.conversationId)).toEqual({
      ok: false,
      message: "No transcript was emailed for this conversation.",
    });
    expect((await transcriptRow(theirs.clinicId, transcript.id)).status).toBe("sent");
    expect(
      await actions.exportPersonAction(desk.clinic.slug, their.conversationId, "practice"),
    ).toEqual({
      ok: false,
      message: "That conversation isn't here any more. Reload the page.",
    });
    // Nothing of this sign-in's is in their log.
    expect(
      (await auditRows(theirs.clinicId)).filter((r) => r.metadata?.passkeyId !== undefined),
    ).toEqual([]);
    expect(await exportNotices(desk.clinic.clinicId)).toEqual([]);
  });

  test("Send again: while the copy is held, logged with the passkey; never once delivery is confirmed", async () => {
    const desk = await steppedUp("conv-resend");
    const c = desk.clinic.clinicId;
    const call = await seedCall(c, { startedAt: new Date(), phone: "+14155550134" });
    const transcript = await sentTranscript(c, call.conversationId);
    const path = `/c/${desk.clinic.slug}/conversations/${call.conversationId}`;
    browse(desk.link, path);

    // Sent, awaiting SES: queued again, for the outbox's next minute to send.
    expect(await actions.sendAgainAction(desk.clinic.slug, call.conversationId)).toEqual({
      ok: true,
      message:
        "Sending again to your clinic's address. It goes within a minute or two, and this page shows when your mail server confirms it.",
    });
    expect((await transcriptRow(c, transcript.id)).status).toBe("pending");
    const rows = await auditRows(c);
    expect(rows.filter((r) => r.metadata?.passkeyId === desk.factorId)).toEqual([
      expect.objectContaining({
        action: "read",
        resource_type: "transcript_email",
        resource_id: transcript.id,
      }),
    ]);
    // The outbox's own row, by the device, in the same transaction.
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor_label: "Front desk Mac",
        action: "update",
        resource_type: "transcript_email",
        resource_id: transcript.id,
        metadata: { outcome: "resend" },
      }),
    );

    // The outbox sends it, to the clinic's address and no other.
    const page = await requirePatientPage(desk.clinic.slug);
    expect(await sendTranscriptAgain(page, call.conversationId)).toEqual({ status: "queued" });
    const transport = new FakeTransport();
    expect(await deliverTranscriptEmail(c, transcript.id, { transport })).toBe("sent");
    expect(transport.sent.map((m) => m.target.to)).toEqual([desk.clinic.staffEmail]);

    // Delivered: a receipt. "Send again" is gone from the page and refused by the action.
    expect(
      await recordSesTranscriptEvent({
        messageId: await messageIdOf(c, transcript.id),
        type: "delivery",
      }),
    ).toBe(true);
    expect(await readConversation(page, call.conversationId)).toMatchObject({
      receipt: { status: "delivered" },
      canSendAgain: false,
    });
    const before = (await auditRows(c)).filter((r) => r.action === "update").length;
    expect(await actions.sendAgainAction(desk.clinic.slug, call.conversationId)).toEqual({
      ok: false,
      message: "Your mail server confirmed this one, so healdesk no longer holds a copy to send.",
    });
    expect(await transcriptRow(c, transcript.id)).toMatchObject({
      status: "delivered",
      sealed: null,
    });
    expect((await auditRows(c)).filter((r) => r.action === "update").length).toBe(before);

    // Bounced: may be sent again. Open (a web chat still going): says so.
    const bounced = await seedCall(c, { startedAt: new Date() });
    const b = await sentTranscript(c, bounced.conversationId);
    await recordSesTranscriptEvent({
      messageId: b.messageId,
      type: "bounce",
      bounceType: "Permanent",
      reason: "550",
    });
    expect(await readConversation(page, bounced.conversationId)).toMatchObject({
      receipt: { status: "bounced" },
      canSendAgain: true,
    });
    expect((await actions.sendAgainAction(desk.clinic.slug, bounced.conversationId)).ok).toBe(true);
    // Nothing was queued for a call nobody spoke on.
    const silent = await seedCall(c, { startedAt: new Date() });
    expect(await readConversation(page, silent.conversationId)).toMatchObject({
      receipt: null,
      canSendAgain: false,
    });
    expect(await actions.sendAgainAction(desk.clinic.slug, silent.conversationId)).toEqual({
      ok: false,
      message: "No transcript was emailed for this conversation.",
    });
  });

  test("the whole clinic's export: the bundle, logged as an export with the passkey, and O4 to the clinic", async () => {
    const desk = await steppedUp("conv-export");
    const c = desk.clinic.clinicId;
    const call = await seedCall(c, { startedAt: new Date(), phone: "+14155550134", name: "Maria" });
    const result = await actions.exportAllAction(desk.clinic.slug);
    if (!result.ok) throw new Error(result.message);
    expect(result.filename).toMatch(
      new RegExp(`^healdesk-records-${desk.clinic.slug}-\\d{8}T\\d{6}Z\\.json$`),
    );
    const bundle = JSON.parse(result.body) as {
      conversations: { id: string }[];
      contacts: { fullName: string }[];
    };
    expect(bundle.conversations.map((v) => v.id)).toEqual([call.conversationId]);
    expect(bundle.contacts.map((v) => v.fullName)).toEqual(["Maria"]);

    const rows = await auditRows(c);
    expect(rows.filter((r) => r.metadata?.passkeyId === desk.factorId)).toEqual([
      expect.objectContaining({
        actor_label: "Front desk Mac",
        action: "export",
        resource_type: "clinic_bundle",
        resource_id: c,
      }),
    ]);
    // exportClinic's own row says why: the clinic's download, not the offboarding return.
    expect(rows).toContainEqual(
      expect.objectContaining({
        action: "export",
        resource_type: "clinic_bundle",
        metadata: expect.objectContaining({ purpose: "portal_download", requestedBy: "practice" }),
      }),
    );

    const notices = await exportNotices(c);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({
      field: "clinic_export",
      deviceName: "Front desk Mac",
      beforeMasked: null,
      afterMasked: null,
    });
    expect(notices[0]!.payload.settingsUrl).toMatch(
      new RegExp(`/c/${desk.clinic.slug}/settings#sign-in$`),
    );
    expect(() => assertPayloadAllowed(notices[0]!.payload, "setting_changed")).not.toThrow();
    expect(JSON.stringify(notices[0]!.payload)).not.toMatch(/Maria|0134/);

    // An open account: the export is not a delivery.
    const { rows: clinic } = await getMigratorPool().query(
      `select export_delivered_at from clinics where id = $1`,
      [c],
    );
    expect(clinic[0]!.export_delivered_at).toBeNull();
    // A second download is a second email.
    await actions.exportAllAction(desk.clinic.slug);
    expect(await exportNotices(c)).toHaveLength(2);
  });

  test("one person's export: their bundle, who asked, logged by their contact ids, and O4", async () => {
    const desk = await steppedUp("conv-person");
    const c = desk.clinic.clinicId;
    const call = await seedCall(c, { startedAt: new Date(), phone: "+14155550134", name: "Maria" });
    const second = await seedCall(c, {
      startedAt: new Date(),
      phone: "+14155550134",
      name: "Maria L",
    });
    await seedCall(c, { startedAt: new Date(), phone: "+12125550188", name: "Someone else" });
    const nobody = await seedCall(c, { startedAt: new Date() });

    expect(
      await actions.exportPersonAction(desk.clinic.slug, call.conversationId, "her mother"),
    ).toEqual({
      ok: false,
      message: "Choose who asked for the export.",
    });
    expect(
      await actions.exportPersonAction(desk.clinic.slug, nobody.conversationId, "practice"),
    ).toEqual({
      ok: false,
      message: "This conversation names no one in your records, so there is no one to export.",
    });

    const result = await actions.exportPersonAction(
      desk.clinic.slug,
      call.conversationId,
      "person_via_practice",
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.filename).toMatch(/^healdesk-person-records-\d{8}T\d{6}Z\.json$/);
    const bundle = JSON.parse(result.body) as {
      contacts: { id: string }[];
      conversations: { id: string }[];
    };
    expect(bundle.conversations.map((v) => v.id).sort()).toEqual(
      [call.conversationId, second.conversationId].sort(),
    );
    const contactIds = bundle.contacts.map((v) => v.id).sort();
    expect(contactIds).toEqual([call.contactId, second.contactId].sort());

    const access = (await auditRows(c)).filter(
      (r) => r.metadata?.passkeyId === desk.factorId && r.action === "export",
    );
    expect(access).toEqual([
      expect.objectContaining({
        resource_type: "patient_bundle",
        resource_ids: expect.arrayContaining(contactIds),
      }),
    ]);
    expect(await auditRows(c)).toContainEqual(
      expect.objectContaining({
        action: "export",
        resource_type: "patient_bundle",
        metadata: expect.objectContaining({ requestedBy: "person_via_practice", by: "contact_id" }),
      }),
    );
    const notices = await exportNotices(c);
    expect(notices.map((n) => n.payload.field)).toEqual(["person_export"]);

    // A contact with only a name is still exported: found by its id, not its details.
    const nameOnly = await seedCall(c, { startedAt: new Date(), name: "Only A Name" });
    const named = await actions.exportPersonAction(
      desk.clinic.slug,
      nameOnly.conversationId,
      "practice",
    );
    if (!named.ok) throw new Error(named.message);
    expect(
      (JSON.parse(named.body) as { contacts: { id: string }[] }).contacts.map((v) => v.id),
    ).toEqual([nameOnly.contactId]);
    expect(JSON.stringify(notices)).not.toMatch(/Maria|0134/);
  });

  test("after cancellation only a complete download of the whole export is recorded as delivered; producing it, or one person's, is not", async () => {
    const desk = await steppedUp("conv-closed");
    const c = desk.clinic.clinicId;
    const call = await seedCall(c, { startedAt: new Date(), phone: "+14155550134", name: "Maria" });
    await withTenant({ clinicId: c, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    const delivered = async () =>
      (await getMigratorPool().query(`select export_delivered_at from clinics where id = $1`, [c]))
        .rows[0]!.export_delivered_at as Date | null;

    // The page says what a download sets in motion before anyone presses it,
    // and E4's link lands on the export.
    const page = await ConversationsPage({ params: Promise.resolve({ slug: desk.clinic.slug }) });
    expect(JSON.stringify(page)).toMatch(
      /A download that arrives in full records your export as delivered/,
    );
    expect(JSON.stringify(page)).toMatch(/"id":"export"/);

    const person = await actions.exportPersonAction(
      desk.clinic.slug,
      call.conversationId,
      "practice",
    );
    expect(person).toMatchObject({ ok: true, receipt: null });
    expect(await delivered()).toBeNull();

    // Producing the file records nothing: it is handed over with a receipt.
    const result = await actions.exportAllAction(desk.clinic.slug);
    if (!result.ok || !result.receipt) throw new Error("expected a closed clinic's export with a receipt");
    expect(result.message).toBe("Export downloaded. Your clinic's address gets an email saying so.");
    expect(await delivered()).toBeNull();

    // A file that did not arrive whole (its digest differs), or a receipt
    // tampered with, records nothing.
    const truncated = exportDigest(result.body.slice(0, -10));
    expect(await actions.confirmExportAction(desk.clinic.slug, result.receipt, truncated)).toEqual({
      ok: false,
      message:
        "The export didn't arrive in full, so it isn't recorded as delivered. Download it again.",
    });
    const [head] = result.receipt.split(".");
    expect(
      (
        await actions.confirmExportAction(
          desk.clinic.slug,
          `${head}.${"A".repeat(43)}`,
          exportDigest(result.body),
        )
      ).ok,
    ).toBe(false);
    expect(await delivered()).toBeNull();

    // The whole file, as the browser received it: delivered, once.
    expect(
      await actions.confirmExportAction(desk.clinic.slug, result.receipt, exportDigest(result.body)),
    ).toEqual({
      ok: true,
      message:
        "Export downloaded in full, and recorded as delivered. Your clinic's address gets an email saying so.",
    });
    const stamped = await delivered();
    expect(stamped).toBeInstanceOf(Date);
    expect(await auditRows(c)).toContainEqual(
      expect.objectContaining({
        action: "export",
        resource_type: "clinic_offboarding",
        resource_id: c,
        metadata: expect.objectContaining({
          how: "downloaded in full by the clinic from Conversations in the portal",
        }),
      }),
    );
    // Once: a second download, confirmed, moves nothing.
    const again = await actions.exportAllAction(desk.clinic.slug);
    if (!again.ok || !again.receipt) throw new Error("expected a receipt");
    await actions.confirmExportAction(desk.clinic.slug, again.receipt, exportDigest(again.body));
    expect(await delivered()).toEqual(stamped);
    // A receipt is this clinic's alone.
    const other = await steppedUp("conv-closed-other");
    await withTenant({ clinicId: other.clinic.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    expect(
      (await actions.confirmExportAction(other.clinic.slug, again.receipt, exportDigest(again.body)))
        .ok,
    ).toBe(false);
    browse(desk.link, `/c/${desk.clinic.slug}/conversations`);

    // Destroyed: nothing left to export, and nothing stamped or emailed.
    await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [c]);
    const before = (await exportNotices(c)).length;
    expect(await actions.exportAllAction(desk.clinic.slug)).toEqual({
      ok: false,
      message: "Your records have been deleted, so there is nothing left to export.",
    });
    expect(await exportNotices(c)).toHaveLength(before);
    // Logged as the attempt it was, a read that found nothing, not as an export.
    const access = await accessRows(desk);
    expect(access.at(-1)).toMatchObject({
      action: "read",
      resource_type: "clinic_bundle",
      resource_id: c,
    });
    // Two downloads, and the confirmation of each that it arrived in full.
    expect(
      access.filter((r) => r.action === "export" && r.resource_type === "clinic_bundle"),
    ).toHaveLength(4);
  });

  test("the menu opens Conversations for a live channel, or once there is a conversation or a Meta thread; Bookings once there is a request", async () => {
    const actor = { type: "service", serviceName: "conversations-test" } as const;
    const none = await seedClinic("nav-none");
    expect(await openPatientScreens(none.clinicId, actor, { channels: [] })).toEqual([]);

    const called = await seedClinic("nav-call");
    await seedCall(called.clinicId, { startedAt: new Date() });
    expect(await openPatientScreens(called.clinicId, actor, { channels: [] })).toEqual([
      "conversations",
    ]);

    const messaged = await seedClinic("nav-meta");
    await seedThread(messaged.clinicId, "ig-sender-nav", new Date());
    expect(await openPatientScreens(messaged.clinicId, actor, { channels: [] })).toEqual([
      "conversations",
    ]);

    const live = await seedClinic("nav-live");
    await seedChannels(live.clinicId, [{ channel: "web", liveAt: new Date() }]);
    const channel = {
      channel: "web" as const,
      enabled: true,
      readyAt: null,
      waitingOn: null,
      liveAt: new Date(),
      firstAnswerAt: null,
      pausedUntil: null,
      status: "live" as const,
    };
    expect(await openPatientScreens(live.clinicId, actor, { channels: [channel] })).toEqual([
      "conversations",
      "bookings",
    ]);
    // Bookings opens on its own once there is a booking request to show.
    const requested = await seedClinic("nav-request");
    const contactId = await inTenant(requested.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, '+14155550133') returning id`,
        [requested.clinicId],
      );
      return rows[0]!.id;
    });
    await withTenant({ clinicId: requested.clinicId, actor }, (tx) =>
      createBookingRequest(tx, {
        channel: "voice",
        contactId,
        conversationId: null,
        preferredWindow: "Thursday afternoon",
        treatment: null,
      }),
    );
    expect(await openPatientScreens(requested.clinicId, actor, { channels: [] })).toEqual([
      "bookings",
    ]);
    // Another clinic's conversation opens nothing here.
    expect(await openPatientScreens(none.clinicId, actor, { channels: [] })).toEqual([]);
  });
});
