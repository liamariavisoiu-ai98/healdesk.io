import { randomUUID } from "node:crypto";

import { CURRENT_BAA_VERSION, metaEligible, resolveBookingRequirements } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, GET, POST } from "@/app/api/webhooks/meta/route";
import { META_CHANNEL_PROHIBITIONS, metaChannelGreeting } from "@/lib/compliance/disclosure";
import { attachMetaChannel, resolveMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  answerFrontDoor,
  buildFrontDoorPrompt,
  FRONT_DOOR_PROBES,
  guardContextFor,
  guardReply,
  handoffLine,
  probeVerdict,
} from "@/lib/meta/front-door";
import { parseMetaEvents, signMetaBody, verifyMetaSignature } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The Meta front door: a narrow agent, a deterministic guard, and a webhook
 * that stores nothing the person wrote.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-tests";
const PAGE_ID = "123456789012345";
/** A med spa's menu, as the guard is handed it. */
const SERVICES = ["Botox", "Lip filler", "Laser hair removal"];

describe("the guard", () => {
  test("lets a public answer through", () => {
    expect(guardReply("We're open Monday to Friday 9 to 5 and Saturday mornings. To book, call the practice at +1 415 555 0199 — a person can help with the rest.")).toEqual({ ok: true });
  });

  test("refuses an acknowledgement, a time, a provider, insurance, guidance, and a human claim", () => {
    const cases: [string, string][] = [
      ["Sorry to hear about your acne! We can definitely help.", "acknowledgement"],
      ["Yes, we treat rosacea — your rosacea sounds like a good fit for our laser.", "condition named back"],
      ["I've got you down for Tuesday at 2pm, see you then!", "appointment"],
      ["You'll be with Dr Chen for the consultation.", "provider"],
      ["We take Blue Cross; your copay is usually $40.", "insurance"],
      ["You should avoid filler while pregnant.", "guidance"],
      ["Side effects include bruising for a day or two.", "clinical"],
      ["Yes, I'm a real person at the front desk.", "human"],
      ["Great — we'll text you a link to book.", "a text promise"],
      ["I will message you a link shortly.", "a text promise"],
      ["", "empty"],
    ];
    for (const [reply, why] of cases) {
      const verdict = guardReply(reply);
      expect(verdict.ok, `${why}: ${reply}`).toBe(false);
    }
  });

  test("the hand-off line itself passes the guard and the probe verdict", () => {
    const line = handoffLine({ clinicName: "Radiance", phone: "+1 415 555 0199" });
    expect(guardReply(line, { clinicName: "Radiance", serviceNames: SERVICES })).toEqual({ ok: true });
    expect(probeVerdict(line, { clinicName: "Radiance", serviceNames: SERVICES })).toEqual({ ok: true, reason: null });
    expect(probeVerdict("We're open 9 to 5.")).toEqual({ ok: false, reason: "no hand-off" });
    // A practice named after what it sells can still say its own name.
    const named = handoffLine({ clinicName: "Botox Bar", phone: "+1 415 555 0199" });
    expect(guardReply(named, { clinicName: "Botox Bar", serviceNames: SERVICES })).toEqual({ ok: true });
  });

  test("refuses one of the clinic's own service names however it is written, and lets the price through without it", () => {
    // The one Meta rule, (2) and (5): Meta signs no BAA, so no treatment name
    // goes into a Meta message, even one the person wrote first.
    const context = { clinicName: "Radiance", serviceNames: SERVICES };
    for (const reply of [
      "Lip filler is $300 to $600 here — call the practice to book.",
      "Yes, we do BOTOX. Call the practice to book.",
      "The practice offers lip-filler; call to book.",
    ]) {
      expect(guardReply(reply, context), reply).toEqual({ ok: false, reason: "a treatment name" });
    }
    expect(guardReply("Yes, the practice offers that: it's $300 to $600. Call the practice to book.", context)).toEqual({ ok: true });
    // The clinic's own name is not a treatment, but a service named beside it still is.
    const bar = { clinicName: "Botox Bar", serviceNames: SERVICES };
    expect(guardReply("Thanks for messaging Botox Bar! Call the practice to book.", bar)).toEqual({ ok: true });
    expect(guardReply("Botox Bar offers Botox — call the practice to book.", bar)).toEqual({ ok: false, reason: "a treatment name" });
    // The names come from the facts: every configured service, approved or not.
    expect(guardContextFor({ clinicName: "Radiance", services: [], serviceNames: ["Lip filler"] })).toEqual({ clinicName: "Radiance", serviceNames: ["Lip filler"] });
    expect(guardContextFor({ clinicName: "Radiance", services: [{ name: "Botox", priceFromUsd: null, priceToUsd: null }] })).toEqual({ clinicName: "Radiance", serviceNames: ["Botox"] });
  });

  test("refuses a reply that names an everyday skin or hair condition, acknowledged or not", () => {
    // Meta signs no BAA, so a reply there names no condition, even one the
    // person wrote first and even without "your" in front of it.
    for (const reply of [
      "Yes, we treat rosacea — call the practice to book.",
      "Acne responds well to what the practice offers; call to book.",
      "Lots of people come to us about hair loss. Call the practice to book.",
      "Breakouts are so common! The practice can help — call to book.",
    ]) {
      expect(guardReply(reply, { clinicName: "Radiance", serviceNames: SERVICES }), reply).toEqual({
        ok: false,
        reason: "a skin or hair condition",
      });
    }
    // An acknowledgement is still named as one: the fixed patterns read first.
    expect(guardReply("Sorry to hear about your acne! Call the practice to book.")).toEqual({ ok: false, reason: "an acknowledgement" });
    // The price without the condition goes out.
    expect(guardReply("Yes, the practice offers that: it's $150. Call the practice to book.", { clinicName: "Radiance", serviceNames: SERVICES })).toEqual({ ok: true });
  });

  test("refuses promotional wording", () => {
    for (const reply of [
      "We have a 20% off special this month — call the practice to book.",
      "Use promo code GLOW at the desk!",
      "Ask about our introductory offer when you call the practice.",
      "Our monthly specials are on the website.",
    ]) {
      expect(guardReply(reply), reply).toEqual({ ok: false, reason: "a promotion" });
    }
  });

  test("the prompt forbids the four things, carries the Meta prohibitions, and lists only approved public facts", () => {
    // A plastic-surgery practice collects a surname, the service and the visit
    // type on the phone; none of those may be asked on this channel.
    const resolved = resolveBookingRequirements("plastic-surgery", null);
    const prompt = buildFrontDoorPrompt({
      clinicName: "Radiance",
      phone: "+1 415 555 0199",
      websiteHint: null,
      services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0 }],
      notes: "Free parking.",
      escalationHours: null,
      requirements: metaEligible(resolved),
      deferredRequirements: resolved.filter((f) => !f.metaEligible),
    });
    expect(prompt).toMatch(/NEVER/);
    expect(prompt).toMatch(/Acknowledge, repeat, or respond to any health condition/);
    expect(prompt).toMatch(/appointment date, time, or provider/);
    expect(prompt).toMatch(/insurance, payment status/);
    expect(prompt).toMatch(/Free parking/);
    // The one Meta rule's list, word for word: it has a caller now.
    for (const prohibition of META_CHANNEL_PROHIBITIONS) expect(prompt).toContain(prohibition);
    expect(prompt).toMatch(/Write the name of any treatment or service, even one the person named first/);
    expect(prompt).toMatch(/Mention a promotion/);
    // A service is on the menu so the model knows what was asked, with its
    // price, but it is no longer a fact the model may state.
    expect(prompt).toMatch(/- Consultation: from \$0/);
    const [, statable = ""] = prompt.split("FACTS YOU MAY STATE:");
    expect(statable.split("THE PRACTICE'S MENU")[0]).not.toMatch(/Consultation/);
    expect(prompt).toMatch(/THE PRACTICE'S MENU[^\n]*never write its name/);
    // §D.2 rule 4 and the answer format. Inbound only: nothing about call-backs
    // or WhatsApp messages is asked or classified.
    expect(prompt).toMatch(/up to two other times that could also work/);
    expect(prompt).toMatch(/"alt_windows"/);
    expect(prompt).not.toMatch(/call-back|callback_ok|whatsapp_ok/i);
    expect(prompt).toMatch(/your first name; a number the practice can call; a day or time that works best; one or two other times that could work; nothing else may be asked/);
    // A metaEligible: false field never appears, however the practice's set is configured.
    for (const field of resolved.filter((f) => !f.metaEligible)) {
      expect(prompt).not.toContain(field.ask);
      expect(prompt.toLowerCase()).not.toContain(field.label.toLowerCase());
    }
    expect(FRONT_DOOR_PROBES.length).toBeGreaterThanOrEqual(12);
    expect(FRONT_DOOR_PROBES.map((p) => p.id)).toEqual(expect.arrayContaining(["alts", "surname"]));
  });
});

describe("reading Meta's payloads", () => {
  test("Messenger and Instagram: text only, echoes dropped", () => {
    const events = parseMetaEvents({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            { sender: { id: "u1" }, recipient: { id: PAGE_ID }, message: { mid: "m1", text: "hi there" } },
            { sender: { id: PAGE_ID }, recipient: { id: "u1" }, message: { mid: "m2", text: "our reply", is_echo: true } },
            { sender: { id: "u2" }, recipient: { id: PAGE_ID }, message: { mid: "m3", attachments: [{ type: "image" }] } },
            { sender: { id: "u3" }, recipient: { id: PAGE_ID }, delivery: { mids: ["m1"] } },
          ],
        },
      ],
    });
    expect(events).toEqual([{ platform: "messenger", externalId: PAGE_ID, senderId: "u1", text: "hi there", messageId: "m1" }]);
    expect(parseMetaEvents({ object: "instagram", entry: [{ id: "ig1", messaging: [{ sender: { id: "p" }, recipient: { id: "ig1" }, message: { text: "hours?" } }] }] })[0]!.platform).toBe("instagram");
  });

  test("Meta's own message id is read on both shapes, for the redelivery check (BD24), and is absent when not sent", () => {
    const ig = parseMetaEvents({ object: "instagram", entry: [{ id: "ig1", messaging: [{ sender: { id: "p" }, recipient: { id: "ig1" }, message: { mid: "aWdfZAG1", text: "hours?" } }] }] });
    expect(ig[0]!.messageId).toBe("aWdfZAG1");
    const wa = parseMetaEvents({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "555000111" }, messages: [{ id: "wamid.HBgLMTU1NTAxMDAxMjMVAgASGBQzQTk", from: "15550100123", type: "text", text: { body: "hi" } }] } }] }],
    });
    expect(wa[0]!.messageId).toBe("wamid.HBgLMTU1NTAxMDAxMjMVAgASGBQzQTk");
    const none = parseMetaEvents({ object: "page", entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "u1" }, recipient: { id: PAGE_ID }, message: { text: "hi" } }] }] });
    expect(none[0]).not.toHaveProperty("messageId");
  });

  test("Meta's timestamp becomes sentAt, never later than now: the window starts when the person wrote", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const messenger = parseMetaEvents(
      { object: "page", entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "u1" }, recipient: { id: PAGE_ID }, timestamp: Date.parse("2026-09-29T08:00:00Z"), message: { text: "hi" } }] }] },
      now,
    );
    expect(messenger[0]!.sentAt?.toISOString()).toBe("2026-09-29T08:00:00.000Z");
    const whatsapp = parseMetaEvents(
      { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "555000111" }, messages: [{ from: "15550100123", timestamp: String(Date.parse("2026-09-30T11:00:00Z") / 1000), type: "text", text: { body: "hi" } }] } }] }] },
      now,
    );
    expect(whatsapp[0]!.sentAt?.toISOString()).toBe("2026-09-30T11:00:00.000Z");
    // A clock ahead of ours is clamped to now; nonsense is dropped.
    const ahead = parseMetaEvents({ object: "page", entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "u1" }, recipient: { id: PAGE_ID }, timestamp: Date.parse("2026-10-02T00:00:00Z"), message: { text: "hi" } }] }] }, now);
    expect(ahead[0]!.sentAt?.toISOString()).toBe(now.toISOString());
    const nonsense = parseMetaEvents({ object: "page", entry: [{ id: PAGE_ID, messaging: [{ sender: { id: "u1" }, recipient: { id: PAGE_ID }, timestamp: "soon", message: { text: "hi" } }] }] }, now);
    expect(nonsense[0]).not.toHaveProperty("sentAt");
  });

  test("WhatsApp: the phone number id is ours, the sender is theirs", () => {
    const events = parseMetaEvents({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "555000111" }, messages: [{ from: "15550100123", type: "text", text: { body: "Do you do Botox?" } }, { from: "15550100124", type: "image" }] } }] }],
    });
    expect(events).toEqual([{ platform: "whatsapp", externalId: "555000111", senderId: "15550100123", text: "Do you do Botox?" }]);
  });

  test("the signature is the app secret over the raw body, and nothing else", () => {
    const raw = JSON.stringify({ object: "page", entry: [] });
    expect(verifyMetaSignature(raw, signMetaBody(raw, APP_SECRET), APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(raw, signMetaBody(raw, "other"), APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(`${raw} `, signMetaBody(raw, APP_SECRET), APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, null, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha1=abc", APP_SECRET)).toBe(false);
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
const inbound = (text: string, pageId = PAGE_ID) => ({
  object: "page",
  entry: [{ id: pageId, messaging: [{ sender: { id: "user-42" }, recipient: { id: pageId }, message: { mid: `m-${randomUUID()}`, text } }] }],
});

describeDb("the front door, end to end", () => {
  const sent: Parameters<MetaSender>[0][] = [];
  const sender: MetaSender = async (input) => {
    sent.push(input);
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "verify-me";
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  test("the verification handshake", async () => {
    const good = await GET(new Request("http://app.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123"));
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("abc123");
    const bad = await GET(new Request("http://app.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123"));
    expect(bad.status).toBe(403);
  });

  test("a bad signature is refused before anything is read", async () => {
    __setMetaRuntimeForTests(async () => "should not run", sender);
    expect((await post(inbound("hi"), "wrong")).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("answers only a clinic whose front door is on, sends with the sealed token, and stores nothing the person wrote", async () => {
    const c = await seedClinic("meta");
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`, [c.clinicId]);
    // A production clinic answers only with a billing row and a live channel
    // (the answer gate fails closed without them).
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: "Free parking behind the building.",
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, { platform: "messenger", externalId: PAGE_ID, accessToken: "EAAB-page-token-0123456789", label: "Main page" });
    });

    const owner = await resolveMetaChannel(PAGE_ID);
    expect(owner).toMatchObject({ clinicId: c.clinicId, platform: "messenger", enabled: false });
    expect(await resolveMetaChannel("000")).toBeNull();

    // Off: nothing is answered.
    __setMetaRuntimeForTests(async () => "We're open weekdays 9 to 5; call the practice to book.", sender);
    let res = await post(inbound("what are your hours?"));
    expect(await res.json()).toEqual({ received: true, answered: 0, skipped: 1 });
    expect(sent).toHaveLength(0);

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => setMetaFrontDoor(tx, true));

    // On, a public question: the model's reply goes out through the sealed token.
    res = await post(inbound("what are your hours?"));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ platform: "messenger", externalId: PAGE_ID, accessToken: "EAAB-page-token-0123456789", recipientId: "user-42" });
    expect(sent[0]!.text).toMatch(/9 to 5/);

    // A reply that acknowledges a condition is replaced by the hand-off line.
    // The message names none, so the screen lets it through to the model: one
    // that did ("I have terrible acne") would never reach it
    // (tests/meta-screen-and-greeting.test.ts).
    __setMetaRuntimeForTests(async () => "Sorry to hear about your acne! Dr Chen can see you Tuesday at 2pm.", sender);
    res = await post(inbound("My skin has been awful lately, can you fix it?"));
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent[1]!.text).toMatch(/isn't secure for health details/);
    expect(sent[1]!.text).not.toMatch(/acne|Chen|2pm/);

    // No model configured: the hand-off line, every time.
    __setMetaRuntimeForTests(null, sender);
    await post(inbound("hello?"));
    expect(sent[2]!.text).toMatch(/isn't secure for health details/);

    // Nothing the person wrote is anywhere in the clinic's data.
    const stored = await inTenant(c.clinicId, async (client) => {
      const convos = await client.query(`select id from conversations`);
      const contacts = await client.query(`select id from contacts`);
      const audit = await client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply'`);
      const events = await client.query(`select id from webhook_events`);
      const refs = await client.query<{ ref: string }>(
        `select party_ref as ref from chat_threads union all select message_ref from meta_inbound_messages union all select source_ref from usage_events`,
      );
      return { convos: convos.rows.length, contacts: contacts.rows.length, audit: audit.rows, events: events.rows.length, refs: refs.rows.map((r) => r.ref) };
    });
    expect(stored.convos).toBe(0);
    expect(stored.contacts).toBe(0);
    expect(stored.events).toBe(0);
    // The thread, the handled messages and the counted conversation are
    // references only: three messages, one conversation.
    expect(stored.refs).toHaveLength(1 + 3 + 1);
    for (const ref of stored.refs) expect(ref).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(stored.audit).toHaveLength(3);
    expect(stored.audit.map((a) => a.metadata.source)).toEqual(["model", "handoff", "handoff"]);
    expect(stored.audit[1]!.metadata.guarded).toBe("an acknowledgement");
    expect(JSON.stringify(stored.audit)).not.toMatch(/acne|awful|hours\?/);
  });

  test("a reply naming one of the clinic's services is replaced by the hand-off line, approved or not; the price without the name goes out", async () => {
    const pageId = "423456789012345";
    const c = await seedClinic("meta-names");
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`, [c.clinicId]);
    // A production clinic answers only with a billing row and a live Meta
    // channel: the answer gate fails closed without them.
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
    const config = {
      greeting: "Hi",
      services: [{ name: "Lip filler", priceFromUsd: 300, priceToUsd: 600, durationMinutes: 30 }],
      escalationPhone: null,
      escalationHours: null,
      notes: null,
    };
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550198" });
      await updateAgentConfig(tx, config);
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, { platform: "messenger", externalId: pageId, accessToken: "EAAB-page-token-9876543210" });
      await setMetaFrontDoor(tx, true);
    });

    // The person names it; the model repeats it; the guard replaces the reply
    // exactly as it replaces any other refused one. It is the thread's first
    // reply, so the greeting opens it.
    __setMetaRuntimeForTests(async () => "Lip filler is $300 to $600 — call the practice to book.", sender);
    await post(inbound("how much are lip fillers?", pageId));
    const greeting = metaChannelGreeting({ clinicName: "meta-names Clinic", channel: "messenger" });
    expect(sent[0]!.text).toBe(`${greeting} ${handoffLine({ clinicName: "meta-names Clinic", phone: "+14155550198" })}`);

    // The price without the name is what the prompt asks for, and it goes out.
    __setMetaRuntimeForTests(async () => "That's $300 to $600 — call the practice to book.", sender);
    await post(inbound("how much are lip fillers?", pageId));
    expect(sent[1]!.text).toBe("That's $300 to $600 — call the practice to book.");

    // An edit clears the approval, so the menu is no longer stated, but the
    // name is refused all the same: refusing needs no approval.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => updateAgentConfig(tx, config));
    __setMetaRuntimeForTests(async () => "Yes, we do lip filler — call the practice to book.", sender);
    await post(inbound("do you do lip filler?", pageId));
    expect(sent[2]!.text).toMatch(/isn't secure for health details/);

    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at`),
    );
    expect(audit.rows.map((a) => a.metadata.guarded ?? null)).toEqual(["a treatment name", null, "a treatment name"]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/lip/i);
  });

  test("the switch refuses a synthetic clinic, one with no phone to hand off to, and one whose agreement in effect is not released (BAA 1.3.0 gate 19)", async () => {
    const { runOperation } = await import("@/lib/ops/api");
    const operator = { email: "ops@healdesk.test", request: {} };
    const c = await seedClinic("meta-switch");
    const turnOn = async () =>
      (await runOperation("setMetaFrontDoor", { clinicId: c.clinicId, enabled: true }, operator)).body as {
        data: { status: string; message?: string };
      };
    const bind = (version: string, acceptedAt: string) =>
      getMigratorPool().query(
        `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, repeat('b', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@meta-switch.test', $3::timestamptz, now())`,
        [c.organizationId, version, acceptedAt],
      );
    // clinics is not FORCEd, so the row is picked by id, never by the tenant alone.
    const doorOn = async () =>
      (
        await getMigratorPool().query<{ on: boolean }>(`select meta_front_door_enabled as on from clinics where id = $1`, [
          c.clinicId,
        ])
      ).rows[0]!.on;

    expect((await turnOn()).data.message).toMatch(/Go live first/);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`, [c.clinicId]);
    expect((await turnOn()).data.message).toMatch(/published number/);
    await getMigratorPool().query(`update clinics set published_phone_e164 = '+14155550123' where id = $1`, [c.clinicId]);

    // No agreement in effect, then an unreleased draft in effect: refused.
    expect((await turnOn()).data.message).toMatch(/agreement in effect must be a released version/);
    await bind("1.3.0", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    expect((await turnOn()).data.message).toMatch(/agreement in effect must be a released version/);
    expect(await doorOn()).toBe(false);

    // A released version in effect: switched on.
    await bind(CURRENT_BAA_VERSION, new Date().toISOString());
    expect((await turnOn()).data.status).toBe("updated");
    expect(await doorOn()).toBe(true);
  });

  test("answerFrontDoor returns null for a clinic whose door is off", async () => {
    const c = await seedClinic("meta-off");
    const answer = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, { platform: "whatsapp", text: "hi", responder: async () => "hello" }),
    );
    expect(answer).toBeNull();
  });
});
