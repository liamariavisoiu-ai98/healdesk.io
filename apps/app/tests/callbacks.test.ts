import { CALLBACK_CONSENT, resolveBookingRequirements } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as callbackTool } from "@/app/api/voice/tools/[clinicId]/callback/route";
import { consentRecords, outboundCalls } from "@/db/schema";
import { callDeadline, callbackVariables, deferredUntil, dialDue, nextWindowOpen, quietHoursBasis, sweepOutboundCalls } from "@/lib/callbacks/dial";
import { scheduleCallback } from "@/lib/callbacks/schedule";
import { callbackDisclosure } from "@/lib/compliance/disclosure";
import { createBookingRequest, decideBookingRequest, resolveBookingRequest } from "@/lib/meta/booking-requests";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { ingestCall, VoiceIngestError, type VoiceCallEvent } from "@/lib/voice/ingest";
import { FixtureOutboundClient } from "@/lib/voice/outbound";
import { __resetVoiceToolLimitsForTests, __setVoiceToolRuntimeForTests } from "@/lib/voice/tools";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * Consented callbacks (design of 23 September 2026, §F): the ledger's
 * shape, the pre-dial gate in the order it refuses, the dial against the
 * fixture client, the two sweeps, the post-call match, and the callback
 * agent's tool. Every call here is placed to the fixture; nothing dials.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const TZ = "America/New_York";
const PHONE = "+14155550181";
const CLINIC_PHONE = "+14155550199";
const TOOLS_SECRET = "voice-tools-secret-for-tests";
const HOUR = 60 * 60 * 1000;

describe("what the callback agent is told, and when the window opens (pure)", () => {
  test("missing_fields is driven by the requirement set, as labels", () => {
    const requirements = resolveBookingRequirements("plastic-surgery", null);
    const base = {
      firstName: "Dana",
      purpose: "collect_fields" as const,
      clinicName: "Radiance",
      clinicPhoneSpoken: "four one five — five five five — oh one nine nine",
      preferredWindow: "Thursday afternoon",
      alternativeWindows: ["Friday morning", "Monday"],
      proposedSlots: [{ at: "2026-10-01T18:00:00.000Z", label: "Thu 1 Oct, 2:00 PM", source: "desk" as const }],
      confirmedFor: null,
      timeZone: TZ,
    };
    const missing = requirements.filter((f) => !f.locked);
    const vars = callbackVariables({ ...base, missingFields: missing });
    expect(vars).toEqual({
      first_name: "Dana",
      purpose: "collect_fields",
      clinic_name: "Radiance",
      clinic_phone_spoken: "four one five — five five five — oh one nine nine",
      primary_window: "Thursday afternoon",
      alternative_windows: "Friday morning and Monday",
      missing_fields: "Last name, Service asked about, Consultation or treatment visit",
      proposed_slots_spoken: "Thursday the 1st at 2 PM",
      confirmed_slot_spoken: "",
    });
    // Never an id, never digits for the practice's number.
    expect(JSON.stringify(vars)).not.toMatch(/last_name|consult_or_treatment|\d{3}/);
    expect(callbackVariables({ ...base, missingFields: [], confirmedFor: new Date("2026-10-02T14:30:00Z") })).toMatchObject({ missing_fields: "", confirmed_slot_spoken: "Friday the 2nd at 10:30 AM" });
    // Every value is a string: the vendor's custom_variables are strings.
    for (const v of Object.values(vars)) expect(typeof v).toBe("string");
  });

  test("the next opening is 08:00 in the recipient's clock, never on a Sunday, and null for a zone nobody knows", () => {
    // Monday 14 Sep 2026, 19:45 New York → Tuesday 08:00 New York (12:00Z).
    expect(nextWindowOpen(TZ, new Date("2026-09-14T23:45:00Z"))?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    // Monday 02:00 New York → the same Monday at 08:00.
    expect(nextWindowOpen(TZ, new Date("2026-09-14T06:00:00Z"))?.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    // Saturday 21:00 New York → Monday 08:00, skipping Sunday.
    expect(nextWindowOpen(TZ, new Date("2026-09-13T01:00:00Z"))?.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    // Sunday 11:00 New York → Monday 08:00.
    expect(nextWindowOpen(TZ, new Date("2026-09-13T15:00:00Z"))?.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    expect(nextWindowOpen("Europe/London", new Date("2026-09-14T23:45:00Z"))?.toISOString()).toBe("2026-09-15T07:00:00.000Z");
    expect(nextWindowOpen("Mars/Olympus", new Date("2026-09-14T23:45:00Z"))).toBeNull();
    expect(nextWindowOpen(null, new Date("2026-09-14T23:45:00Z"))).toBeNull();
    // The deferral rides on gate_basis (0040's grant keeps not_before as evidence of when the row was first due).
    expect(quietHoursBasis(new Date("2026-09-15T12:00:00Z"))).toBe("quiet hours until 2026-09-15T12:00:00.000Z");
    expect(deferredUntil("quiet hours until 2026-09-15T12:00:00.000Z")?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(deferredUntil("quiet hours")).toBeNull();
    expect(deferredUntil("clinic timezone unconfirmed")).toBeNull();
    expect(deferredUntil(null)).toBeNull();
    const created = new Date("2026-09-14T12:00:00Z");
    expect(callDeadline({ createdAt: created, expiresAt: new Date("2026-09-30T12:00:00Z") }).toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(callDeadline({ createdAt: created, expiresAt: new Date("2026-09-16T12:00:00Z") }).toISOString()).toBe("2026-09-16T12:00:00.000Z");
  });
});

describeDb("consented callbacks, end to end against the fixture", () => {
  const client = new FixtureOutboundClient();
  const mailed: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  const transport: EmailTransport = {
    name: "capture",
    async send(target, message) {
      mailed.push({ target, message });
      return { status: "sent", messageId: `m-${mailed.length}` };
    },
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "true";
    process.env.HEALDESK_SYNTHFLOW_API_KEY = "sf-key-for-tests";
    process.env.HEALDESK_SYNTHFLOW_API_BASE = "https://api.us.synthflow.ai";
    process.env.HEALDESK_VOICE_TOOLS_SECRET = TOOLS_SECRET;
    __setVoiceToolRuntimeForTests({ transport });
    __resetVoiceToolLimitsForTests();
  });

  /** Every clinic this file created: the dialer and the sweeps run across all clinics, so leftovers are settled between tests. */
  const created: string[] = [];

  afterEach(async () => {
    for (const clinicId of created) {
      await inTenant(clinicId, (client) => client.query(`update outbound_calls set status = 'cancelled', refusal_code = 'test_cleanup' where status in ('due', 'placing', 'placed')`));
    }
    client.reset();
    mailed.length = 0;
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
    delete process.env.HEALDESK_SYNTHFLOW_API_KEY;
    delete process.env.HEALDESK_SYNTHFLOW_API_BASE;
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    __setVoiceToolRuntimeForTests(undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  /** A clinic with every clinic-side gate open, one contact in its own zone, and the desk's address. */
  async function clinicForCallbacks(label: string, opts: { phone?: string; specialty?: string } = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set outbound_callbacks_enabled = true, timezone = $2, timezone_confirmed_at = now(), published_phone_e164 = $3,
              synthflow_callback_agent_id = 'agent_cb_1', synthflow_number_e164 = '+14155550100', specialty = $4 where id = $1`,
      [c.clinicId, TZ, CLINIC_PHONE, opts.specialty ?? "med-spa"],
    );
    await inTenant(c.clinicId, (client) => client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [c.clinicId, "desk@example-clinic.test"]));
    created.push(c.clinicId);
    const phone = opts.phone ?? PHONE;
    const contactId = await seedContact(c.clinicId, phone);
    await inTenant(c.clinicId, (client) => client.query(`update contacts set timezone = $2, full_name = 'Dana Okonkwo' where id = $1`, [contactId, TZ]));
    return { clinicId: c.clinicId, contactId, phone };
  }

  /** A voice request with a usable yes, and its consent row. */
  async function requestWithConsent(clinic: { clinicId: string; contactId: string }, over: { consent?: boolean; treatment?: string | null } = {}) {
    const { conversationId } = await seedConversation(clinic.clinicId, { startedAt: new Date(), contactId: clinic.contactId });
    return withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      createBookingRequest(tx, {
        channel: "voice",
        contactId: clinic.contactId,
        conversationId,
        preferredWindow: "Thursday afternoon",
        alternativeWindows: ["Friday morning"],
        treatment: over.treatment === undefined ? "Consultation" : over.treatment,
        callbackConsent: over.consent === false ? null : { granted: true, quote: "yes, that's fine", evidenceUri: "https://transcripts.example.test/c.txt" },
      }),
    );
  }

  /** Schedule attempt 1 and make it due now, whatever the clock. */
  async function dueRow(clinic: { clinicId: string; contactId: string }, purpose: "collect_fields" | "offer_alternatives" | "confirm_time" = "collect_fields", over: Parameters<typeof requestWithConsent>[1] = {}) {
    const created = await requestWithConsent(clinic, over);
    const scheduled = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => scheduleCallback(tx, created.id, purpose));
    if (!scheduled.scheduled) throw new Error(`not scheduled: ${scheduled.reason}`);
    await inTenant(clinic.clinicId, (client) => client.query(`update outbound_calls set not_before = '2020-01-01' where id = $1`, [scheduled.callId]));
    return { requestId: created.id, callId: scheduled.callId, consentRecordId: created.consentRecordId!, token: created.token };
  }

  const rowOf = (clinicId: string, id: string) =>
    inTenant(clinicId, async (client) => (await client.query<{ status: string; refusal_code: string | null; gate_basis: string | null; vendor_call_id: string | null; placed_at: Date | null; completed_at: Date | null; not_before: Date; attempt_no: number; conversation_id: string | null }>(
      `select status, refusal_code, gate_basis, vendor_call_id, placed_at, completed_at, not_before, attempt_no, conversation_id from outbound_calls where id = $1`,
      [id],
    )).rows[0]!);
  const attemptsFor = (clinicId: string, phone: string) => inTenant(clinicId, async (client) => (await client.query(`select 1 from contact_attempts where phone = $1`, [phone])).rows.length);

  /** A weekday noon in New York inside the request's seven days: any day ahead but a Sunday. */
  function weekdayNoon(daysAhead = 1): Date {
    for (let d = daysAhead; d < daysAhead + 7; d += 1) {
      const candidate = new Date(Date.now() + d * 24 * HOUR);
      candidate.setUTCHours(16, 0, 0, 0); // 12:00 EDT / 11:00 EST — inside 08:00–19:30 either way
      if (new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(candidate) !== "Sun") return candidate;
    }
    throw new Error("unreachable");
  }

  test("the ledger's shape: no row without a matching, unrevoked, inbound consent for this number; never a third attempt", async () => {
    const c = await clinicForCallbacks("cb-shape");
    const created = await requestWithConsent(c);
    const insert = (over: Record<string, unknown>) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        tx.db.insert(outboundCalls).values({
          clinicId: c.clinicId,
          contactId: c.contactId,
          bookingRequestId: created.id,
          consentRecordId: created.consentRecordId!,
          purpose: "collect_fields",
          phone: PHONE,
          attemptNo: 1,
          notBefore: new Date(),
          ...(over as object),
        } as never),
      );
    // No consent id at all: the consent-match trigger fires before the NOT
    // NULL check does, so it is the trigger that says no (42501); the NOT
    // NULL foreign key stands behind it.
    await expect(insert({ consentRecordId: null })).rejects.toMatchObject({ cause: { code: "42501" } });
    // Another number's consent, a revoked one, and one not captured inbound: the trigger.
    const other = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const [web] = await tx.db.insert(consentRecords).values({ clinicId: c.clinicId, phone: PHONE, channel: "voice", consentType: "express", source: "web_form", exactWording: "I agree", wordingVersion: CALLBACK_CONSENT.version }).returning({ id: consentRecords.id });
      const [otherNumber] = await tx.db.insert(consentRecords).values({ clinicId: c.clinicId, phone: "+14155550999", channel: "voice", consentType: "express", source: "inbound_call", exactWording: "yes", wordingVersion: CALLBACK_CONSENT.version }).returning({ id: consentRecords.id });
      const [revoked] = await tx.db.insert(consentRecords).values({ clinicId: c.clinicId, phone: PHONE, channel: "voice", consentType: "express", source: "inbound_call", exactWording: "yes", wordingVersion: CALLBACK_CONSENT.version, revokedAt: new Date() }).returning({ id: consentRecords.id });
      return { web: web!.id, otherNumber: otherNumber!.id, revoked: revoked!.id };
    });
    for (const id of [other.web, other.otherNumber, other.revoked]) {
      await expect(insert({ consentRecordId: id })).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    // The matching one is accepted; a third attempt is not a number the CHECK knows; a second attempt 2 is refused by the index.
    await insert({});
    await expect(insert({ attemptNo: 3 })).rejects.toMatchObject({ cause: { code: "23514" } });
    await insert({ attemptNo: 2 });
    await expect(insert({ attemptNo: 2 })).rejects.toMatchObject({ cause: { code: "23505" } });
    // The runtime role can neither delete a row nor rewrite its evidence columns.
    await expect(withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => tx.db.delete(outboundCalls))).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => tx.db.update(outboundCalls).set({ phone: "+14155550000" } as never))).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  test("the gate refuses in order, each refusal named, and every refusal leaves nothing dialled", async () => {
    const c = await clinicForCallbacks("cb-gates");
    const now = weekdayNoon();
    const refused = async (label: string, arrange: () => Promise<void>, restore: () => Promise<void>, expected: { refusal_code: string; gate_basis: string }) => {
      const { callId } = await dueRow(c);
      await arrange();
      try {
        const summary = await dialDue(now, { client });
        expect(summary, label).toMatchObject({ refused: 1, placed: 0, failed: 0 });
      } finally {
        await restore();
      }
      expect(await rowOf(c.clinicId, callId), label).toMatchObject({ status: "refused", ...expected, vendor_call_id: null });
      expect(client.calls, label).toHaveLength(0);
      expect(await attemptsFor(c.clinicId, PHONE), label).toBe(0);
    };
    const setClinic = (sql: string) => () => getMigratorPool().query(`update clinics set ${sql} where id = $1`, [c.clinicId]).then(() => undefined);

    await refused("env off", async () => { delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED; }, async () => { process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "true"; }, { refusal_code: "outbound_disabled", gate_basis: "environment switch off" });
    await refused("clinic off", setClinic("outbound_callbacks_enabled = false"), setClinic("outbound_callbacks_enabled = true"), { refusal_code: "outbound_disabled", gate_basis: "clinic switch off" });
    await refused("no vendor", async () => { delete process.env.HEALDESK_SYNTHFLOW_API_KEY; }, async () => { process.env.HEALDESK_SYNTHFLOW_API_KEY = "sf-key-for-tests"; }, { refusal_code: "outbound_disabled", gate_basis: "no vendor" });
    await refused("non-US base", async () => { process.env.HEALDESK_SYNTHFLOW_API_BASE = "https://api.synthflow.ai"; }, async () => { process.env.HEALDESK_SYNTHFLOW_API_BASE = "https://api.us.synthflow.ai"; }, { refusal_code: "vendor_base", gate_basis: "non-US vendor base" });
    await refused("base unset", async () => { delete process.env.HEALDESK_SYNTHFLOW_API_BASE; }, async () => { process.env.HEALDESK_SYNTHFLOW_API_BASE = "https://api.us.synthflow.ai"; }, { refusal_code: "vendor_base", gate_basis: "non-US vendor base" });
    await refused("no published phone", setClinic("published_phone_e164 = null"), setClinic(`published_phone_e164 = '${CLINIC_PHONE}'`), { refusal_code: "no_published_phone", gate_basis: "no published phone" });
    await refused("no callback agent", setClinic("synthflow_callback_agent_id = null"), setClinic("synthflow_callback_agent_id = 'agent_cb_1'"), { refusal_code: "no_agent", gate_basis: "no callback agent" });

    // An unconfirmed timezone: left due, nothing moved, nothing dialled.
    const unconfirmed = await dueRow(c);
    await getMigratorPool().query(`update clinics set timezone_confirmed_at = null where id = $1`, [c.clinicId]);
    expect(await dialDue(now, { client })).toMatchObject({ deferred: 1, placed: 0, refused: 0 });
    expect(await rowOf(c.clinicId, unconfirmed.callId)).toMatchObject({ status: "due", gate_basis: "clinic timezone unconfirmed", not_before: new Date("2020-01-01T00:00:00Z") });
    await getMigratorPool().query(`update clinics set timezone_confirmed_at = now() where id = $1`, [c.clinicId]);
    await inTenant(c.clinicId, (client) => client.query(`update outbound_calls set status = 'cancelled' where id = $1`, [unconfirmed.callId]));

    // Suppression outranks the consent the row was scheduled under.
    const suppressed = await dueRow(c);
    await inTenant(c.clinicId, (client) => client.query(`insert into suppressions (clinic_id, phone, reason) values ($1, $2, 'complaint')`, [c.clinicId, PHONE]));
    expect(await dialDue(now, { client })).toMatchObject({ refused: 1 });
    expect(await rowOf(c.clinicId, suppressed.callId)).toMatchObject({ status: "refused", refusal_code: "suppressed", gate_basis: "number suppressed" });
    expect(client.calls).toHaveLength(0);
    expect(await attemptsFor(c.clinicId, PHONE)).toBe(0);
    const audit = await inTenant(c.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'outbound_call' and metadata->>'outcome' = 'refused_by_gate'`));
    expect(audit.rows.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(audit.rows)).not.toMatch(/0181|0199/);
  });

  test("quiet hours reschedule to the next 08:00 in the recipient's clock and consume no attempt; Sunday too; expiry and the number cap refuse", async () => {
    const c = await clinicForCallbacks("cb-window", { phone: "+14155550182" });
    const { callId } = await dueRow(c);
    // 19:45 on a weekday: deferred to the next day at 08:00 New York (12:00Z), no attempt.
    const evening = weekdayNoon();
    evening.setUTCHours(23, 45, 0, 0);
    expect(await dialDue(evening, { client })).toMatchObject({ deferred: 1, placed: 0, refused: 0 });
    const deferred = await rowOf(c.clinicId, callId);
    expect(deferred).toMatchObject({ status: "due", not_before: new Date("2020-01-01T00:00:00Z") });
    const opening = deferredUntil(deferred.gate_basis)!;
    expect(opening.getTime()).toBeGreaterThan(evening.getTime());
    expect(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: false }).format(opening)).toBe("08:00");
    expect(await attemptsFor(c.clinicId, "+14155550182")).toBe(0);
    expect(client.calls).toHaveLength(0);
    // Not before the opening: the row is not even looked at a minute earlier, and is placed a minute later.
    expect(await dialDue(new Date(opening.getTime() - 60_000), { client })).toMatchObject({ considered: 0 });
    expect(await dialDue(new Date(opening.getTime() + 60_000), { client })).toMatchObject({ placed: 1 });
    expect(client.calls).toHaveLength(1);

    // Sunday 11:00: deferred to Monday 08:00.
    const c2 = await clinicForCallbacks("cb-sunday", { phone: "+14155550183" });
    const sundayRow = await dueRow(c2);
    const sunday = new Date("2026-10-04T15:00:00Z"); // Sunday 11:00 EDT
    expect(await dialDue(sunday, { client })).toMatchObject({ deferred: 1 });
    expect(await rowOf(c2.clinicId, sundayRow.callId)).toMatchObject({ status: "due", gate_basis: "quiet hours until 2026-10-05T12:00:00.000Z" });
    expect(await attemptsFor(c2.clinicId, "+14155550183")).toBe(0);
    // Settled here so the next step's summary counts only its own row.
    await inTenant(c2.clinicId, (client) => client.query(`update outbound_calls set status = 'cancelled' where id = $1`, [sundayRow.callId]));

    // Past LEAST(expires_at, created_at + 7 days): refused, for good.
    const c3 = await clinicForCallbacks("cb-expired", { phone: "+14155550184" });
    const late = await dueRow(c3);
    expect(await dialDue(weekdayNoon(8), { client })).toMatchObject({ refused: 1 });
    expect(await rowOf(c3.clinicId, late.callId)).toMatchObject({ status: "refused", refusal_code: "request_expired" });

    // Four calls to the number in thirty days: the fifth is refused.
    const c4 = await clinicForCallbacks("cb-cap", { phone: "+14155550185" });
    const capped = await dueRow(c4);
    await inTenant(c4.clinicId, async (client) => {
      for (let i = 0; i < 4; i += 1) await client.query(`insert into contact_attempts (clinic_id, phone, channel, purpose) values ($1, $2, 'voice', 'callback')`, [c4.clinicId, "+14155550185"]);
    });
    expect(await dialDue(weekdayNoon(), { client })).toMatchObject({ refused: 1 });
    expect(await rowOf(c4.clinicId, capped.callId)).toMatchObject({ status: "refused", refusal_code: "number_cap" });
    expect(client.calls).toHaveLength(1);
  });

  test("the dial: the attempt is on the ledger before the vendor is asked, the greeting and variables are the design's, and a second row waits while one is placed", async () => {
    const c = await clinicForCallbacks("cb-dial", { phone: "+14155550186", specialty: "plastic-surgery" });
    const { callId } = await dueRow(c, "collect_fields");
    // A second request for the same number, due at the same time.
    const waiting = await dueRow(c, "collect_fields");
    const seenAtDial: { attempts: number; status: string }[] = [];
    const observing = new FixtureOutboundClient({
      onPlaceCall: async () => {
        const attempts = await attemptsFor(c.clinicId, "+14155550186");
        const row = await rowOf(c.clinicId, callId);
        seenAtDial.push({ attempts, status: row.status });
      },
    });
    const now = weekdayNoon();
    expect(await dialDue(now, { client: observing })).toMatchObject({ considered: 2, placed: 1, deferred: 1 });
    // recordAttempt and `placing` had committed by the time the vendor was asked.
    expect(seenAtDial).toEqual([{ attempts: 1, status: "placing" }]);
    expect(await rowOf(c.clinicId, callId)).toMatchObject({ status: "placed", vendor_call_id: "fx-call-1", gate_basis: expect.stringMatching(/Consent on file/) });
    expect((await rowOf(c.clinicId, callId)).placed_at).not.toBeNull();
    expect(await rowOf(c.clinicId, waiting.callId)).toMatchObject({ status: "due", gate_basis: "another call to this number is outstanding" });

    const placed = observing.calls[0]!;
    expect(placed).toMatchObject({
      clinicId: c.clinicId,
      agentId: "agent_cb_1",
      toPhone: "+14155550186",
      fromPhone: "+14155550100",
      name: "Dana",
      timeZone: TZ,
      greeting: callbackDisclosure({ clinicName: "cb-dial Clinic", clinicPhoneSpoken: "four one five — five five five — oh one nine nine" }),
    });
    expect(placed.variables).toEqual({
      first_name: "Dana",
      purpose: "collect_fields",
      clinic_name: "cb-dial Clinic",
      clinic_phone_spoken: "four one five — five five five — oh one nine nine",
      primary_window: "Thursday afternoon",
      alternative_windows: "Friday morning",
      // The service is on the request; the surname and the visit type are what the practice still lacks.
      missing_fields: "Last name, Consultation or treatment visit",
      proposed_slots_spoken: "",
      confirmed_slot_spoken: "",
    });
    // The vendor is handed the number and the first name; never the transcript, the surname or a request id.
    expect(JSON.stringify({ ...placed, clinicId: undefined })).not.toMatch(/Okonkwo|transcripts\.example|[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  test("a vendor refusal is `failed` and earns attempt 2 at four hours; attempt 2 failing earns nothing; an unanswered webhook is `unknown` and never followed", async () => {
    const c = await clinicForCallbacks("cb-retry", { phone: "+14155550187" });
    const { callId, requestId } = await dueRow(c, "offer_alternatives");
    client.failNext("http_502");
    const now = weekdayNoon();
    expect(await dialDue(now, { client })).toMatchObject({ failed: 1, placed: 0 });
    const failed = await rowOf(c.clinicId, callId);
    expect(failed).toMatchObject({ status: "failed", refusal_code: "vendor_error", vendor_call_id: null });
    expect(failed.completed_at).not.toBeNull();
    expect(await attemptsFor(c.clinicId, "+14155550187")).toBe(1);

    // The sweep inserts attempt 2, not before four hours after the failure, and only once.
    expect(await sweepOutboundCalls(now)).toMatchObject({ secondAttempts: 1, unknown: 0 });
    expect(await sweepOutboundCalls(now)).toMatchObject({ secondAttempts: 0 });
    const rows = await inTenant(c.clinicId, (client) => client.query<{ attempt_no: number; status: string; not_before: Date; purpose: string }>(`select attempt_no, status, not_before, purpose from outbound_calls where booking_request_id = $1 order by attempt_no`, [requestId]));
    expect(rows.rows.map((r) => [r.attempt_no, r.status, r.purpose])).toEqual([[1, "failed", "offer_alternatives"], [2, "due", "offer_alternatives"]]);
    expect(new Date(rows.rows[1]!.not_before).getTime()).toBe(new Date(failed.completed_at!).getTime() + 4 * HOUR);

    // Attempt 2 fails too: no attempt 3, by shape and by sweep.
    await inTenant(c.clinicId, (client) => client.query(`update outbound_calls set not_before = '2020-01-01' where booking_request_id = $1 and attempt_no = 2`, [requestId]));
    client.failNext("timeout");
    expect(await dialDue(now, { client })).toMatchObject({ failed: 1 });
    expect(await sweepOutboundCalls(now)).toMatchObject({ secondAttempts: 0 });
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from outbound_calls where booking_request_id = $1`, [requestId]))).rows).toHaveLength(2);

    // A placed call with no webhook after two hours: unknown, never failed, never followed.
    const c2 = await clinicForCallbacks("cb-unknown", { phone: "+14155550188" });
    const placedRow = await dueRow(c2, "collect_fields");
    expect(await dialDue(now, { client })).toMatchObject({ placed: 1 });
    expect(await sweepOutboundCalls(new Date(now.getTime() + 119 * 60_000))).toMatchObject({ unknown: 0 });
    expect(await sweepOutboundCalls(new Date(now.getTime() + 121 * 60_000))).toMatchObject({ unknown: 1, secondAttempts: 0 });
    expect(await rowOf(c2.clinicId, placedRow.callId)).toMatchObject({ status: "unknown", attempt_no: 1 });
    expect(await sweepOutboundCalls(new Date(now.getTime() + 10 * HOUR))).toMatchObject({ unknown: 0, secondAttempts: 0 });
    expect((await inTenant(c2.clinicId, (client) => client.query(`select 1 from outbound_calls where booking_request_id = $1`, [placedRow.requestId]))).rows).toHaveLength(1);
  });

  test("the post-call webhook for a placed call is a callback: matched by id, no recovery claimed, no second request, and an unmatched outbound call is still refused", async () => {
    const c = await clinicForCallbacks("cb-ingest", { phone: "+14155550189" });
    const { callId, requestId } = await dueRow(c, "collect_fields");
    expect(await dialDue(weekdayNoon(), { client })).toMatchObject({ placed: 1 });
    const vendorCallId = (await rowOf(c.clinicId, callId)).vendor_call_id!;

    const event: VoiceCallEvent = {
      externalCallId: vendorCallId,
      clinicId: c.clinicId,
      callerPhone: "+14155550189",
      startedAt: new Date(),
      endedAt: new Date(),
      isCallback: true,
      callStatus: "completed",
      outcome: "booked",
      booking: { scheduledFor: new Date(Date.now() + 3 * 24 * HOUR), preferredWindow: "Thursday afternoon" },
      collectedFields: { last_name: "Okonkwo" },
    };
    const result = await ingestCall(event, ACTOR);
    expect(result).toMatchObject({ recoveryReason: null, duplicate: false, bookingRequestId: requestId });
    expect(await rowOf(c.clinicId, callId)).toMatchObject({ status: "completed", conversation_id: result.conversationId });
    const requests = await inTenant(c.clinicId, (client) => client.query<{ id: string; conversation_id: string | null }>(`select id, conversation_id from booking_requests`));
    expect(requests.rows).toHaveLength(1);
    expect(requests.rows[0]!.conversation_id).not.toBeNull();
    const convo = await inTenant(c.clinicId, (client) => client.query<{ recovery_reason: string | null }>(`select recovery_reason from conversations where id = $1`, [result.conversationId]));
    expect(convo.rows).toEqual([{ recovery_reason: null }]);
    // A replay is a duplicate with the same request.
    expect(await ingestCall(event, ACTOR)).toMatchObject({ duplicate: true, bookingRequestId: requestId });

    // A no-answer disposition leaves the row `failed`, which is what earns attempt 2.
    const c2 = await clinicForCallbacks("cb-noanswer", { phone: "+14155550190" });
    const na = await dueRow(c2, "collect_fields");
    expect(await dialDue(weekdayNoon(), { client })).toMatchObject({ placed: 1 });
    const naVendorId = (await rowOf(c2.clinicId, na.callId)).vendor_call_id!;
    await ingestCall({ externalCallId: naVendorId, clinicId: c2.clinicId, callerPhone: "+14155550190", startedAt: new Date(), callStatus: "no_answer" }, ACTOR);
    expect(await rowOf(c2.clinicId, na.callId)).toMatchObject({ status: "failed" });
    expect(await sweepOutboundCalls(weekdayNoon())).toMatchObject({ secondAttempts: 1 });

    // Flagged outbound, no ledger row: refused before any row is written, and a security event says so.
    const c3 = await clinicForCallbacks("cb-unmatched", { phone: "+14155550191" });
    await expect(ingestCall({ externalCallId: "vendor-says-outbound", clinicId: c3.clinicId, callerPhone: "+14155550191", startedAt: new Date(), isCallback: true }, ACTOR)).rejects.toThrow(VoiceIngestError);
    expect((await inTenant(c3.clinicId, (client) => client.query(`select 1 from conversations`))).rows).toHaveLength(0);
    const events = await getMigratorPool().query(`select metadata from security_events where event = 'outbound_call_refused' and metadata->>'externalCallId' = 'vendor-says-outbound'`);
    expect(events.rows).toHaveLength(1);
  });

  test("stop, on the call or after it: suppressed on every channel, consent revoked, every due row cancelled — once, in one transaction", async () => {
    const c = await clinicForCallbacks("cb-stop", { phone: "+14155550192" });
    const first = await dueRow(c, "collect_fields");
    const second = await dueRow(c, "offer_alternatives");
    expect(await dialDue(weekdayNoon(), { client })).toMatchObject({ placed: 1, deferred: 1 });
    const vendorCallId = (await rowOf(c.clinicId, first.callId)).vendor_call_id!;

    // Mid-call: the stop action hits the tool route.
    const res = await callbackTool(
      new Request(`http://app.test/api/voice/tools/${c.clinicId}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOOLS_SECRET}` },
        body: JSON.stringify({ call_id: vendorCallId, user_phone_number: "+14155550192", action: "stop" }),
      }),
      { params: Promise.resolve({ clinicId: c.clinicId }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: "end" });
    const after = await inTenant(c.clinicId, async (client) => ({
      suppressions: (await client.query<{ phone: string; channel: string | null; reason: string }>(`select phone, channel, reason from suppressions`)).rows,
      consent: (await client.query<{ revoked: boolean }>(`select revoked_at is not null as revoked from consent_records`)).rows,
      calls: (await client.query<{ id: string; status: string; refusal_code: string | null }>(`select id, status, refusal_code from outbound_calls order by created_at`)).rows,
    }));
    expect(after.suppressions).toEqual([{ phone: "+14155550192", channel: null, reason: "stop_request" }]);
    expect(after.consent.every((r) => r.revoked)).toBe(true);
    expect(after.calls).toEqual([
      { id: first.callId, status: "placed", refusal_code: null },
      { id: second.callId, status: "cancelled", refusal_code: "stop" },
    ]);

    // Post-call: the redundant second record. Nothing is doubled.
    await ingestCall({ externalCallId: vendorCallId, clinicId: c.clinicId, callerPhone: "+14155550192", startedAt: new Date(), stopRequested: true, callStatus: "completed" }, ACTOR);
    const again = await inTenant(c.clinicId, async (client) => ({
      suppressions: (await client.query(`select 1 from suppressions`)).rows.length,
      cancelled: (await client.query(`select 1 from outbound_calls where status = 'cancelled'`)).rows.length,
    }));
    // honourStopRequest appends a suppression each time it is honoured (the table is append-only); the cancelled set does not grow.
    expect(again.suppressions).toBe(2);
    expect(again.cancelled).toBe(1);
    expect(await rowOf(c.clinicId, first.callId)).toMatchObject({ status: "completed" });
    // With the consent revoked, nothing more can be scheduled.
    const scheduled = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => scheduleCallback(tx, second.requestId, "confirm_time"));
    expect(scheduled).toEqual({ scheduled: false, reason: "no_consent" });
  });

  test("the callback tool: the request comes from the ledger row, a slot not proposed is refused, fields are validated, and every re-notify is linkless", async () => {
    const c = await clinicForCallbacks("cb-tool", { phone: "+14155550193", specialty: "plastic-surgery" });
    const { callId, requestId, token } = await dueRow(c, "collect_fields", { treatment: null });
    expect(await dialDue(weekdayNoon(), { client })).toMatchObject({ placed: 1 });
    const vendorCallId = (await rowOf(c.clinicId, callId)).vendor_call_id!;
    const tokenHash = (await inTenant(c.clinicId, (client) => client.query<{ h: string }>(`select encode(token_hash, 'hex') as h from booking_requests where id = $1`, [requestId]))).rows[0]!.h;
    const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      callbackTool(
        new Request(`http://app.test/api/voice/tools/${c.clinicId}/callback`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOOLS_SECRET}`, ...headers },
          body: JSON.stringify({ call_id: vendorCallId, user_phone_number: "+14155550193", ...body }),
        }),
        { params: Promise.resolve({ clinicId: c.clinicId }) },
      );

    // Auth and shape.
    expect((await post({ action: "collect" }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ action: "dance" })).status).toBe(400);
    expect((await post({ action: "collect", call_id: "not-ours" })).status).toBe(404);

    // collect: validated against the practice's set, then the desk hears — without a link.
    const collected = await post({ action: "collect", fields: { last_name: "Okonkwo", service: "Rhinoplasty consult", dob: "1990-01-01", consult_or_treatment: "consultation, I'm pregnant" } });
    expect(collected.status).toBe(200);
    expect(await collected.json()).toEqual({ ok: true, next: "close" });
    expect((await inTenant(c.clinicId, (client) => client.query<{ f: Record<string, string> }>(`select collected_fields as f from booking_requests where id = $1`, [requestId]))).rows[0]!.f).toEqual({ last_name: "Okonkwo", service: "Rhinoplasty consult" });
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.message.subject).toBe("Booking request updated — cb-tool Clinic");
    expect(mailed[0]!.message.text).toMatch(/added what you asked for/);
    expect(mailed[0]!.message.text).not.toMatch(/https?:\/\/|Okonkwo|0193|Rhinoplasty/);
    expect(mailed[0]!.message.phiClass).toBe("none");

    // choose_slot on a request that is not rescheduling: refused; then the desk proposes, and only a proposed time confirms.
    const d1 = new Date(Date.now() + 2 * 24 * HOUR);
    const d2 = new Date(Date.now() + 3 * 24 * HOUR);
    expect((await post({ action: "choose_slot", at: d1.toISOString() })).status).toBe(409);
    expect((await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: d1 }, { at: d2 }] })).outcome).toBe("decided");
    const wrong = await post({ action: "choose_slot", at: new Date(Date.now() + 5 * 24 * HOUR).toISOString() });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ ok: false, error: "slot_not_proposed" });
    expect((await resolveBookingRequest(token))!.status).toBe("rescheduling");
    const none = await post({ action: "none_work" });
    expect(await none.json()).toEqual({ ok: true, next: "close" });
    expect(mailed.at(-1)!.message.text).toMatch(/none of the times you proposed work/);
    const chosen = await post({ action: "choose_slot", at: d2.toISOString() });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({ ok: true, booked: true, when_spoken: expect.stringMatching(/^[A-Z][a-z]+ the \d+(st|nd|rd|th) at \d{1,2}(:\d{2})? (AM|PM)$/), calendar: "not-connected" });
    expect(await resolveBookingRequest(token)).toMatchObject({ status: "confirmed", decidedByLabel: "assistant (callback)", bookedVia: "desk" });
    expect(mailed.at(-1)!.message.text).toMatch(/chose one of the times you proposed/);
    expect(mailed.at(-1)!.message.text).not.toMatch(/https?:\/\//);

    // confirm: yes changes nothing; no tells the desk.
    expect(await (await post({ action: "confirm", answer: "yes" })).json()).toEqual({ ok: true, next: "close" });
    const before = mailed.length;
    expect(await (await post({ action: "confirm", answer: "no" })).json()).toEqual({ ok: true, next: "close" });
    expect(mailed).toHaveLength(before + 1);
    expect(mailed.at(-1)!.message.text).toMatch(/no longer works/);
    for (const m of mailed) expect(m.message.text).not.toMatch(/https?:\/\//);

    // The token never moved, and the audit trail names the call by digest only.
    expect((await inTenant(c.clinicId, (client) => client.query<{ h: string }>(`select encode(token_hash, 'hex') as h from booking_requests where id = $1`, [requestId]))).rows[0]!.h).toBe(tokenHash);
    const audit = await inTenant(c.clinicId, (client) => client.query<{ metadata: { callRef?: string; action?: string } }>(`select metadata from audit_log where resource_type = 'voice_tool_callback'`));
    expect(audit.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of audit.rows) expect(row.metadata.callRef).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit.rows)).not.toMatch(new RegExp(vendorCallId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(JSON.stringify(audit.rows)).not.toMatch(/0193/);
  });
});
