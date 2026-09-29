import { CALLBACK_CONSENT } from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { directBookingAllowed } from "@/lib/booking/mode";
import { callbacksAvailable, scheduleCallback } from "@/lib/callbacks/schedule";
import { attachMetaChannel, sendMetaTemplate, setMetaFrontDoor, whatsappTemplatePayload, type MetaSender, type MetaTemplateSender } from "@/lib/meta/channels";
import {
  cleanBookingFields,
  confirmProposedSlot,
  decideBookingRequest,
  expireLapsedRequests,
  followUpLine,
  recordCollectedFields,
  renotifyDesk,
  requestReceivedLine,
  resolveBookingRequest,
} from "@/lib/meta/booking-requests";
import { answerFrontDoor, callbackConsentQuestion, collectingLine, guardReply, parseModelReply, probeVerdict, stopAcknowledgedLine, sweepMetaBookingDrafts, whatsappOptInQuestion, type MetaPlatform } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The booking hand-off (decisions of 21 and 23 September 2026): the front
 * door collects a first name, a number, a window and up to two alternatives;
 * the code — never the model — asks the fixed callback question and, on
 * WhatsApp, the opt-in; the person's own words are the consent evidence; the
 * desk gets a single-use link and four decisions; the person is told in fixed
 * text that names no time, and only inside Meta's window.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-booking-tests";
const PAGE_ID = "223456789012345";
const DAY = 24 * 60 * 60 * 1000;

const json = (
  reply: string,
  booking: Partial<{ wants: boolean; first_name: string; phone: string; window: string; alt_windows: string[]; callback_ok: boolean | null; whatsapp_ok: boolean | null; fields: Record<string, string> }> = {},
) => JSON.stringify({ reply, booking: { wants: false, first_name: null, phone: null, window: null, alt_windows: [], callback_ok: null, whatsapp_ok: null, fields: {}, ...booking } });

describe("what the model may hand over", () => {
  test("a plain reply is read as a reply with no booking", () => {
    expect(parseModelReply("We're open 9 to 5. Call the practice to book.")).toEqual({
      reply: "We're open 9 to 5. Call the practice to book.",
      booking: { wants: false, first_name: null, phone: null, window: null, alt_windows: [], callback_ok: null, whatsapp_ok: null, fields: {} },
    });
  });

  test("JSON, fenced or bare, is parsed: strings or null, alternatives, the two classifiers and the fields", () => {
    const parsed = parseModelReply(
      '```json\n{"reply":"Sure — what\'s your first name?","booking":{"wants":true,"first_name":null,"phone":"415 555 0134","window":"","alt_windows":["Thursday after 4","", 7],"callback_ok":true,"fields":{"last_name":"Lopez","bad key":"x"}}}\n```',
    );
    expect(parsed.reply).toBe("Sure — what's your first name?");
    expect(parsed.booking).toEqual({ wants: true, first_name: null, phone: "415 555 0134", window: null, alt_windows: ["Thursday after 4"], callback_ok: true, whatsapp_ok: null, fields: { last_name: "Lopez" } });
    expect(parseModelReply(json("ok", { callback_ok: false })).booking.callback_ok).toBe(false);
    expect(parseModelReply(json("ok", { whatsapp_ok: true })).booking.whatsapp_ok).toBe(true);
  });

  test("one message answers one question: both flags from one reply are refused", () => {
    const both = parseModelReply(json("ok", { callback_ok: true, whatsapp_ok: true })).booking;
    expect(both.callback_ok).toBeNull();
    expect(both.whatsapp_ok).toBeNull();
  });

  test("cleaning: a name is letters, a phone is E.164, windows carry no clinical content, alternatives cap at two and never repeat the primary", () => {
    expect(cleanBookingFields({ first_name: "Maria", phone: "(415) 555-0134", window: "any weekday morning", alt_windows: ["Thursday after 4", "any weekday morning", "Friday lunchtime", "Saturday"] })).toEqual({
      firstName: "Maria",
      phone: "+14155550134",
      preferredWindow: "any weekday morning",
      alternativeWindows: ["Thursday after 4", "Friday lunchtime"],
    });
    expect(cleanBookingFields({ first_name: "Maria <script>", phone: "call me", window: "Tuesday, for my rosacea flare-up", alternatives: ["Thursday, my acne is bad", "Friday after 2"] })).toEqual({
      firstName: null,
      phone: null,
      preferredWindow: null,
      alternativeWindows: ["Friday after 2"],
    });
    expect(cleanBookingFields(null)).toEqual({ firstName: null, phone: null, preferredWindow: null, alternativeWindows: [] });
  });

  test("every fixed line passes the guard, hands off to the phone and names no time — including the G.3 template parameters", () => {
    for (const line of [
      requestReceivedLine("Radiance", "Maria"),
      followUpLine("Radiance", "accepted"),
      followUpLine("Radiance", "declined"),
      followUpLine("Radiance", "confirmed"),
      followUpLine("Radiance", "rescheduling"),
      collectingLine({ clinicName: "Radiance" }, ["your first name", "a number the practice can call"]),
      callbackConsentQuestion("Radiance"),
      whatsappOptInQuestion("Radiance"),
      stopAcknowledgedLine({ clinicName: "Radiance", phone: "+1 415 555 0199" }),
    ]) {
      expect(guardReply(line), line).toEqual({ ok: true });
      // Every line but the WhatsApp question also hands off: that one only asks yes or no.
      if (line !== whatsappOptInQuestion("Radiance")) expect(probeVerdict(line).ok, line).toBe(true);
      expect(line).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
    }
    expect(followUpLine("Radiance", "rescheduling")).not.toMatch(/monday|tuesday|wednesday|thursday|friday|saturday|sunday|dr\b/i);
    for (const parameter of ["Maria", "Radiance Med Spa", "+1 415 555 0199"]) expect(guardReply(parameter)).toEqual({ ok: true });
    const payload = whatsappTemplatePayload({ to: "15550100123", templateName: "healdesk_request_update_v1", firstName: "Maria", clinicName: "Radiance", clinicPhone: "+14155550199" });
    expect(JSON.stringify(payload)).not.toMatch(/appointment|\d{1,2}:\d{2}|botox|consult/i);
  });

  test("a reply that confirms a booking or promises a text is refused", () => {
    expect(guardReply("Great, you're all booked, see you then!")).toEqual({ ok: false, reason: "a booking confirmation" });
    expect(guardReply("We'll text you when the desk has confirmed.")).toEqual({ ok: false, reason: "a text promise" });
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
const inboundIg = (text: string, sender: string, igId: string) => ({
  object: "instagram",
  entry: [{ id: igId, messaging: [{ sender: { id: sender }, recipient: { id: igId }, message: { mid: "m1", text } }] }],
});
const inboundWa = (text: string, from: string, phoneNumberId: string) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ from, type: "text", text: { body: text } }] } }] }],
});
const inboundOn = (platform: MetaPlatform, text: string, sender: string, externalId: string) =>
  platform === "messenger" ? inbound(text, sender, externalId) : platform === "instagram" ? inboundIg(text, sender, externalId) : inboundWa(text, sender, externalId);

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
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
    delete process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED;
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    mailed.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
    delete process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED;
  });

  afterAll(async () => {
    await closePools();
  });

  async function liveClinic(label: string, externalId = PAGE_ID, platform: MetaPlatform = "messenger") {
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
      await attachMetaChannel(tx, { platform, externalId, accessToken: "EAAB-page-token-0123456789", label: "Main page" });
      await setMetaFrontDoor(tx, true);
    });
    return c;
  }

  /** One message with the three things, then the answer to the fixed question. Returns the desk's token. */
  async function quickRequest(platform: MetaPlatform, externalId: string, senderId: string, opts: { name?: string; phone?: string; consent?: boolean } = {}) {
    const name = opts.name ?? "Sam";
    const phone = opts.phone ?? "+14155550177";
    __setMetaRuntimeForTests(async () => json("Got it — the practice will call you.", { wants: true, first_name: name, phone, window: "Saturday afternoon" }), sender, transport);
    await post(inboundOn(platform, `${name}, ${phone}, Saturday afternoon please`, senderId, externalId));
    const clinicName = sent.at(-1)!.text.match(/Is it OK for (.+?)'s automated assistant/)?.[1];
    expect(clinicName).toBeDefined();
    expect(sent.at(-1)!.text).toBe(callbackConsentQuestion(clinicName!));
    const consent = opts.consent ?? false;
    __setMetaRuntimeForTests(async () => json("Noted.", { callback_ok: consent }), sender, transport);
    await post(inboundOn(platform, consent ? "yes that's fine" : "no thanks", senderId, externalId));
    if (platform === "whatsapp") {
      __setMetaRuntimeForTests(async () => json("Noted.", { whatsapp_ok: consent }), sender, transport);
      await post(inboundOn(platform, consent ? "yes" : "no", senderId, externalId));
    }
    expect(sent.at(-1)!.text).toBe(requestReceivedLine(clinicName!, name));
    const token = mailed.at(-1)?.message.text.match(/\/booking\/([A-Za-z0-9_-]{43})/)?.[1];
    if (!token) throw new Error("no desk email carried a link");
    return token;
  }

  test("collects the three things, asks the fixed callback question, and creates on the answer — with the alternative and a consent row in the person's words", async () => {
    const c = await liveClinic("booking");

    // Message 1: wants to book, gives a name. The model asks for the rest.
    __setMetaRuntimeForTests(async () => json("Happy to pass a request on — what's the best number to call you on?", { wants: true, first_name: "Maria" }), sender, transport);
    let res = await post(inbound("Hi, I'd like to book something. I'm Maria."));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[0]!.text).toMatch(/best number/);
    expect(mailed).toHaveLength(0);

    // Message 2: the number, but the model's reply acknowledges a condition
    // — the guard replaces it with the fixed ask, in the catalogue's words.
    __setMetaRuntimeForTests(async () => json("Sorry to hear about your acne! And when suits you?", { phone: "415-555-0134" }), sender, transport);
    res = await post(inbound("415-555-0134 — it's for my acne"));
    expect(sent[1]!.text).toMatch(/a day or time that works best/);
    expect(sent[1]!.text).not.toMatch(/acne/);

    // Message 3: the window arrives last. The three things are in hand, so
    // the CODE asks the fixed callback question — not the model's text — and
    // no request exists yet.
    __setMetaRuntimeForTests(async () => json("Great, you're all booked for Tuesday at 2pm!", { window: "any weekday morning" }), sender, transport);
    res = await post(inbound("any weekday morning works"));
    expect(sent[2]!.text).toBe(callbackConsentQuestion("booking Clinic"));
    expect(sent[2]!.text).not.toMatch(/2pm|Tuesday|0134/);
    expect(mailed).toHaveLength(0);
    const draft = await inTenant(c.clinicId, (client) =>
      client.query<{ first_name: string; phone: string; preferred_window: string | null; consent_asked_at: string | null; callback_consent: boolean | null }>(
        `select first_name, phone, preferred_window, consent_asked_at, callback_consent from meta_booking_drafts`,
      ),
    );
    expect(draft.rows).toMatchObject([{ first_name: "Maria", phone: "+14155550134", preferred_window: "any weekday morning", callback_consent: null }]);
    expect(draft.rows[0]!.consent_asked_at).not.toBeNull();
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(0);

    // Message 4: the answer, carrying an alternative. The request exists with
    // the alternative, the consent row quotes the raw text, the desk is
    // emailed, the draft is gone, and the reply is the fixed line.
    __setMetaRuntimeForTests(async () => json("Lovely, the practice will be in touch.", { callback_ok: true, alt_windows: ["Thursday after 4"] }), sender, transport);
    res = await post(inbound("yes, and Thursday after 4 also works"));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[3]!.text).toBe(requestReceivedLine("booking Clinic", "Maria"));

    expect(mailed).toHaveLength(1);
    const mail = mailed[0]!;
    expect(mail.target.to).toBe("desk@example-clinic.test");
    expect(mail.message.phiClass).toBe("none");
    expect(mail.message.subject).toMatch(/booking request via Messenger/);
    expect(mail.message.text).toMatch(/a first choice and up to two backups/);
    expect(mail.message.text).toMatch(/propose other times/);
    expect(mail.message.text).not.toMatch(/Maria|0134|weekday|Thursday/);
    const link = mail.message.text.match(/https:\/\/app\.healdesk\.test\/booking\/([A-Za-z0-9_-]{43})/);
    expect(link).not.toBeNull();
    const token = link![1]!;

    const stored = await inTenant(c.clinicId, async (client) => ({
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
      requests: (
        await client.query<{ id: string; status: string; preferred_window: string; alternative_windows: string[]; desk_notified_at: string | null; last_inbound_at: string | null; token_len: number }>(
          `select id, status, preferred_window, alternative_windows, desk_notified_at, last_inbound_at, octet_length(token_hash) as token_len from booking_requests`,
        )
      ).rows,
      consent: (
        await client.query<{ phone: string; channel: string; consent_type: string; source: string; exact_wording: string; wording_version: string; booking_request_id: string; revoked_at: string | null }>(
          `select phone, channel, consent_type, source, exact_wording, wording_version, booking_request_id, revoked_at from consent_records`,
        )
      ).rows,
      contacts: (await client.query<{ phone: string; full_name: string }>(`select phone, full_name from contacts`)).rows,
      audit: (await client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at`)).rows,
    }));
    expect(stored.drafts).toBe(0);
    expect(stored.requests).toMatchObject([{ status: "requested", preferred_window: "any weekday morning", alternative_windows: ["Thursday after 4"], token_len: 32 }]);
    expect(stored.requests[0]!.desk_notified_at).not.toBeNull();
    expect(stored.requests[0]!.last_inbound_at).not.toBeNull();
    expect(stored.consent).toHaveLength(1);
    expect(stored.consent[0]).toMatchObject({ phone: "+14155550134", channel: "voice", consent_type: "express", source: "meta_thread", wording_version: CALLBACK_CONSENT.version, booking_request_id: stored.requests[0]!.id, revoked_at: null });
    expect(stored.consent[0]!.exact_wording).toBe(`${CALLBACK_CONSENT.meta.replace("{clinic}", "booking Clinic")} — answered: yes, and Thursday after 4 also works`);
    expect(stored.contacts).toEqual([{ phone: "+14155550134", full_name: "Maria" }]);
    expect(stored.audit.map((a) => a.metadata.booking)).toEqual(["collecting", "collecting", "collecting", "requested"]);
    expect(stored.audit[2]!.metadata.asked).toBe("callback");
    expect(JSON.stringify(stored.audit)).not.toMatch(/Maria|0134|Thursday/);

    // The desk opens the link: the four things, and nothing else. No
    // calendar is connected and callbacks are off, so the copy says "call".
    const opened = await resolveBookingRequest(token);
    expect(opened).toMatchObject({
      clinicId: c.clinicId,
      firstName: "Maria",
      phone: "+14155550134",
      preferredWindow: "any weekday morning",
      alternativeWindows: ["Thursday after 4"],
      status: "requested",
      platform: "messenger",
      calendar: null,
      callbackAvailable: false,
      pendingCallback: null,
      metaWindowOpen: true,
      bookedVia: "desk",
      collectedFields: {},
    });
    expect(await resolveBookingRequest("A".repeat(43))).toBeNull();
    expect(await resolveBookingRequest("not-a-token")).toBeNull();

    // Accept: one decision, relayed as the fixed line through the sealed token.
    const decided = await decideBookingRequest(token, "accepted", { decidedByLabel: "Jo at the desk", deskNote: "Thursday 10am works" }, sender);
    expect(decided).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null, calendarWrite: null, callback: null });
    expect(sent[4]).toMatchObject({ platform: "messenger", externalId: PAGE_ID, recipientId: "user-77", accessToken: "EAAB-page-token-0123456789" });
    expect(sent[4]!.text).toBe(followUpLine("booking Clinic", "accepted"));
    expect(sent[4]!.text).not.toMatch(/Thursday|10am/);

    // A second decision, either way, changes nothing and sends nothing.
    expect(await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).toEqual({ outcome: "already-decided", followUp: null, appointmentId: null, calendarWrite: null, callback: null });
    expect(sent).toHaveLength(5);
    const after = await resolveBookingRequest(token);
    expect(after).toMatchObject({ status: "accepted", decidedByLabel: "Jo at the desk", deskNote: "Thursday 10am works" });

    // The row cannot be re-decided even by a direct write.
    await expect(inTenant(c.clinicId, (client) => client.query(`update booking_requests set status = 'declined', decided_at = now()`))).rejects.toThrow(/not a permitted transition/);

    // Expired: the link is dead, and the decision refuses. The row's expiry
    // is frozen by the trigger and the table is FORCE RLS, so the clock is
    // moved as the owner with the trigger off — nothing the app could do.
    await getMigratorPool().query(`alter table booking_requests disable trigger booking_requests_no_rewrite`);
    await inTenant(c.clinicId, (client) => client.query(`update booking_requests set expires_at = now() - interval '1 minute'`));
    await getMigratorPool().query(`alter table booking_requests enable trigger booking_requests_no_rewrite`);
    expect(await resolveBookingRequest(token)).toBeNull();
    expect(await decideBookingRequest(token, "accepted", { decidedByLabel: null, deskNote: null }, sender)).toMatchObject({ outcome: "invalid" });
  });

  test("a clinical consent reply is stored as 'redacted' and writes no consent row; a bare yes with no words writes none either", async () => {
    const c = await liveClinic("booking-redacted", "323456789012345");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Sam", phone: "+14155550177", window: "Saturday afternoon" }), sender, transport);
    await post(inbound("Sam, +1 415 555 0177, Saturday afternoon please", "user-88", "323456789012345"));
    expect(sent.at(-1)!.text).toBe(callbackConsentQuestion("booking-redacted Clinic"));

    // The reply is a yes with a pregnancy mention: the words are redacted
    // before the model sees them, so the yes has no evidence and is not consent.
    __setMetaRuntimeForTests(async () => json("Noted.", { callback_ok: true }), sender, transport);
    await post(inbound("yes, I'm pregnant so mornings are best", "user-88", "323456789012345"));
    expect(sent.at(-1)!.text).toBe(requestReceivedLine("booking-redacted Clinic", "Sam"));
    const stored = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query(`select 1 from booking_requests`)).rows.length,
      consent: (await client.query(`select 1 from consent_records`)).rows.length,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
    }));
    expect(stored).toEqual({ requests: 1, consent: 0, drafts: 0 });
    // Nothing the person wrote survives anywhere but the (now deleted) draft.
    const everything = await inTenant(c.clinicId, (client) => client.query<{ row: string }>(`select row_to_json(r)::text as row from booking_requests r union all select row_to_json(a)::text from audit_log a`));
    expect(everything.rows.map((r) => r.row).join("\n")).not.toMatch(/pregnant/);

    // A second thread: the classifier says yes to a message with no words.
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Lee", phone: "+14155550166", window: "next week" }), sender, transport);
    await post(inbound("Lee, 415 555 0166, next week", "user-89", "323456789012345"));
    const answer = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, {
        platform: "messenger",
        text: "   ",
        responder: async () => json("Noted.", { callback_ok: true }),
        thread: { platform: "messenger", externalId: "323456789012345", senderId: "user-89", connectionId: null },
        transport,
      }),
    );
    expect(answer?.booking).toBe("requested");
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from consent_records`))).rows).toHaveLength(0);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(2);

    const { runOperation } = await import("@/lib/ops/api");
    const view = await runOperation("getOnboarding", { clinicId: c.clinicId }, { email: "ops@healdesk.test", request: {} });
    expect((view.body as { data: { meta: { bookingRequests: unknown } } }).data.meta.bookingRequests).toEqual({ waiting: 2, accepted: 0, confirmed: 0, declined: 0 });
  });

  test("on WhatsApp the opt-in is its own question, asked only after the callback answer; the request then carries the opt-in in the person's words", async () => {
    const c = await liveClinic("booking-wa", "555000111", "whatsapp");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Ana", phone: "+14155550155", window: "Friday morning" }), sender, transport);
    await post(inboundWa("Ana, 415 555 0155, Friday morning", "15550100123", "555000111"));
    expect(sent.at(-1)!.text).toBe(callbackConsentQuestion("booking-wa Clinic"));

    __setMetaRuntimeForTests(async () => json("Noted.", { callback_ok: true }), sender, transport);
    await post(inboundWa("yes please", "15550100123", "555000111"));
    expect(sent.at(-1)!.text).toBe(whatsappOptInQuestion("booking-wa Clinic"));
    expect(mailed).toHaveLength(0);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(0);
    const draft = await inTenant(c.clinicId, (client) => client.query<{ callback_consent: boolean; callback_consent_quote: string; whatsapp_asked_at: string | null }>(`select callback_consent, callback_consent_quote, whatsapp_asked_at from meta_booking_drafts`));
    expect(draft.rows).toMatchObject([{ callback_consent: true, callback_consent_quote: "yes please" }]);
    expect(draft.rows[0]!.whatsapp_asked_at).not.toBeNull();

    __setMetaRuntimeForTests(async () => json("Noted.", { whatsapp_ok: true }), sender, transport);
    await post(inboundWa("Yes", "15550100123", "555000111"));
    expect(sent.at(-1)!.text).toBe(requestReceivedLine("booking-wa Clinic", "Ana"));
    expect(mailed).toHaveLength(1);
    const rows = await inTenant(c.clinicId, (client) => client.query<{ whatsapp_optin_at: string | null; whatsapp_optin_quote: string | null; platform: string }>(`select whatsapp_optin_at, whatsapp_optin_quote, platform from booking_requests`));
    expect(rows.rows).toMatchObject([{ whatsapp_optin_quote: "Yes", platform: "whatsapp" }]);
    expect(rows.rows[0]!.whatsapp_optin_at).not.toBeNull();
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from consent_records`))).rows).toHaveLength(1);

    // §G.3: the template, only with the flag, the opt-in and clean parameters.
    const templates: Parameters<MetaTemplateSender>[0][] = [];
    const sendTemplate: MetaTemplateSender = async (input) => {
      templates.push(input);
    };
    const input = { clinicId: c.clinicId, to: "15550100123", firstName: "Ana", clinicName: "booking-wa Clinic", clinicPhone: "+14155550199" };
    expect(await sendMetaTemplate(input, { send: sendTemplate })).toEqual({ status: "refused", reason: "templates_disabled" });
    process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED = "true";
    expect(await sendMetaTemplate(input, { send: sendTemplate })).toEqual({ status: "refused", reason: "no_template" });
    await inTenant(c.clinicId, (client) => client.query(`update provider_connections set metadata = metadata || '{"templateName": "healdesk_request_update_v1"}'::jsonb where provider = 'meta-whatsapp'`));
    expect(await sendMetaTemplate({ ...input, firstName: "Ana, your pregnancy consult" }, { send: sendTemplate })).toEqual({ status: "refused", reason: "parameter_refused" });
    expect(await sendMetaTemplate({ ...input, to: "15550109999" }, { send: sendTemplate })).toEqual({ status: "refused", reason: "no_optin" });
    expect(await sendMetaTemplate(input, { send: sendTemplate })).toEqual({ status: "sent", template: "healdesk_request_update_v1" });
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ externalId: "555000111", accessToken: "EAAB-page-token-0123456789" });
    const body = (templates[0]!.payload as { template: { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text: string }[] }[] } }).template;
    expect(body.name).toBe("healdesk_request_update_v1");
    expect(body.language.code).toBe("en_US");
    expect(body.components).toEqual([{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "booking-wa Clinic" }, { type: "text", text: "+14155550199" }] }]);
    expect(JSON.stringify(templates[0]!.payload)).not.toMatch(/Friday|appointment|consult/i);
    const audit = await inTenant(c.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_template_sent' and metadata->>'template' is not null`));
    expect(audit.rows).toEqual([{ metadata: { template: "healdesk_request_update_v1", platform: "whatsapp" } }]);
  });

  test("the hourly sweep creates a request from a draft whose question went unanswered, with no consent row", async () => {
    const c = await liveClinic("booking-sweep", "423456789012345");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Lee", phone: "+14155550166", window: "next week", alt_windows: ["the week after"] }), sender, transport);
    await post(inbound("Lee, 415 555 0166, next week or the week after", "user-99", "423456789012345"));
    expect(sent.at(-1)!.text).toBe(callbackConsentQuestion("booking-sweep Clinic"));

    // Nine minutes: too soon. Eleven: created, once.
    expect(await sweepMetaBookingDrafts(new Date(Date.now() + 9 * 60_000), { transport })).toBe(0);
    expect(mailed).toHaveLength(0);
    expect(await sweepMetaBookingDrafts(new Date(Date.now() + 11 * 60_000), { transport })).toBe(1);
    expect(await sweepMetaBookingDrafts(new Date(Date.now() + 12 * 60_000), { transport })).toBe(0);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.message.text).not.toMatch(/Lee|0166|next week/);
    const stored = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query<{ status: string; alternative_windows: string[]; connection_id: string | null }>(`select status, alternative_windows, connection_id from booking_requests`)).rows,
      consent: (await client.query(`select 1 from consent_records`)).rows.length,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
    }));
    expect(stored.requests).toHaveLength(1);
    expect(stored.requests[0]).toMatchObject({ status: "requested", alternative_windows: ["the week after"] });
    expect(stored.requests[0]!.connection_id).not.toBeNull();
    expect(stored.consent).toBe(0);
    expect(stored.drafts).toBe(0);
    // The person was told nothing by the sweep.
    expect(sent).toHaveLength(1);
  });

  test("outside Meta's 24-hour window nothing is sent on any platform, and the page is told to call", async () => {
    const cases: { platform: MetaPlatform; externalId: string; sender: string }[] = [
      { platform: "messenger", externalId: "623456789012345", sender: "user-61" },
      { platform: "instagram", externalId: "ig-17841400000001", sender: "ig-user-62" },
      { platform: "whatsapp", externalId: "555000222", sender: "15550100222" },
    ];
    for (const [i, k] of cases.entries()) {
      const c = await liveClinic(`booking-window-${k.platform}`, k.externalId, k.platform);
      const token = await quickRequest(k.platform, k.externalId, k.sender, { phone: `+1415555061${i}` });
      const before = sent.length;
      await inTenant(c.clinicId, (client) => client.query(`update booking_requests set last_inbound_at = now() - interval '25 hours'`));
      expect(await resolveBookingRequest(token)).toMatchObject({ metaWindowOpen: false });
      const decided = await decideBookingRequest(token, "accepted", { decidedByLabel: null, deskNote: null }, sender);
      expect(decided).toEqual({ outcome: "decided", followUp: "outside_window", appointmentId: null, calendarWrite: null, callback: null });
      expect(sent).toHaveLength(before);
      const audit = await inTenant(c.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply' and metadata->>'outcome' = 'outside_window'`));
      expect(audit.rows).toHaveLength(1);
      // A fresh inbound message reopens the window on an open request.
      const token2 = await quickRequest(k.platform, k.externalId, `${k.sender}-b`, { name: "Kim", phone: `+1415555062${i}` });
      await inTenant(c.clinicId, (client) => client.query(`update booking_requests set last_inbound_at = now() - interval '25 hours' where status = 'requested'`));
      __setMetaRuntimeForTests(async () => json("We're open 9 to 5 — the practice will call you."), sender, transport);
      await post(inboundOn(k.platform, "any news?", `${k.sender}-b`, k.externalId));
      expect(await resolveBookingRequest(token2)).toMatchObject({ metaWindowOpen: true });
      expect((await decideBookingRequest(token2, "declined", { decidedByLabel: null, deskNote: null }, sender)).followUp).toBe("sent");
    }
  });

  test("propose other times: the desk's alternatives go out as a fixed line, the person's choice confirms, and the alternatives lapse", async () => {
    const c = await liveClinic("booking-resched", "723456789012345");
    const token = await quickRequest("messenger", "723456789012345", "user-71", { consent: true });
    const opened = (await resolveBookingRequest(token))!;
    const d1 = new Date(Date.now() + 2 * DAY);
    const d2 = new Date(Date.now() + 3 * DAY);

    // One to three future slots; a past one or none is refused before anything is read.
    expect(await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [] }, sender)).toMatchObject({ outcome: "invalid" });
    expect(await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: new Date(Date.now() - DAY) }] }, sender)).toMatchObject({ outcome: "invalid" });

    const proposed = await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: "offered two", proposedSlots: [{ at: d2, source: "desk" }, { at: d1, source: "calendar" }] }, sender);
    expect(proposed).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null, calendarWrite: null, callback: { scheduled: false, reason: "outbound_disabled" } });
    expect(sent.at(-1)!.text).toBe(followUpLine("booking-resched Clinic", "rescheduling"));
    expect(guardReply(sent.at(-1)!.text)).toEqual({ ok: true });
    const row = await inTenant(c.clinicId, (client) =>
      client.query<{ status: string; proposed_slots: { at: string; label: string; source: string }[]; reschedule_expires_at: Date; expires_at: Date }>(`select status, proposed_slots, reschedule_expires_at, expires_at from booking_requests`),
    );
    expect(row.rows[0]!.status).toBe("rescheduling");
    expect(row.rows[0]!.proposed_slots.map((s) => s.at)).toEqual([d1.toISOString(), d2.toISOString()]);
    expect(row.rows[0]!.proposed_slots.map((s) => s.source)).toEqual(["calendar", "desk"]);
    for (const s of row.rows[0]!.proposed_slots) expect(s.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)$/);
    expect(new Date(row.rows[0]!.reschedule_expires_at).getTime()).toBe(Math.floor(d1.getTime() / 1000) * 1000 + (d1.getTime() % 1000));
    const audit = await inTenant(c.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'booking_request' and metadata->>'decision' = 'rescheduling'`));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({ outcome: "decided", decision: "rescheduling", slots: 2 });
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(await resolveBookingRequest(token)).toMatchObject({ status: "rescheduling", proposedSlots: [{ at: d1.toISOString(), source: "calendar" }, { at: d2.toISOString(), source: "desk" }] });

    // Propose different times while still rescheduling: a plain update.
    const d3 = new Date(Date.now() + 4 * DAY);
    expect((await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: d3 }] }, sender)).outcome).toBe("decided");
    expect((await resolveBookingRequest(token))!.proposedSlots.map((s) => s.at)).toEqual([d3.toISOString()]);

    // The person chooses: only a proposed time; anything else is refused.
    const tokenHash = (await inTenant(c.clinicId, (client) => client.query<{ h: string }>(`select encode(token_hash, 'hex') as h from booking_requests`))).rows[0]!.h;
    expect(await confirmProposedSlot(c.clinicId, opened.id, d1, { bookedVia: "callback", decidedByLabel: "assistant (callback)", transport })).toMatchObject({ outcome: "invalid" });
    const chosen = await confirmProposedSlot(c.clinicId, opened.id, d3, { bookedVia: "callback", decidedByLabel: "assistant (callback)", transport });
    expect(chosen).toMatchObject({ outcome: "decided", calendarWrite: "not-connected", followUp: null });
    expect(chosen.appointmentId).not.toBeNull();
    expect(await resolveBookingRequest(token)).toMatchObject({ status: "confirmed", confirmedFor: d3, decidedByLabel: "assistant (callback)" });
    expect((await inTenant(c.clinicId, (client) => client.query<{ scheduled_for: Date }>(`select scheduled_for from appointments`))).rows.map((r) => new Date(r.scheduled_for).getTime())).toEqual([Math.floor(d3.getTime() / 1000) * 1000 + (d3.getTime() % 1000)]);
    // The desk is re-notified without a link, and the token has not moved.
    const renotified = mailed.at(-1)!.message;
    expect(renotified.subject).toBe("Booking request updated — booking-resched Clinic");
    expect(renotified.text).toMatch(/chose one of the times you proposed/);
    expect(renotified.text).not.toMatch(/https?:\/\//);
    expect(renotified.phiClass).toBe("none");
    expect((await inTenant(c.clinicId, (client) => client.query<{ h: string }>(`select encode(token_hash, 'hex') as h from booking_requests`))).rows[0]!.h).toBe(tokenHash);
    expect(await confirmProposedSlot(c.clinicId, opened.id, d3, { bookedVia: "desk", decidedByLabel: "Jo" })).toMatchObject({ outcome: "already-decided" });
    expect(await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).toMatchObject({ outcome: "already-decided" });

    // Lapse: a second request whose alternatives nobody chose.
    const token2 = await quickRequest("messenger", "723456789012345", "user-72", { name: "Kim", phone: "+14155550172" });
    expect((await decideBookingRequest(token2, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: d1 }] }, sender)).outcome).toBe("decided");
    // The sweep is platform-wide: flush what earlier tests left lapsed, then nothing here has.
    await expireLapsedRequests(new Date());
    expect(await expireLapsedRequests(new Date())).toEqual({ expired: 0, cancelledCalls: 0 });
    await inTenant(c.clinicId, (client) => client.query(`update booking_requests set reschedule_expires_at = now() - interval '1 minute' where status = 'rescheduling'`));
    expect(await expireLapsedRequests(new Date())).toEqual({ expired: 1, cancelledCalls: 0 });
    expect(await resolveBookingRequest(token2)).toMatchObject({ status: "expired", proposedSlots: [{ at: d1.toISOString() }] });
    expect(await decideBookingRequest(token2, "confirmed", { decidedByLabel: null, deskNote: null, confirmedFor: d1 }, sender)).toMatchObject({ outcome: "already-decided" });
  });

  test("callbacks: every gate refuses in turn, one row is queued when all pass, expiry cancels it, and a stop revokes everything", async () => {
    const c = await liveClinic("booking-callbacks", "823456789012345");
    const token = await quickRequest("messenger", "823456789012345", "user-81", { phone: "+14155550181", consent: true });
    const noConsent = await quickRequest("messenger", "823456789012345", "user-82", { name: "Kim", phone: "+14155550182", consent: false });
    const requestId = (await resolveBookingRequest(token))!.id;
    const noConsentId = (await resolveBookingRequest(noConsent))!.id;

    const schedule = (id: string, purpose: "collect_fields" | "offer_alternatives" | "confirm_time" = "offer_alternatives") =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => scheduleCallback(tx, id, purpose));
    expect(await schedule(requestId)).toEqual({ scheduled: false, reason: "outbound_disabled" });
    process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "true";
    expect(await schedule(requestId)).toEqual({ scheduled: false, reason: "clinic_disabled" });
    await getMigratorPool().query(`update clinics set outbound_callbacks_enabled = true where id = $1`, [c.clinicId]);
    expect(await schedule(noConsentId)).toEqual({ scheduled: false, reason: "no_consent" });
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => callbacksAvailable(tx, "+14155550182"))).toBe(false);
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => callbacksAvailable(tx, "+14155550181"))).toBe(true);
    expect(await resolveBookingRequest(token)).toMatchObject({ callbackAvailable: true });
    expect(await resolveBookingRequest(noConsent)).toMatchObject({ callbackAvailable: false });

    // A consent given to an older wording is not consent to this one.
    await inTenant(c.clinicId, (client) => client.query(`update consent_records set wording_version = 'callback-v1' where phone = '+14155550181'`));
    expect(await schedule(requestId)).toEqual({ scheduled: false, reason: "no_consent" });
    await inTenant(c.clinicId, (client) => client.query(`update consent_records set wording_version = $1 where phone = '+14155550181'`, [CALLBACK_CONSENT.version]));

    const first = await schedule(requestId);
    expect(first).toMatchObject({ scheduled: true });
    expect(await schedule(requestId)).toEqual({ scheduled: false, reason: "already_scheduled" });
    const calls = await inTenant(c.clinicId, (client) =>
      client.query<{ status: string; attempt_no: number; purpose: string; phone: string; not_before: Date; created_at: Date; consent_record_id: string }>(`select status, attempt_no, purpose, phone, not_before, created_at, consent_record_id from outbound_calls`),
    );
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]).toMatchObject({ status: "due", attempt_no: 1, purpose: "offer_alternatives", phone: "+14155550181" });
    const requestCreated = (await inTenant(c.clinicId, (client) => client.query<{ created_at: Date }>(`select created_at from booking_requests where id = $1`, [requestId]))).rows[0]!.created_at;
    expect(new Date(calls.rows[0]!.not_before).getTime()).toBeGreaterThanOrEqual(new Date(requestCreated).getTime() + 15 * 60_000 - 1000);
    expect(await resolveBookingRequest(token)).toMatchObject({ pendingCallback: { purpose: "offer_alternatives", status: "due" } });
    // The runtime role cannot delete it.
    await expect(withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => tx.db.execute(sql`delete from outbound_calls`))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied for table outbound_calls/) } });

    // A confirmed time is read back by the assistant when available (F.3) —
    // on the no-consent request nothing is queued.
    const when = new Date(Date.now() + 5 * DAY);
    const confirmedNoConsent = await decideBookingRequest(noConsent, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when }, sender);
    expect(confirmedNoConsent).toMatchObject({ outcome: "decided", callback: null, calendarWrite: "not-connected" });

    // Expiry: the request lapses, and its queued call is cancelled with it.
    expect((await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: when }] }, sender)).outcome).toBe("decided");
    await expireLapsedRequests(new Date());
    expect((await inTenant(c.clinicId, (client) => client.query<{ status: string }>(`select status from outbound_calls`))).rows).toEqual([{ status: "due" }]);
    await inTenant(c.clinicId, (client) => client.query(`update booking_requests set reschedule_expires_at = now() - interval '1 minute' where id = $1`, [requestId]));
    expect(await expireLapsedRequests(new Date())).toEqual({ expired: 1, cancelledCalls: 1 });
    expect((await inTenant(c.clinicId, (client) => client.query<{ status: string; refusal_code: string }>(`select status, refusal_code from outbound_calls`))).rows).toEqual([{ status: "cancelled", refusal_code: "request_expired" }]);

    // A stop on the thread: suppressed on every channel, consent revoked, and
    // "cancel my appointment" is not a stop.
    const token3 = await quickRequest("messenger", "823456789012345", "user-83", { name: "Ali", phone: "+14155550183", consent: true });
    const request3 = (await resolveBookingRequest(token3))!.id;
    // §F.3: with both switches on and a consent row, creation itself queued a
    // collect_fields call for the service a med-spa asks for on the phone.
    expect((await inTenant(c.clinicId, (client) => client.query<{ purpose: string; status: string }>(`select purpose, status from outbound_calls where booking_request_id = $1`, [request3]))).rows).toEqual([{ purpose: "collect_fields", status: "due" }]);
    expect(await schedule(request3, "collect_fields")).toEqual({ scheduled: false, reason: "already_scheduled" });
    __setMetaRuntimeForTests(async () => json("Of course — the practice will call you.", { wants: false }), sender, transport);
    await post(inbound("I need to cancel my appointment", "user-83", "823456789012345"));
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from suppressions`))).rows).toHaveLength(0);
    __setMetaRuntimeForTests(async () => "should not run", sender, transport);
    await post(inbound("please stop calling me", "user-83", "823456789012345"));
    expect(sent.at(-1)!.text).toBe(stopAcknowledgedLine({ clinicName: "booking-callbacks Clinic", phone: "+14155550199" }));
    const afterStop = await inTenant(c.clinicId, async (client) => ({
      suppressions: (await client.query<{ phone: string; channel: string | null; reason: string }>(`select phone, channel, reason from suppressions`)).rows,
      consent: (await client.query<{ phone: string; revoked: boolean }>(`select phone, revoked_at is not null as revoked from consent_records order by phone`)).rows,
      calls: (await client.query<{ status: string; refusal_code: string | null }>(`select status, refusal_code from outbound_calls where booking_request_id = $1`, [request3])).rows,
    }));
    expect(afterStop.suppressions).toEqual([{ phone: "+14155550183", channel: null, reason: "stop_reply" }]);
    expect(afterStop.consent).toEqual([
      { phone: "+14155550181", revoked: false },
      { phone: "+14155550183", revoked: true },
    ]);
    expect(afterStop.calls).toEqual([{ status: "cancelled", refusal_code: "stop" }]);
    expect(await schedule(request3, "collect_fields")).toEqual({ scheduled: false, reason: "no_consent" });
    expect(await resolveBookingRequest(token3)).toMatchObject({ callbackAvailable: false });
  });

  test("what a callback collects is validated against the practice's set; the re-notify is linkless; direct booking names every closed gate", async () => {
    const c = await liveClinic("booking-fields", "923456789012345");
    // A plastic-surgery practice asks for a surname, the service and the visit type.
    await getMigratorPool().query(`update clinics set specialty = 'plastic-surgery' where id = $1`, [c.clinicId]);
    const token = await quickRequest("messenger", "923456789012345", "user-91", { phone: "+14155550191" });
    const requestId = (await resolveBookingRequest(token))!.id;

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      recordCollectedFields(tx, requestId, {
        last_name: "  Lopez ",
        service: "Consultation",
        consult_or_treatment: "consultation",
        new_or_existing: "new",
        preferred_provider: "Dr Chen",
        phone: "+14155550000",
        email: "x@y.z",
        dob: "1990-01-01",
        x: "a".repeat(200),
      }),
    );
    const stored = await inTenant(c.clinicId, async (client) => ({
      fields: (await client.query<{ collected_fields: Record<string, string> }>(`select collected_fields from booking_requests where id = $1`, [requestId])).rows[0]!.collected_fields,
      refused: (await client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where metadata->>'outcome' = 'field_refused' order by metadata->>'field'`)).rows.map((r) => r.metadata),
    }));
    expect(stored.fields).toEqual({ last_name: "Lopez", service: "Consultation", consult_or_treatment: "consultation" });
    expect(stored.refused).toEqual([
      { outcome: "field_refused", field: "dob", reason: "not_required" },
      { outcome: "field_refused", field: "email", reason: "not_required" },
      { outcome: "field_refused", field: "new_or_existing", reason: "not_required" },
      { outcome: "field_refused", field: "phone", reason: "locked" },
      { outcome: "field_refused", field: "preferred_provider", reason: "not_required" },
      { outcome: "field_refused", field: "x", reason: "not_required" },
    ]);
    // A clinical value is dropped and named; a later write merges.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordCollectedFields(tx, requestId, { last_name: "Lopez-Diaz", consult_or_treatment: "treatment, I'm pregnant" }));
    expect((await inTenant(c.clinicId, (client) => client.query<{ f: Record<string, string> }>(`select collected_fields as f from booking_requests where id = $1`, [requestId]))).rows[0]!.f).toEqual({ last_name: "Lopez-Diaz", service: "Consultation", consult_or_treatment: "consultation" });
    expect(await resolveBookingRequest(token)).toMatchObject({ collectedFields: { last_name: "Lopez-Diaz", service: "Consultation" } });

    for (const variant of ["collected", "chose_none", "confirm_no"] as const) {
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => renotifyDesk(tx, requestId, variant, { transport }));
      const mail = mailed.at(-1)!.message;
      expect(mail.subject).toBe("Booking request updated — booking-fields Clinic");
      expect(mail.phiClass).toBe("none");
      expect(mail.text).not.toMatch(/https?:\/\/|Lopez|0191|Saturday/);
    }
    expect(mailed.at(-1)!.message.text).toMatch(/cancel in your calendar and treat it as a new request/);
    expect(mailed.at(-3)!.message.text).toMatch(/Open the link from the original email to accept, confirm a time, propose other times, or decline/);

    // Once decided, nothing more is collected.
    await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordCollectedFields(tx, requestId, { last_name: "Nope" }));
    expect((await inTenant(c.clinicId, (client) => client.query<{ f: Record<string, string> }>(`select collected_fields as f from booking_requests where id = $1`, [requestId]))).rows[0]!.f.last_name).toBe("Lopez-Diaz");

    // §E.1: six gates, all named, none cached.
    const check = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => directBookingAllowed(tx));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("env_off");
      expect(check.missing).toEqual([
        expect.stringMatching(/HEALDESK_DIRECT_BOOKING_ENABLED/),
        expect.stringMatching(/addendum has not been approved/),
        expect.stringMatching(/not elected direct booking/),
        expect.stringMatching(/No active, writable calendar connection/),
      ]);
    }
  });

  test("a clinic with no desk address still gets the request, and it waits in the care view", async () => {
    const c = await liveClinic("booking-nodesk", "133456789012345");
    await inTenant(c.clinicId, (client) => client.query(`delete from report_recipients`));
    await expect(quickRequest("messenger", "133456789012345", "user-13", { name: "Lee", phone: "+14155550166" })).rejects.toThrow(/no desk email/);
    expect(mailed).toHaveLength(0);
    const rows = await inTenant(c.clinicId, (client) => client.query<{ status: string; desk_notified_at: string | null }>(`select status, desk_notified_at from booking_requests`));
    expect(rows.rows).toEqual([{ status: "requested", desk_notified_at: null }]);
  });
});
