import { randomUUID } from "node:crypto";

import { CURRENT_BAA_VERSION, metaEligible, resolveBookingRequirements } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, GET, POST } from "@/app/api/webhooks/meta/route";
import { setMetaPlatformEnabled } from "@/lib/channels/meta-platforms";
import { META_CHANNEL_PROHIBITIONS, metaChannelGreeting } from "@/lib/compliance/disclosure";
import { attachMetaChannel, resolveMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  answerFrontDoor,
  buildFrontDoorPrompt,
  FRONT_DOOR_PROBES,
  guardContextFor,
  guardReply,
  handoffLine,
  NEVER_SAY_HEADING,
  probeVerdict,
} from "@/lib/meta/front-door";
import { parseMetaEvents, signMetaBody, verifyMetaSignature } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { neverSayWithDefaults } from "@/lib/setup/knowledge";
import { withTenant } from "@/lib/tenant";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedEntitled, setWeekdayHours } from "./setup/factories";
import { attestPlatform } from "./setup/platform";

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
  test("lets a public answer through, its hours among the clinic's own opening and closing times", () => {
    // 9:00 and 17:00, the clinic's published hours (FrontDoorFacts.publishedTimes).
    expect(guardReply("We're open Monday to Friday 9 to 5 and Saturday mornings. To book, call the practice at +1 415 555 0199 — a person can help with the rest.", { publishedTimes: [540, 1020] })).toEqual({ ok: true });
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
    expect(probeVerdict("We're open 9 to 5.", { publishedTimes: [540, 1020] })).toEqual({ ok: false, reason: "no hand-off" });
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
    expect(guardContextFor({ clinicName: "Radiance", services: [], serviceNames: ["Lip filler"] })).toEqual({ clinicName: "Radiance", serviceNames: ["Lip filler"], publishedTimes: [] });
    expect(guardContextFor({ clinicName: "Radiance", services: [{ name: "Botox", priceFromUsd: null, priceToUsd: null }], publishedTimes: [540] })).toEqual({ clinicName: "Radiance", serviceNames: ["Botox"], publishedTimes: [540] });
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

  test("refuses a phrase on the clinic's never-say list, as a call and a web chat do, however it is written, and checks it last", () => {
    // CLAUDE.md, "Guardrails": the never-say list goes into every
    // conversation on every channel. The built-in defaults, then the clinic's own.
    const facts = { clinicName: "Radiance", services: [], serviceNames: SERVICES, publishedTimes: [540, 1020] };
    const listed = guardContextFor({ ...facts, neverSay: neverSayWithDefaults(["cheapest in town", "best-kept secret", "you'll love it"]) });
    for (const reply of [
      // Each passes every other check: only the list refuses it.
      "We're the cheapest in town, so do call the practice.",
      "It's painless, call the practice to book.",
      // In another case, with a curly apostrophe, with another dash, across a line break.
      "We're the CHEAPEST in Town, so do call the practice.",
      "You’ll love it! Call the practice to book.",
      "We're the best–kept secret around: call the practice to book.",
      "We're the cheapest\nin town, so call the practice to book.",
    ]) {
      expect(guardReply(reply, guardContextFor(facts)), reply).toEqual({ ok: true });
      expect(guardReply(reply, listed), reply).toEqual({ ok: false, reason: "a never-say phrase" });
      expect(guardReply(reply, { ...listed, neverSay: [] }), reply).toEqual({ ok: true });
    }
    // Last of the checks: a reply refused for something else keeps its own
    // reason in the audit row, "guaranteed results" a default entry or not.
    expect(guardReply("We offer guaranteed results; call the practice.", listed)).toEqual({ ok: false, reason: "a results guarantee" });
    expect(guardReply("Sorry to hear that! We're the cheapest in town.", listed)).toEqual({ ok: false, reason: "an acknowledgement" });
    // A public answer still goes out.
    expect(guardReply("We're open weekdays 9 to 5; call the practice to book.", listed)).toEqual({ ok: true });
    // The context carries a list only when there is one, so the shapes above hold.
    expect(listed.neverSay).toEqual([...neverSayWithDefaults(), "cheapest in town", "best-kept secret", "you'll love it"]);
    expect(guardContextFor({ ...facts, neverSay: [] })).not.toHaveProperty("neverSay");
  });

  test("answers \"are you a real person?\" honestly: the question's words are not an echo, and no list entry can refuse the answer", () => {
    // The disclosure when someone asks is the model's, after the greeting:
    // refused, it would become the hand-off line, which never says AI.
    const facts = { clinicName: "Radiance", services: [], serviceNames: SERVICES, publishedTimes: [540, 1020] };
    const listed = guardContextFor({ ...facts, neverSay: neverSayWithDefaults(["automated assistant", "AI", "cheapest in town"]) });
    for (const [inbound, reply] of [
      ["Are you a real person?", "No, I'm an automated assistant, not a real person. Call the practice and someone on the team can help."],
      ["Am I talking to a human or a robot?", "I'm an AI assistant, not a human. Call the practice and someone on the team can help."],
      ["is this a chatbot or a person", "Yes, I'm an automated assistant, not a person. Call the practice and someone on the team can help."],
    ] as const) {
      expect(guardReply(reply, { ...listed, inbound }), reply).toEqual({ ok: true });
    }
    // A claim to be human is still refused, and so is the person's own word that is not about who answers.
    expect(guardReply("Yes, I'm a real person here at the practice.", { ...listed, inbound: "Are you a real person?" })).toEqual({ ok: false, reason: "a human claim" });
    expect(guardReply("I'm an automated assistant; call the practice about your eczema.", { ...listed, inbound: "Are you a real person? I have eczema" })).not.toEqual({ ok: true });
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
      neverSay: [],
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

  test("the prompt asks for no greeting: the code opens a first reply with the channel's, so the model starts with the substance (BAA 1.3.0 gate 20)", () => {
    const resolved = resolveBookingRequirements("med-spa", null);
    const prompt = buildFrontDoorPrompt({
      clinicName: "Radiance",
      phone: "+1 415 555 0199",
      websiteHint: "radiance.example",
      services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0 }],
      notes: null,
      escalationHours: null,
      requirements: metaEligible(resolved),
      deferredRequirements: resolved.filter((f) => !f.metaEligible),
      neverSay: [],
    });
    expect(prompt).not.toContain("Greet the person warmly and briefly");
    // The one line that speaks of greeting or introducing forbids both, and says why.
    const greetingLines = prompt.split("\n").filter((line) => /\bgreet|\bintroduc/i.test(line));
    expect(greetingLines).toEqual([
      '1. Start your reply with the substance. Never greet the person (no "Hi", "Hello" or "Hey"), and never introduce yourself or say what you are unless they ask: the code puts the channel\'s opening line in front of your reply wherever one is owed, and that line already greets them and says you are an AI assistant.',
    ]);
    // The rest of the list stands as it was: rule 1 changed, 2 to 4 did not.
    const rules = prompt.split("\n").filter((line) => /^\d\. /.test(line));
    expect(rules.map((line) => line.slice(0, 3))).toEqual(["1. ", "2. ", "3. ", "4. "]);
    expect(rules[1]).toBe("2. Answer PUBLIC questions from the facts below: hours, location, parking, and whether the practice offers something the person asks about and its published price, without ever naming it.");
    expect(rules[2]).toBe("3. Move the person to a secure channel to discuss anything personal: the phone (+1 415 555 0199) or the website (radiance.example).");
    expect(prompt).toContain("- Claim to be human. If asked, say you are an automated assistant.");
  });

  test("the prompt lists the clinic's never-say list after the Meta prohibitions, which stay word for word, and changes nothing else", () => {
    const resolved = resolveBookingRequirements("med-spa", null);
    const base = {
      clinicName: "Radiance",
      phone: "+1 415 555 0199",
      websiteHint: "radiance.example",
      services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0 }],
      notes: "Free parking.",
      escalationHours: null,
      requirements: metaEligible(resolved),
      deferredRequirements: resolved.filter((f) => !f.metaEligible),
    };
    const list = neverSayWithDefaults(["cheapest in town"]);
    const without = buildFrontDoorPrompt({ ...base, neverSay: [] });
    const prompt = buildFrontDoorPrompt({ ...base, neverSay: list });
    // An empty list adds no heading.
    expect(without).not.toContain(NEVER_SAY_HEADING);
    expect(without).not.toMatch(/never-say/i);
    // Under its heading, one line an entry: the defaults, then the clinic's own.
    const lines = prompt.split("\n");
    const at = lines.indexOf(NEVER_SAY_HEADING);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 1 + list.length)).toEqual(list.map((p) => `- ${p}`));
    expect(list.at(-1)).toBe("cheapest in town");
    // The one Meta rule's list is there word for word and in order, and the
    // never-say list comes after it.
    const prohibitions = META_CHANNEL_PROHIBITIONS.map((p) => `- ${p}`);
    const first = lines.indexOf(prohibitions[0]!);
    expect(lines.slice(first, first + prohibitions.length)).toEqual(prohibitions);
    expect(at).toBeGreaterThan(first + prohibitions.length - 1);
    // Nothing else moves: rules 1 to 4, the prohibitions and the facts are
    // the same lines as without the list.
    expect(lines.filter((_, i) => i < at || i > at + list.length)).toEqual(without.split("\n"));
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
    // The vendors' agreements in force, as a launched platform holds them
    // (the answer gate reads them, lib/compliance/vendor-coverage.ts).
    await attestPlatform(COVERAGE_VENDORS);
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
    await bindAgreementInEffect(c.clinicId);
    await setWeekdayHours(c.clinicId);
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
    expect(owner).toMatchObject({ clinicId: c.clinicId, platform: "messenger", enabled: false, platformEnabled: true });
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

  test("each platform answers on its own switch, beneath the front door: a platform switched Off is skipped before anything is claimed, counted or answered", async () => {
    const IG = "17841400000000001";
    const PAGE = "523456789012345";
    const WA = "106540352242922";
    const c = await seedClinic("meta-platforms");
    await bindAgreementInEffect(c.clinicId);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`, [c.clinicId]);
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550197" });
      await attachMetaChannel(tx, { platform: "messenger", externalId: PAGE, accessToken: "EAAB-page-token-1111111111" });
      await attachMetaChannel(tx, { platform: "instagram", externalId: IG, accessToken: "EAAB-ig-token-22222222222" });
      await attachMetaChannel(tx, { platform: "whatsapp", externalId: WA, accessToken: "EAAB-wa-token-33333333333" });
      await setMetaFrontDoor(tx, true);
    });
    const instagram = (text: string) => ({
      object: "instagram",
      entry: [{ id: IG, messaging: [{ sender: { id: "ig-user-7" }, recipient: { id: IG }, message: { mid: `m-${randomUUID()}`, text } }] }],
    });
    const whatsapp = (text: string) => ({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ value: { metadata: { phone_number_id: WA }, messages: [{ type: "text", from: "14155550111", id: `wamid-${randomUUID()}`, text: { body: text } }] } }] }],
    });
    const handled = async () =>
      inTenant(c.clinicId, async (client) => (await client.query<{ n: number }>(`select count(*)::int as n from meta_inbound_messages`)).rows[0]!.n);
    const switchTo = (platform: "instagram" | "messenger" | "whatsapp", on: boolean) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => setMetaPlatformEnabled(tx, platform, on, "Front desk Mac"));
    __setMetaRuntimeForTests(async () => "We're open weekdays 9 to 5; call the practice to book.", sender);

    // All three On, the default: each platform is answered.
    for (const body of [inbound("hours?", PAGE), instagram("hours?"), whatsapp("hours?")]) {
      expect(await (await post(body)).json()).toEqual({ received: true, answered: 1, skipped: 0 });
    }
    expect(sent.map((m) => m.platform)).toEqual(["messenger", "instagram", "whatsapp"]);
    expect(await handled()).toBe(3);

    // Instagram Off: its message is skipped before it is claimed, so nothing
    // of it is kept; Messenger and WhatsApp still answer.
    await switchTo("instagram", false);
    expect(await resolveMetaChannel(IG)).toMatchObject({ platform: "instagram", enabled: true, platformEnabled: false });
    expect(await resolveMetaChannel(PAGE)).toMatchObject({ platform: "messenger", enabled: true, platformEnabled: true });
    expect(await (await post(instagram("hours?"))).json()).toEqual({ received: true, answered: 0, skipped: 1 });
    expect(await handled()).toBe(3);
    expect(await (await post(inbound("hours?", PAGE))).json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(await (await post(whatsapp("hours?"))).json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(sent.map((m) => m.platform)).toEqual(["messenger", "instagram", "whatsapp", "messenger", "whatsapp"]);

    // answerFrontDoor holds the switch for any caller, not only the webhook.
    const direct = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => ({
      instagram: await answerFrontDoor(tx, { platform: "instagram", text: "hi", responder: async () => "Call the practice to book." }),
      whatsapp: await answerFrontDoor(tx, { platform: "whatsapp", text: "hi", responder: async () => "Call the practice to book." }),
    }));
    expect(direct.instagram).toBeNull();
    expect(direct.whatsapp).not.toBeNull();

    // Instagram back On, but the operator's front door shut: every platform
    // is skipped. The clinic's switches never open what the door has shut.
    await switchTo("instagram", true);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => setMetaFrontDoor(tx, false));
    for (const body of [inbound("hours?", PAGE), instagram("hours?"), whatsapp("hours?")]) {
      expect(await (await post(body)).json()).toEqual({ received: true, answered: 0, skipped: 1 });
    }
    expect(sent).toHaveLength(5);
  });

  test("a reply naming one of the clinic's services is replaced by the hand-off line, approved or not; the price without the name goes out", async () => {
    const pageId = "423456789012345";
    const c = await seedClinic("meta-names");
    await bindAgreementInEffect(c.clinicId);
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
    await bind("1.1.0-draft", new Date(Date.now() - 60 * 60 * 1000).toISOString());
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
