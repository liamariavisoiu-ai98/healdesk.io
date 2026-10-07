import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { directBookingAllowed } from "@/lib/booking/mode";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  cleanBookingFields,
  decideBookingRequest,
  expireLapsedRequests,
  followUpLine,
  requestReceivedLine,
  resolveBookingRequest,
} from "@/lib/meta/booking-requests";
import { collectingLine, guardReply, parseModelReply, probeVerdict, type MetaPlatform } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The booking hand-off (decisions of 21 and 23 September 2026, narrowed by
 * the v1 spec's inbound-only rule): the front door collects a first name, a
 * number, a window and up to two alternatives, and the request exists the
 * moment the three are in hand. No consent question, no WhatsApp opt-in, no
 * template, no call-back. The desk gets a single-use link and four decisions;
 * the person is told in fixed text that names no time, and only inside
 * Meta's 24-hour window.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-booking-tests";
const PAGE_ID = "223456789012345";
const DAY = 24 * 60 * 60 * 1000;

const json = (
  reply: string,
  booking: Partial<{ wants: boolean; first_name: string; phone: string; window: string; alt_windows: string[]; fields: Record<string, string> }> = {},
) => JSON.stringify({ reply, booking: { wants: false, first_name: null, phone: null, window: null, alt_windows: [], fields: {}, ...booking } });

describe("what the model may hand over", () => {
  test("a plain reply is read as a reply with no booking", () => {
    expect(parseModelReply("We're open 9 to 5. Call the practice to book.")).toEqual({
      reply: "We're open 9 to 5. Call the practice to book.",
      booking: { wants: false, first_name: null, phone: null, window: null, alt_windows: [], fields: {} },
    });
  });

  test("JSON, fenced or bare, is parsed: strings or null, alternatives and the fields — and a consent classifier is not read", () => {
    const parsed = parseModelReply(
      '```json\n{"reply":"Sure — what\'s your first name?","booking":{"wants":true,"first_name":null,"phone":"415 555 0134","window":"","alt_windows":["Thursday after 4","", 7],"callback_ok":true,"whatsapp_ok":true,"fields":{"last_name":"Lopez","bad key":"x"}}}\n```',
    );
    expect(parsed.reply).toBe("Sure — what's your first name?");
    // Inbound only: nothing asks a consent question, so nothing reads an answer to one.
    expect(parsed.booking).toEqual({ wants: true, first_name: null, phone: "415 555 0134", window: null, alt_windows: ["Thursday after 4"], fields: { last_name: "Lopez" } });
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

  test("every fixed line passes the guard, service names and promotions included, hands off to the phone and names no time", () => {
    // A practice named after what it sells, with a menu that covers the
    // words a fixed line might plausibly use.
    for (const clinicName of ["Radiance", "Lip Filler Lounge"]) {
      const context = { clinicName, serviceNames: ["Botox", "Lip filler", "Consultation", "Facial or skin treatment"] };
      for (const line of [
        requestReceivedLine(clinicName, "Maria"),
        followUpLine(clinicName, "accepted"),
        followUpLine(clinicName, "declined"),
        followUpLine(clinicName, "confirmed"),
        followUpLine(clinicName, "rescheduling"),
        collectingLine({ clinicName }, ["your first name", "a number the practice can call"]),
      ]) {
        expect(guardReply(line, context), line).toEqual({ ok: true });
        expect(probeVerdict(line, context).ok, line).toBe(true);
        expect(line).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
      }
    }
    expect(followUpLine("Radiance", "rescheduling")).not.toMatch(/monday|tuesday|wednesday|thursday|friday|saturday|sunday|dr\b/i);
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

// Every message carries its own id, as Meta's do: the webhook skips an id it
// has already handled (BD24), so a shared id would make each message after
// the first a redelivery.
const inbound = (text: string, sender = "user-77", pageId = PAGE_ID) => ({
  object: "page",
  entry: [{ id: pageId, messaging: [{ sender: { id: sender }, recipient: { id: pageId }, message: { mid: `m-${randomUUID()}`, text } }] }],
});
const inboundIg = (text: string, sender: string, igId: string) => ({
  object: "instagram",
  entry: [{ id: igId, messaging: [{ sender: { id: sender }, recipient: { id: igId }, message: { mid: `m-${randomUUID()}`, text } }] }],
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
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    mailed.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  async function liveClinic(label: string, externalId = PAGE_ID, platform: MetaPlatform = "messenger") {
    const c = await seedClinic(label);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`, [c.clinicId]);
    // A production clinic answers only with a billing row and a live channel
    // (the answer gate fails closed without them).
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
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

  /** One message with the three things: the request exists at once. Returns the desk's token. */
  async function quickRequest(platform: MetaPlatform, externalId: string, senderId: string, opts: { name?: string; phone?: string } = {}) {
    const name = opts.name ?? "Sam";
    const phone = opts.phone ?? "+14155550177";
    __setMetaRuntimeForTests(async () => json("Got it — the practice will call you.", { wants: true, first_name: name, phone, window: "Saturday afternoon" }), sender, transport);
    await post(inboundOn(platform, `${name}, ${phone}, Saturday afternoon please`, senderId, externalId));
    const clinicName = sent.at(-1)!.text.match(new RegExp(`^Thanks, ${name}! I've passed that along to (.+?), and they'll give you a call`))?.[1];
    expect(clinicName).toBeDefined();
    expect(sent.at(-1)!.text).toBe(requestReceivedLine(clinicName!, name));
    const token = mailed.at(-1)?.message.text.match(/\/booking\/([A-Za-z0-9_-]{43})/)?.[1];
    if (!token) throw new Error("no desk email carried a link");
    return token;
  }

  test("collects the three things across messages and creates the request the moment they are in hand — with the alternative, and no consent row", async () => {
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
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(0);

    // Message 3: the window arrives last, with an alternative. The three
    // things are in hand, so the request exists now, the desk is emailed, the
    // draft is gone, and the reply is the fixed line — not the model's text,
    // which promised a time. No consent question is asked first.
    __setMetaRuntimeForTests(async () => json("Great, you're all booked for Tuesday at 2pm!", { window: "any weekday morning", alt_windows: ["Thursday after 4"] }), sender, transport);
    res = await post(inbound("any weekday morning works, or Thursday after 4"));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[2]!.text).toBe(requestReceivedLine("booking Clinic", "Maria"));
    expect(sent[2]!.text).not.toMatch(/2pm|Tuesday|0134/);

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
      consent: (await client.query(`select 1 from consent_records`)).rows.length,
      contacts: (await client.query<{ phone: string; full_name: string }>(`select phone, full_name from contacts`)).rows,
      audit: (await client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at`)).rows,
    }));
    expect(stored.drafts).toBe(0);
    expect(stored.requests).toMatchObject([{ status: "requested", preferred_window: "any weekday morning", alternative_windows: ["Thursday after 4"], token_len: 32 }]);
    expect(stored.requests[0]!.desk_notified_at).not.toBeNull();
    expect(stored.requests[0]!.last_inbound_at).not.toBeNull();
    expect(stored.consent).toBe(0);
    expect(stored.contacts).toEqual([{ phone: "+14155550134", full_name: "Maria" }]);
    expect(stored.audit.map((a) => a.metadata.booking)).toEqual(["collecting", "collecting", "requested"]);
    expect(JSON.stringify(stored.audit)).not.toMatch(/Maria|0134|Thursday/);

    // The desk opens the link: the four things, and nothing else. No
    // calendar is connected, so the desk confirms in its own system.
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
      metaWindowOpen: true,
      bookedVia: "desk",
      collectedFields: {},
    });
    expect(await resolveBookingRequest("A".repeat(43))).toBeNull();
    expect(await resolveBookingRequest("not-a-token")).toBeNull();

    // Accept: one decision, relayed as the fixed line through the sealed token.
    const decided = await decideBookingRequest(token, "accepted", { decidedByLabel: "Jo at the desk", deskNote: "Thursday 10am works" }, sender);
    expect(decided).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null, calendarWrite: null });
    // The fourth message: three replies above, then this follow-up. (It was
    // the fifth while a callback-consent question sat between them; that
    // question went with the call-back dialer on 1 October 2026.)
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ platform: "messenger", externalId: PAGE_ID, recipientId: "user-77", accessToken: "EAAB-page-token-0123456789" });
    expect(sent[3]!.text).toBe(followUpLine("booking Clinic", "accepted"));
    expect(sent[3]!.text).not.toMatch(/Thursday|10am/);

    // A second decision, either way, changes nothing and sends nothing.
    expect(await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).toEqual({ outcome: "already-decided", followUp: null, appointmentId: null, calendarWrite: null });
    expect(sent).toHaveLength(4);
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

  test("one message with the three things creates the request at once; nothing else the person wrote survives, and no consent row is written", async () => {
    const c = await liveClinic("booking-redacted", "323456789012345");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Sam", phone: "+14155550177", window: "Saturday afternoon" }), sender, transport);
    await post(inbound("Sam, +1 415 555 0177, Saturday afternoon please — I'm pregnant so mornings are hard", "user-88", "323456789012345"));
    expect(sent.at(-1)!.text).toBe(requestReceivedLine("booking-redacted Clinic", "Sam"));
    const stored = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query(`select 1 from booking_requests`)).rows.length,
      consent: (await client.query(`select 1 from consent_records`)).rows.length,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
    }));
    expect(stored).toEqual({ requests: 1, consent: 0, drafts: 0 });
    const everything = await inTenant(c.clinicId, (client) => client.query<{ row: string }>(`select row_to_json(r)::text as row from booking_requests r union all select row_to_json(a)::text from audit_log a`));
    expect(everything.rows.map((r) => r.row).join("\n")).not.toMatch(/pregnant/);

    const { runOperation } = await import("@/lib/ops/api");
    const view = await runOperation("getOnboarding", { clinicId: c.clinicId }, { email: "ops@healdesk.test", request: {} });
    expect((view.body as { data: { meta: { bookingRequests: unknown } } }).data.meta.bookingRequests).toEqual({ waiting: 1, accepted: 0, confirmed: 0, declined: 0 });
  });

  test("on WhatsApp the request is created the same way: no opt-in question, and no template path exists", async () => {
    const c = await liveClinic("booking-wa", "555000111", "whatsapp");
    __setMetaRuntimeForTests(async () => json("The practice will call you.", { wants: true, first_name: "Ana", phone: "+14155550155", window: "Friday morning" }), sender, transport);
    await post(inboundWa("Ana, 415 555 0155, Friday morning", "15550100123", "555000111"));
    expect(sent.at(-1)!.text).toBe(requestReceivedLine("booking-wa Clinic", "Ana"));
    expect(sent.at(-1)!.text).not.toMatch(/WhatsApp/);
    expect(mailed).toHaveLength(1);
    expect((await inTenant(c.clinicId, (client) => client.query<{ platform: string }>(`select platform from booking_requests`))).rows).toEqual([{ platform: "whatsapp" }]);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from consent_records`))).rows).toHaveLength(0);
    // The adapter has one way to send, and it is the windowed one.
    const channels = await import("@/lib/meta/channels");
    expect(Object.keys(channels)).not.toContain("sendMetaTemplate");
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
      expect(decided).toEqual({ outcome: "decided", followUp: "outside_window", appointmentId: null, calendarWrite: null });
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

  test("propose other times: the desk's alternatives go out as a fixed line, the desk confirms the one chosen by phone, and the alternatives lapse", async () => {
    const c = await liveClinic("booking-resched", "723456789012345");
    const token = await quickRequest("messenger", "723456789012345", "user-71");
    const d1 = new Date(Date.now() + 2 * DAY);
    const d2 = new Date(Date.now() + 3 * DAY);

    // One to three future slots; a past one or none is refused before anything is read.
    expect(await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [] }, sender)).toMatchObject({ outcome: "invalid" });
    expect(await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: new Date(Date.now() - DAY) }] }, sender)).toMatchObject({ outcome: "invalid" });

    const proposed = await decideBookingRequest(token, "rescheduling", { decidedByLabel: "Jo", deskNote: "offered two", proposedSlots: [{ at: d2, source: "desk" }, { at: d1, source: "calendar" }] }, sender);
    expect(proposed).toEqual({ outcome: "decided", followUp: "sent", appointmentId: null, calendarWrite: null });
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

    // The person chooses on the desk's own call, and the desk confirms it on
    // the page: rescheduling → confirmed, an appointment row, recorded here
    // only (no writable calendar), and the fixed line on the thread.
    const chosen = await decideBookingRequest(token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: d3 }, sender);
    expect(chosen).toMatchObject({ outcome: "decided", followUp: "sent", calendarWrite: "not-connected" });
    expect(chosen.appointmentId).not.toBeNull();
    expect(await resolveBookingRequest(token)).toMatchObject({ status: "confirmed", confirmedFor: d3, decidedByLabel: "Jo" });
    expect((await inTenant(c.clinicId, (client) => client.query<{ scheduled_for: Date }>(`select scheduled_for from appointments`))).rows.map((r) => new Date(r.scheduled_for).getTime())).toEqual([Math.floor(d3.getTime() / 1000) * 1000 + (d3.getTime() % 1000)]);
    expect(await decideBookingRequest(token, "declined", { decidedByLabel: null, deskNote: null }, sender)).toMatchObject({ outcome: "already-decided" });

    // Lapse: a second request whose alternatives nobody chose.
    const token2 = await quickRequest("messenger", "723456789012345", "user-72", { name: "Kim", phone: "+14155550172" });
    expect((await decideBookingRequest(token2, "rescheduling", { decidedByLabel: "Jo", deskNote: null, proposedSlots: [{ at: d1 }] }, sender)).outcome).toBe("decided");
    // The sweep is platform-wide: flush what earlier tests left lapsed, then nothing here has.
    await expireLapsedRequests(new Date());
    expect(await expireLapsedRequests(new Date())).toEqual({ expired: 0 });
    await inTenant(c.clinicId, (client) => client.query(`update booking_requests set reschedule_expires_at = now() - interval '1 minute' where status = 'rescheduling'`));
    expect(await expireLapsedRequests(new Date())).toEqual({ expired: 1 });
    expect(await resolveBookingRequest(token2)).toMatchObject({ status: "expired", proposedSlots: [{ at: d1.toISOString() }] });
    expect(await decideBookingRequest(token2, "confirmed", { decidedByLabel: null, deskNote: null, confirmedFor: d1 }, sender)).toMatchObject({ outcome: "already-decided" });
  });

  test("a stop word on a thread is a message like any other: nothing is suppressed, because nothing is ever sent outside the conversation", async () => {
    const c = await liveClinic("booking-stop", "823456789012345");
    __setMetaRuntimeForTests(async () => json("Of course — call the practice whenever suits you.", { wants: false }), sender, transport);
    await post(inbound("please stop calling me", "user-83", "823456789012345"));
    expect(sent.at(-1)!.text).toMatch(/call the practice/);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from suppressions`))).rows).toHaveLength(0);
  });

  test("direct booking names every closed gate (§E.1)", async () => {
    const c = await liveClinic("booking-fields", "923456789012345");
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
