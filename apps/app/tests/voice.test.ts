import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveBookingRequirements } from "@healdesk/catalog";
import { isImplemented } from "@healdesk/connectors";

import { POST as providerWebhook } from "@/app/api/webhooks/[provider]/[clinicId]/route";
import { COMMON_WEEKDAY_HOURS } from "@/lib/clinic/opening-hours";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import type { EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import {
  bookingRequestFrom,
  classifyBooking,
  classifyRecovery,
  ingestCall,
  type VoiceCallEvent,
} from "@/lib/voice/ingest";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact } from "./setup/factories";

/**
 * The two classifications the monthly report is built on.
 *
 * `classifyRecovery` answers "would this call have been lost?", and
 * `classifyBooking` answers "did it convert?". They are separate on purpose:
 * conflating them understates how many calls the agent caught and overstates
 * how well it closes them, in the same number.
 */

const TZ = "America/New_York";

/** The normal setup: their line rings first, we get what nobody answered. */
const CONDITIONAL = {
  coverageMode: "overflow_after_hours" as const,
  openingHours: COMMON_WEEKDAY_HOURS,
  timezone: TZ,
};

/** A solo operator with no front desk: we are the primary number. */
const ALWAYS = { ...CONDITIONAL, coverageMode: "all_calls" as const };

/** After hours only: every call forwarded while the clinic is closed, none while it is open. */
const AFTER_HOURS_ONLY = { ...CONDITIONAL, coverageMode: "after_hours_only" as const };

const call = (over: Partial<VoiceCallEvent> = {}): VoiceCallEvent => ({
  externalCallId: "call_1",
  clinicId: "11111111-1111-4111-8111-111111111111",
  // Wednesday 14:00 New York — squarely inside COMMON_WEEKDAY_HOURS.
  startedAt: new Date("2026-09-02T18:00:00Z"),
  ...over,
});

/** Wednesday 21:00 New York — shut. */
const AFTER_HOURS = new Date("2026-09-03T01:00:00Z");

describe("conditional forwarding — the normal setup", () => {
  test("a midday call is recovered, because their receptionist let it ring out", () => {
    // The rule that matters. On a conditionally forwarded line the call only
    // reaches us BECAUSE nobody at the clinic picked it up — so the time of day
    // is irrelevant. An earlier version returned null here, on the theory that
    // the clinic "would have handled it anyway"; under conditional forwarding
    // that case cannot occur, because then it would never have reached us.
    expect(classifyRecovery(call(), CONDITIONAL)).toBe("rang_unanswered");
  });

  test("an after-hours call gets the more specific reason", () => {
    expect(
      classifyRecovery(call({ startedAt: AFTER_HOURS }), CONDITIONAL),
    ).toBe("after_hours");
  });

  test("a busy line is recorded as busy, not as unanswered", () => {
    expect(classifyRecovery(call({ clinicLineBusy: true }), CONDITIONAL)).toBe(
      "line_busy",
    );
  });

  test("a call the agent placed is never recovery, whatever the hour: healdesk places none (v1 is inbound only)", () => {
    const nightCallback = call({ startedAt: AFTER_HOURS, isCallback: true });
    expect(classifyRecovery(nightCallback, CONDITIONAL)).toBeNull();
  });

  test("no opening hours on file still counts the recovery", () => {
    // It only downgrades the REASON. The call still reached us because nobody
    // answered, and that fact does not depend on knowing their schedule.
    expect(
      classifyRecovery(call(), { ...CONDITIONAL, openingHours: null }),
    ).toBe("rang_unanswered");
  });

  test("a malformed schedule downgrades the reason, not the recovery", () => {
    expect(
      classifyRecovery(call(), { ...CONDITIONAL, openingHours: { mon: "9-5" } }),
    ).toBe("rang_unanswered");
  });
});

describe("always-forwarded — where the AI is the front desk", () => {
  test("a midday call is NOT recovered", () => {
    // Nobody was passed over. Counting this would mark the clinic's entire call
    // volume as recovered and make the headline figure meaningless.
    expect(classifyRecovery(call(), ALWAYS)).toBeNull();
  });

  test("an after-hours call IS recovered — nobody there could have taken it", () => {
    expect(classifyRecovery(call({ startedAt: AFTER_HOURS }), ALWAYS)).toBe(
      "after_hours",
    );
  });

  test("a call the agent placed is never recovery, and nothing produces missed_call_callback", () => {
    for (const clinic of [ALWAYS, CONDITIONAL]) {
      expect(classifyRecovery(call({ isCallback: true }), clinic)).toBeNull();
      expect(classifyRecovery(call({ startedAt: AFTER_HOURS, isCallback: true }), clinic)).toBeNull();
    }
  });

  test("with no hours on file, nothing in-hours is claimed", () => {
    // We cannot establish that nobody could have answered, so we do not claim
    // it. Guessing "closed" would manufacture recovery out of missing setup.
    expect(
      classifyRecovery(call(), { ...ALWAYS, openingHours: null }),
    ).toBeNull();
  });
});

describe("after hours only — where the AI answers only while the clinic is closed", () => {
  test("an after-hours call IS recovered", () => {
    expect(classifyRecovery(call({ startedAt: AFTER_HOURS }), AFTER_HOURS_ONLY)).toBe("after_hours");
  });

  test("a call inside the hours is NOT recovered: the forwarding was left on, and nobody at the clinic missed it", () => {
    // Read as Overflow and after hours, as call_routing's 'conditional' did,
    // this would count as rang_unanswered: a call the clinic never had the
    // chance to answer, claimed as one it let ring out.
    expect(classifyRecovery(call(), AFTER_HOURS_ONLY)).toBeNull();
    expect(classifyRecovery(call(), { ...AFTER_HOURS_ONLY, openingHours: null })).toBeNull();
  });
});

describe("the clinic's timezone decides, not the server's", () => {
  test("the same instant classifies differently on each coast", () => {
    // 22:00 UTC on a Wednesday is 18:00 in New York — shut — and 15:00 in Los
    // Angeles, open. On an always-forwarded line that is the difference between
    // recovered and not.
    const instant = call({ startedAt: new Date("2026-09-02T22:00:00Z") });

    expect(classifyRecovery(instant, ALWAYS)).toBe("after_hours");
    expect(
      classifyRecovery(instant, { ...ALWAYS, timezone: "America/Los_Angeles" }),
    ).toBeNull();
  });
});

describe("booking is a separate question from recovery", () => {
  test("a recovered call that booked is a recovered booking", () => {
    const result = classifyBooking(
      call({ outcome: "booked" }),
      "rang_unanswered",
    );
    expect(result).toEqual({
      recovered: true,
      booked: true,
      recoveredBooking: true,
    });
  });

  test("a recovered call that did not book is still recovered", () => {
    // The figure that would be wrong if these were one function: we caught the
    // call, it just did not convert. Dropping it would understate reach.
    const result = classifyBooking(
      call({ outcome: "qualified_no_booking" }),
      "rang_unanswered",
    );
    expect(result.recovered).toBe(true);
    expect(result.recoveredBooking).toBe(false);
  });

  test("a booking on a call we did NOT recover is not a recovered booking", () => {
    // An always-forwarded clinic booking a midday appointment. Real business,
    // and business they would have had anyway — so we do not claim it.
    const result = classifyBooking(call({ outcome: "booked" }), null);
    expect(result).toEqual({
      recovered: false,
      booked: true,
      recoveredBooking: false,
    });
  });

  test("the three figures are strictly nested", () => {
    // answered ⊇ recovered ⊇ recovered bookings. A report that violates this
    // has a close rate above 100% somewhere in it.
    for (const reason of ["rang_unanswered", null] as const) {
      for (const outcome of ["booked", "abandoned"] as const) {
        const r = classifyBooking(call({ outcome }), reason);
        if (r.recoveredBooking) expect(r.recovered && r.booked).toBe(true);
      }
    }
  });
});

/**
 * The causation link.
 *
 * `appointments.conversation_id` is what report.ts inner-joins on to count
 * bookings and what reconcile-store.ts left-joins to decide which revenue was
 * recovered. Nothing wrote it, so a flawless connector would have reported zero
 * bookings and no recovered revenue. These cover the decision that fixes it,
 * and in particular the three cases where the honest answer is to write nothing.
 */
const CONTACT = "33333333-3333-4333-8333-333333333333";
const WHEN = new Date("2026-09-09T15:00:00Z");

describe("the call-to-booking-request link", () => {
  // Since 21 September 2026 a booked call produces a REQUEST for the desk,
  // never an appointment row: the agent semi-confirms only, and the
  // appointment exists when the desk confirms a slot (lib/meta/booking-requests.ts).
  const TZ = "America/Los_Angeles";

  test("a booked call with details and a caller produces the request, in the clinic's clock", () => {
    const req = bookingRequestFrom(
      call({ outcome: "booked", booking: { scheduledFor: WHEN, treatment: "Botox" } }),
      CONTACT,
      TZ,
    );
    expect(req).not.toBeNull();
    expect(req!.treatment).toBe("Botox");
    // 15:00Z on 9 Sep 2026 is 8:00 AM in Los Angeles.
    expect(req!.preferredWindow).toMatch(/Wed, Sep 9, 8:00 AM/);
  });

  test("the window the caller said wins over the extracted time", () => {
    const req = bookingRequestFrom(
      call({ outcome: "booked", booking: { scheduledFor: WHEN, preferredWindow: "any weekday morning" } }),
      CONTACT,
      TZ,
    );
    expect(req!.preferredWindow).toBe("any weekday morning");
  });

  test("a call that did not book produces nothing", () => {
    for (const outcome of ["qualified_no_booking", "price_shopper", "abandoned"] as const) {
      expect(bookingRequestFrom(call({ outcome, booking: { scheduledFor: WHEN } }), CONTACT, TZ)).toBeNull();
    }
  });

  // report.ts joins to appointments precisely so that a booking is a row and
  // not a label. An outcome of "booked" with nothing behind it must not become
  // a request either, or the desk is asked to confirm nothing.
  test("an outcome of booked with no booking details produces nothing", () => {
    expect(bookingRequestFrom(call({ outcome: "booked" }), CONTACT, TZ)).toBeNull();
  });

  // contact_id is NOT NULL. A caller who withheld their number gets no
  // request, because the alternative is inventing a person in the clinic's
  // records.
  test("a caller we cannot identify produces nothing", () => {
    expect(bookingRequestFrom(call({ outcome: "booked", booking: { scheduledFor: WHEN } }), null, TZ)).toBeNull();
  });

  test("alternatives are cleaned like the primary, and fields are limited to the practice's set (§D.1)", () => {
    // A plastic-surgery practice asks for a surname, the service and the visit type.
    const requirements = resolveBookingRequirements("plastic-surgery", null);
    const req = bookingRequestFrom(
      call({
        outcome: "booked",
        booking: { scheduledFor: WHEN, preferredWindow: "Thursday afternoon", alternativeWindows: ["Friday morning", "Thursday afternoon", "Monday, for my rosacea", "Tuesday"], treatment: "Consultation" },
        collectedFields: { last_name: "Okonkwo", consult_or_treatment: "consultation", new_or_existing: "new", dob: "1990-01-01", phone: "+15550000000" },
      }),
      CONTACT,
      TZ,
      requirements,
    )!;
    // The primary is not repeated, the clinical one is dropped, and two is the cap.
    expect(req.alternativeWindows).toEqual(["Friday morning", "Tuesday"]);
    expect(req.collectedFields).toEqual({ last_name: "Okonkwo", consult_or_treatment: "consultation" });
    expect(req.refusedFields.map((r) => `${r.field}:${r.reason}`).sort()).toEqual(["dob:not_required", "new_or_existing:not_required", "phone:locked"]);
    // No consent of any kind rides on a request: healdesk contacts no one about it.
    expect(req).not.toHaveProperty("callbackConsent");
    // With no requirement set, every collected field is refused rather than stored.
    expect(bookingRequestFrom(call({ outcome: "booked", booking: { scheduledFor: WHEN }, collectedFields: { last_name: "X" } }), CONTACT, TZ)!.collectedFields).toEqual({});
  });
});

/**
 * The Synthflow post-call webhook was removed on 14 October 2026. Its URL,
 * /api/webhooks/voice/[clinicId], now falls through to the booking-platform
 * route, which knows no "voice" adapter: a late or forged post stores
 * nothing and is told the endpoint does not exist.
 */
describe("the removed Synthflow webhook's URL", () => {
  test("is a 404 from the booking-platform route, before anything is read or stored", async () => {
    expect(isImplemented("voice")).toBe(false);
    const clinicId = "11111111-1111-4111-8111-111111111111";
    const res = await providerWebhook(
      new Request(`http://app.test/api/webhooks/voice/${clinicId}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer anything" },
        body: JSON.stringify({ call_id: "call_late", start_time: "2026-10-14T12:00:00Z" }),
      }),
      { params: Promise.resolve({ provider: "voice", clinicId }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown endpoint." });
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

/**
 * The post-call ingest in the database, from hand-built events of the shape
 * the Retell endpoint hands over (lib/voice/retell.ts): what it links, what
 * it creates and whom it mails.
 */
describeDb("the post-call ingest", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // A public origin for the desk's link, so "nothing mailed" below is the
    // ingest's choice and not a clinic with nowhere to send.
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  function capture(): { mailed: OutgoingEmail[]; transport: EmailTransport } {
    const mailed: OutgoingEmail[] = [];
    return {
      mailed,
      transport: {
        name: "capture",
        async send(_target, message) {
          mailed.push(message);
          return { status: "sent", messageId: `m-${mailed.length}` };
        },
      },
    };
  }

  /** The clinic's booking alerts (L7) in the outbox. */
  async function bookingAlerts(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
        `select dedupe_key, payload from billing_notices where kind = 'booking_request' order by created_at`,
      ),
    );
    return rows;
  }

  const booked = (clinicId: string, externalCallId: string): VoiceCallEvent => ({
    externalCallId,
    clinicId,
    callerPhone: "+15550100123",
    callerName: "Test Caller",
    startedAt: new Date("2026-09-02T18:00:00Z"),
    endedAt: new Date("2026-09-02T18:04:30Z"),
    durationSeconds: 270,
    outcome: "booked",
    treatmentInterest: "Botox",
    rangAtClinicFirst: true,
    booking: { preferredWindow: "next Thursday afternoon", alternativeWindows: ["Friday morning"], treatment: "Botox" },
  });

  test("the post-call record links what the booking engine logged on the call, by its booking keys, and asks the desk nothing more", async () => {
    const c = await seedClinic("voice-engine-link");
    const contactId = await seedContact(c.clinicId, "+15550100123");
    await inTenant(c.clinicId, (client) => client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [c.clinicId, "desk@example-clinic.test"]));
    // What the engine leaves: the Retell process keys each booking "retell:" + call id + ":" + n.
    const keyed = async (key: string, bookedVia: "desk" | "agent_direct") =>
      (await withTenant({ clinicId: c.clinicId, actor: { type: "service", serviceName: "test" } }, (tx) =>
        createBookingRequest(tx, { channel: "voice", contactId, conversationId: null, preferredWindow: "Thursday afternoon", treatment: "Botox", vendorCallId: key, bookedVia }),
      )).id;
    const first = await keyed("retell:call_rt_1:1", "agent_direct");
    const second = await keyed("retell:call_rt_1:2", "desk");
    // Another call's keys: one sharing this call id's first characters, and
    // one that LIKE 'retell:call_rt_1:%' would match, its underscores being
    // LIKE's any-character; and a key that is the bare call id, which no
    // channel writes, so nothing links it.
    const other = await keyed("retell:call_rt_10:1", "desk");
    const wildcard = await keyed("retell:callXrtX1:1", "desk");
    const bare = await keyed("call_rt_1", "agent_direct");

    const { mailed, transport } = capture();
    const retell = await ingestCall(booked(c.clinicId, "call_rt_1"), undefined, { transport });
    expect(retell.bookingRequestId).toBe(first);
    // A retried hand-over answers with the same request.
    const again = await ingestCall(booked(c.clinicId, "call_rt_1"), undefined, { transport });
    expect(again).toMatchObject({ duplicate: true, conversationId: retell.conversationId, bookingRequestId: first });
    // Every engine alert was raised when the request was committed: nothing
    // is queued or mailed for that call.
    expect(mailed).toEqual([]);
    expect(await bookingAlerts(c.clinicId)).toEqual([]);
    // The control: a call the engine logged nothing on is the ingest's to
    // alert the clinic about (L7), queued in the outbox with the request; it
    // mails no one directly, the report recipients least of all.
    const unkeyed = await ingestCall(booked(c.clinicId, "call_desk_1"), undefined, { transport });
    expect(unkeyed.bookingRequestId).not.toBeNull();
    expect(mailed).toEqual([]);
    expect(await bookingAlerts(c.clinicId)).toEqual([
      {
        dedupe_key: `booking_request:${unkeyed.bookingRequestId}`,
        payload: expect.objectContaining({ channel: "voice", conversationId: unkeyed.conversationId, bookingRequestId: unkeyed.bookingRequestId }),
      },
    ]);

    const rows = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query<{ id: string; conversation_id: string | null }>(`select id, conversation_id from booking_requests`)).rows,
      linked: (await client.query<{ resource_id: string; metadata: Record<string, unknown> }>(
        `select resource_id, metadata from audit_log where resource_type = 'booking_request' and metadata->>'outcome' = 'conversation_linked' order by resource_id`,
      )).rows,
    }));
    // No second request for an "outcome: booked" call, and the other keys untouched.
    expect(rows.requests).toHaveLength(6);
    const linkedTo = Object.fromEntries(rows.requests.map((r) => [r.id, r.conversation_id]));
    expect(linkedTo).toEqual({
      [first]: retell.conversationId,
      [second]: retell.conversationId,
      [other]: null,
      [wildcard]: null,
      [bare]: null,
      [unkeyed.bookingRequestId!]: unkeyed.conversationId,
    });
    expect(rows.linked.map((r) => [r.resource_id, r.metadata.via]).sort()).toEqual(
      [[first, "agent_direct"], [second, "desk"]].sort(),
    );
  });

  test("a synthetic clinic in setup: a booked call becomes one request for the desk, unkeyed, and the clinic is alerted", async () => {
    // Every paying clinic is synthetic until ops put it live; its calls still
    // reach its desk as requests.
    const synthetic = await seedClinic("voice-synthetic");
    await getMigratorPool().query(`update clinics set data_classification = 'synthetic', went_live_at = null where id = $1`, [synthetic.clinicId]);
    await inTenant(synthetic.clinicId, (client) =>
      client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [synthetic.clinicId, "desk@example-clinic.test"]),
    );
    const { mailed, transport } = capture();
    const ingested = await ingestCall(
      {
        externalCallId: "call_synth",
        clinicId: synthetic.clinicId,
        callerPhone: "+14155550177",
        callerName: "Dana Test",
        startedAt: new Date(Date.now() - 300_000),
        endedAt: new Date(),
        durationSeconds: 300,
        outcome: "booked",
        booking: { preferredWindow: "Thursday afternoon", treatment: "Consultation" },
      },
      undefined,
      { transport },
    );
    expect(ingested.bookingRequestId).not.toBeNull();
    const stored = await inTenant(synthetic.clinicId, (client) =>
      client.query<{ status: string; vendor_call_id: string | null; preferred_window: string }>(
        `select status, vendor_call_id, preferred_window from booking_requests`,
      ),
    );
    expect(stored.rows).toEqual([expect.objectContaining({ status: "requested", vendor_call_id: null, preferred_window: "Thursday afternoon" })]);
    expect(mailed).toEqual([]);
    const alerts = await bookingAlerts(synthetic.clinicId);
    expect(alerts).toEqual([
      { dedupe_key: `booking_request:${ingested.bookingRequestId}`, payload: expect.objectContaining({ channel: "voice", conversationId: ingested.conversationId }) },
    ]);
    expect(JSON.stringify(alerts)).not.toMatch(/Dana|0177|Thursday|Consultation|\/booking\//);
  });

  test("an urgent call and a request for a person are alerted at the latest when the call ends, once per call", async () => {
    const c = await seedClinic("voice-alert-backstop");
    const actor = { type: "service", serviceName: "test" } as const;
    const alerts = async () =>
      (
        await inTenant(c.clinicId, (client) =>
          client.query<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }>(
            `select kind, dedupe_key, payload from billing_notices where kind in ('urgent', 'handover') order by kind, dedupe_key`,
          ),
        )
      ).rows;
    const ended = (externalCallId: string): VoiceCallEvent => ({
      externalCallId,
      clinicId: c.clinicId,
      callerPhone: "+15550100140",
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(),
      durationSeconds: 120,
      outcome: "escalated_to_human",
      urgent: true,
      handover: true,
    });

    // The call's own alerts could not be queued while it was up: the ingest
    // queues both, keyed on the call, now pointing at the call itself.
    const missed = await ingestCall(ended("call_backstop_1"));
    expect(await alerts()).toEqual([
      expect.objectContaining({ kind: "handover", dedupe_key: "handover:voice:call_backstop_1", payload: expect.objectContaining({ conversationId: missed.conversationId }) }),
      expect.objectContaining({ kind: "urgent", dedupe_key: "urgent:voice:call_backstop_1", payload: expect.objectContaining({ conversationId: missed.conversationId }) }),
    ]);

    // Queued while the call was up (no conversation yet): the ingest adds nothing.
    await withTenant({ clinicId: c.clinicId, actor }, async (tx) => {
      expect(await notifyBookingAlert(tx, "urgent", { channel: "voice", callId: "call_backstop_2" })).toBe(true);
      expect(await notifyBookingAlert(tx, "handover", { channel: "voice", callId: "call_backstop_2" })).toBe(true);
    });
    await ingestCall(ended("call_backstop_2"));
    const after = await alerts();
    expect(after.map((a) => a.dedupe_key).sort()).toEqual(
      ["handover:voice:call_backstop_1", "handover:voice:call_backstop_2", "urgent:voice:call_backstop_1", "urgent:voice:call_backstop_2"].sort(),
    );
    expect(after.find((a) => a.dedupe_key === "urgent:voice:call_backstop_2")!.payload.conversationId).toBeNull();
  });
});

