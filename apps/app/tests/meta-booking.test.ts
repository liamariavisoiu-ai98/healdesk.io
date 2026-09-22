import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  cleanBookingFields,
  decideBookingRequest,
  followUpLine,
  requestReceivedLine,
  resolveBookingRequest,
} from "@/lib/meta/booking-requests";
import { collectingLine, guardReply, parseModelReply, probeVerdict } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The booking hand-off (decision of 21 September 2026): the front door
 * collects a first name, a number and a window, hands the desk a single-use
 * link, and the desk's answer is relayed as fixed text that names no time.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-booking-tests";
const PAGE_ID = "223456789012345";

describe("what the model may hand over", () => {
  test("a plain reply is read as a reply with no booking", () => {
    expect(parseModelReply("We're open 9 to 5. Call the practice to book.")).toEqual({
      reply: "We're open 9 to 5. Call the practice to book.",
      booking: { wants: false, first_name: null, phone: null, window: null },
    });
  });

  test("JSON, fenced or bare, is parsed and its fields kept as strings or null", () => {
    const parsed = parseModelReply('```json\n{"reply":"Sure — what\'s your first name?","booking":{"wants":true,"first_name":null,"phone":"415 555 0134","window":""}}\n```');
    expect(parsed.reply).toBe("Sure — what's your first name?");
    expect(parsed.booking).toEqual({ wants: true, first_name: null, phone: "415 555 0134", window: null });
  });

  test("cleaning: a name is letters, a phone is E.164, a window carries no clinical content", () => {
    expect(cleanBookingFields({ first_name: "Maria", phone: "(415) 555-0134", window: "any weekday morning" })).toEqual({
      firstName: "Maria",
      phone: "+14155550134",
      preferredWindow: "any weekday morning",
    });
    expect(cleanBookingFields({ first_name: "Maria <script>", phone: "call me", window: "Tuesday, for my rosacea flare-up" })).toEqual({
      firstName: null,
      phone: null,
      preferredWindow: null,
    });
    expect(cleanBookingFields(null)).toEqual({ firstName: null, phone: null, preferredWindow: null });
  });

  test("the fixed lines pass the guard and hand off to the phone", () => {
    for (const line of [
      requestReceivedLine("Radiance", "Maria"),
      followUpLine("Radiance", "accepted"),
      followUpLine("Radiance", "declined"),
      collectingLine({ clinicName: "Radiance" }, ["their first name", "a phone number the practice can call"]),
    ]) {
      expect(guardReply(line)).toEqual({ ok: true });
      expect(probeVerdict(line).ok).toBe(true);
      expect(line).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
    }
  });

  test("a reply that confirms a booking is refused", () => {
    expect(guardReply("Great, you're all booked, see you then!")).toEqual({ ok: false, reason: "a booking confirmation" });
  });
});

function post(body: unknown, secret = APP_SECRET): Promise<Response> {
  const raw = JSON.stringify(body);
  return POST(
    new Request("http://app.test/api/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, secret) },
      body: raw,
    }),
  );
}

const inbound = (text: string, sender = "user-77", pageId = PAGE_ID) => ({
  object: "page",
  entry: [{ id: pageId, messaging: [{ sender: { id: sender }, recipient: { id: pageId }, message: { mid: "m1", text } }] }],
});

const json = (reply: string, booking: Partial<{ wants: boolean; first_name: string; phone: string; window: string }> = {}) =>
  JSON.stringify({ reply, booking: { wants: false, first_name: null, phone: null, window: null, ...booking } });

describeDb("the booking hand-off, end to end", () => {
  const sent: Parameters<MetaSender>[0][] = [];
  const sender: MetaSender = async (input) => {
    sent.push(input);
  };
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
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "verify-me";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    mailed.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  async function liveClinic(label: string, pageId = PAGE_ID) {
    const c = await seedClinic(label);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`, [c.clinicId]);
    await inTenant(c.clinicId, (client) => client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [c.clinicId, "desk@example-clinic.test"]));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, { platform: "messenger", externalId: pageId, accessToken: "EAAB-page-token-0123456789", label: "Main page" });
      await setMetaFrontDoor(tx, true);
    });
    return c;
  }

  test("collects the three things across messages, emails the desk a link with no details, and tells the person the practice will call", async () => {
    const c = await liveClinic("booking");

    // Message 1: wants to book, gives a name. The model asks for the rest.
    __setMetaRuntimeForTests(async () => json("Happy to pass a request on — what's the best number to call you on?", { wants: true, first_name: "Maria" }), sender, transport);
    let res = await post(inbound("Hi, I'd like to book something. I'm Maria."));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[0]!.text).toMatch(/best number/);
    expect(mailed).toHaveLength(0);

    // Message 2: the number, but the model's reply acknowledges a condition
    // — the guard replaces it with the fixed ask for what is still missing.
    __setMetaRuntimeForTests(async () => json("Sorry to hear about your acne! And when suits you?", { phone: "415-555-0134" }), sender, transport);
    res = await post(inbound("415-555-0134 — it's for my acne"));
    expect(sent[1]!.text).toMatch(/a preferred day or time/);
    expect(sent[1]!.text).not.toMatch(/acne/);

    const draft = await inTenant(c.clinicId, (client) => client.query<{ first_name: string; phone: string; preferred_window: string | null }>(`select first_name, phone, preferred_window from meta_booking_drafts`));
    expect(draft.rows).toEqual([{ first_name: "Maria", phone: "+14155550134", preferred_window: null }]);

    // Message 3: the window. The request exists, the desk is emailed, the
    // draft is gone, and the reply is the fixed line — not the model's.
    __setMetaRuntimeForTests(async () => json("Great, you're all booked for Tuesday at 2pm!", { window: "any weekday morning" }), sender, transport);
    res = await post(inbound("any weekday morning works"));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[2]!.text).toBe(requestReceivedLine("booking Clinic", "Maria"));
    expect(sent[2]!.text).not.toMatch(/2pm|Tuesday|0134/);

    expect(mailed).toHaveLength(1);
    const mail = mailed[0]!;
    expect(mail.target.to).toBe("desk@example-clinic.test");
    expect(mail.message.phiClass).toBe("none");
    expect(mail.message.subject).toMatch(/booking request via Messenger/);
    expect(mail.message.text).not.toMatch(/Maria|0134|weekday/);
    const link = mail.message.text.match(/https:\/\/app\.healdesk\.test\/booking\/([A-Za-z0-9_-]{43})/);
    expect(link).not.toBeNull();
    const token = link![1]!;

    const stored = await inTenant(c.clinicId, async (client) => ({
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
      requests: (await client.query<{ status: string; preferred_window: string; desk_notified_at: string | null; token_len: number }>(`select status, preferred_window, desk_notified_at, octet_length(token_hash) as token_len from booking_requests`)).rows,
      contacts: (await client.query<{ phone: string; full_name: string }>(`select phone, full_name from contacts`)).rows,
      audit: (await client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at`)).rows,
    }));
    expect(stored.drafts).toBe(0);
    expect(stored.requests).toMatchObject([{ status: "requested", preferred_window: "any weekday morning", token_len: 32 }]);
    expect(stored.requests[0]!.desk_notified_at).not.toBeNull();
    expect(stored.contacts).toEqual([{ phone: "+14155550134", full_name: "Maria" }]);
    expect(stored.audit.map((a) => a.metadata.booking)).toEqual(["collecting", "collecting", "requested"]);
    expect(JSON.stringify(stored.audit)).not.toMatch(/Maria|0134/);

    // The desk opens the link: the three things, and nothing else.
    const opened = await resolveBookingRequest(token);
    expect(opened).toMatchObject({ clinicId: c.clinicId, firstName: "Maria", phone: "+14155550134", preferredWindow: "any weekday morning", status: "requested", platform: "messenger" });
    expect(await resolveBookingRequest("A".repeat(43))).toBeNull();
    expect(await resolveBookingRequest("not-a-token")).toBeNull();

    // Accept: one decision, relayed as the fixed line through the sealed token.
    const decided = await decideBookingRequest(token, "accepted", { decidedByLabel: "Jo at the desk", deskNote: "Thursday 10am works" }, sender);
    expect(decided).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null });
    expect(sent[3]).toMatchObject({ platform: "messenger", externalId: PAGE_ID, recipientId: "user-77", accessToken: "EAAB-page-token-0123456789" });
    expect(sent[3]!.text).toBe(followUpLine("booking Clinic", "accepted"));
    expect(sent[3]!.text).not.toMatch(/Thursday|10am/);

    // A second decision, either way, changes nothing and sends nothing.
    expect(await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).toEqual({ outcome: "already-decided", followUp: null, appointmentId: null });
    expect(sent).toHaveLength(4);
    const after = await resolveBookingRequest(token);
    expect(after).toMatchObject({ status: "accepted", decidedByLabel: "Jo at the desk", deskNote: "Thursday 10am works" });

    // The row cannot be re-decided even by a direct write.
    await expect(
      inTenant(c.clinicId, (client) => client.query(`update booking_requests set status = 'declined', decided_at = now()`)),
    ).rejects.toThrow(/not a permitted transition/);

    // Expired: the link is dead, and the decision refuses. The row's expiry
    // is frozen by the trigger and the table is FORCE RLS, so the clock is
    // moved as the owner with the trigger off — nothing the app could do.
    await getMigratorPool().query(`alter table booking_requests disable trigger booking_requests_no_rewrite`);
    await inTenant(c.clinicId, (client) => client.query(`update booking_requests set expires_at = now() - interval '1 minute'`));
    await getMigratorPool().query(`alter table booking_requests enable trigger booking_requests_no_rewrite`);
    expect(await resolveBookingRequest(token)).toBeNull();
    expect(await decideBookingRequest(token, "accepted", { decidedByLabel: null, deskNote: null }, sender)).toEqual({ outcome: "invalid", followUp: null, appointmentId: null });
  });

  test("a public question leaves no draft; a decline is relayed without a time", async () => {
    const c = await liveClinic("booking-decline", "323456789012345");
    __setMetaRuntimeForTests(async () => json("We're open weekdays 9 to 5 — call the practice to book."), sender, transport);
    await post(inbound("what are your hours?", "user-88", "323456789012345"));
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from meta_booking_drafts`))).rows).toHaveLength(0);

    __setMetaRuntimeForTests(async () => json("Got it — the practice will call you.", { wants: true, first_name: "Sam", phone: "+14155550177", window: "Saturday afternoon" }), sender, transport);
    await post(inbound("Sam, +1 415 555 0177, Saturday afternoon please", "user-88", "323456789012345"));
    const token = mailed[0]!.message.text.match(/\/booking\/([A-Za-z0-9_-]{43})/)![1]!;
    const decided = await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender);
    expect(decided).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null });
    expect(sent.at(-1)!.text).toBe(followUpLine("booking-decline Clinic", "declined"));
    expect(guardReply(sent.at(-1)!.text)).toEqual({ ok: true });

    const { runOperation } = await import("@/lib/ops/api");
    const view = await runOperation("getOnboarding", { clinicId: c.clinicId }, { email: "ops@healdesk.test", request: {} });
    expect((view.body as { data: { meta: { bookingRequests: unknown } } }).data.meta.bookingRequests).toEqual({ waiting: 0, accepted: 0, confirmed: 0, declined: 1 });
  });

  test("a call-back acceptance can later be confirmed to a slot from the same link; the appointment appears then", async () => {
    const c = await liveClinic("booking-confirm", "523456789012345");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Ana", phone: "+14155550155", window: "Friday morning" }), sender, transport);
    await post(inbound("Ana, 415 555 0155, Friday morning", "user-55", "523456789012345"));
    const token = mailed[0]!.message.text.match(/\/booking\/([A-Za-z0-9_-]{43})/)![1]!;

    const accepted = await decideBookingRequest(token, "accepted", { decidedByLabel: "Sam", deskNote: null }, sender);
    expect(accepted).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null });
    expect(sent.at(-1)!.text).toBe(followUpLine("booking-confirm Clinic", "accepted"));

    const when = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const confirmed = await decideBookingRequest(token, "confirmed", { decidedByLabel: "Sam", deskNote: "Room 2", confirmedFor: when, treatment: "Consultation" }, sender);
    expect(confirmed.outcome).toBe("decided");
    expect(confirmed.followUp).toBe("sent");
    expect(confirmed.appointmentId).not.toBeNull();
    expect(sent.at(-1)!.text).toBe(followUpLine("booking-confirm Clinic", "confirmed"));
    expect(sent.at(-1)!.text).not.toMatch(/Room 2|Consultation|\d{1,2}:\d{2}/);
    const appt = await inTenant(c.clinicId, (client) => client.query<{ treatment: string; scheduled_for: Date }>(`select treatment, scheduled_for from appointments`));
    expect(appt.rows).toHaveLength(1);
    expect(appt.rows[0]!.treatment).toBe("Consultation");
    expect(new Date(appt.rows[0]!.scheduled_for).getTime()).toBe(Math.floor(when.getTime() / 1000) * 1000 + (when.getTime() % 1000));
    const after = await resolveBookingRequest(token);
    expect(after).toMatchObject({ status: "confirmed", channel: "meta", deskNote: "Room 2" });

    // Confirmed is final.
    expect((await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).outcome).toBe("already-decided");
  });

  test("a clinic with no desk address still gets the request, and it waits in the care view", async () => {
    const c = await liveClinic("booking-nodesk", "423456789012345");
    await inTenant(c.clinicId, (client) => client.query(`delete from report_recipients`));
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Lee", phone: "+14155550166", window: "next week" }), sender, transport);
    await post(inbound("Lee, 415 555 0166, next week", "user-99", "423456789012345"));
    expect(mailed).toHaveLength(0);
    const rows = await inTenant(c.clinicId, (client) => client.query<{ status: string; desk_notified_at: string | null }>(`select status, desk_notified_at from booking_requests`));
    expect(rows.rows).toEqual([{ status: "requested", desk_notified_at: null }]);
  });
});
