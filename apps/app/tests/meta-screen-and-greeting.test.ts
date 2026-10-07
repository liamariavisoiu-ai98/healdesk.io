import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { updateClinicSettings } from "@/lib/billing/settings";
import { metaChannelGreeting, type Channel } from "@/lib/compliance/disclosure";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  FRONT_DOOR_PROBES,
  answerFrontDoor,
  guardReply,
  handoffLine,
  screenInbound,
  urgentLine,
  type FrontDoorResponder,
  type MetaPlatform,
} from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Release gate 4 of BAA 1.3.0 (docs/counsel/agreement-changes.md §12.14,
 * PT-12 and PT-13), held in code.
 *
 * Clause 16 promises: "healdesk checks each message a person sends there for
 * clinical content before the language model sees it, and keeps none,
 * repeats none and carries none into a summary", and "Its first reply in
 * each conversation says that it is an AI assistant and that the channel is
 * not secure". So: a clinical message gets the fixed hand-off line, an
 * urgent one the fixed urgent line, neither reaches the model or any table,
 * and the first reply of each conversation, on every Meta platform, opens
 * with metaChannelGreeting() while no later one does.
 *
 * The rule for "conversation" is lib/meta/greeting.ts's: a message sent
 * more than 24 hours after the person's previous one starts a new
 * conversation, and its reply greets again.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-screen-tests";
const PUBLISHED = "+14155550142";
const DIRECT = "+14155550143";
const HOUR = 60 * 60 * 1000;

const greetingFor = (clinicName: string, platform: MetaPlatform) =>
  metaChannelGreeting({
    clinicName,
    channel: (platform === "instagram" ? "instagram_dm" : platform) satisfies Channel,
  });

const modelJson = (reply: string, booking: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply,
    booking: {
      wants: false,
      first_name: null,
      phone: null,
      window: null,
      alt_windows: [],
      fields: {},
      ...booking,
    },
  });

describe("the screen, before any model", () => {
  test("an urgent message is screened as urgent even where it is clinical too; a clinical one as clinical; a public question passes", () => {
    const symptom = FRONT_DOOR_PROBES.find((p) => p.id === "symptom")!.text;
    expect(screenInbound(symptom)).toBe("urgent");
    expect(screenInbound("I think I'm having an allergic reaction to the filler")).toBe("urgent");
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "safety")!.text)).toBe("clinical");
    expect(screenInbound("How many units do I need for my forehead?")).toBe("clinical");
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "hours")!.text)).toBeNull();
    expect(screenInbound("How much is it per unit?")).toBeNull();
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "request")!.text)).toBeNull();
  });

  test("the urgent line says it is an AI assistant, sends an emergency to 911 and gives the clinic's direct line, else its published one", () => {
    const direct = urgentLine({ clinicName: "Radiance", phone: PUBLISHED, urgentPhone: DIRECT });
    expect(direct).toBe(
      `I'm an AI assistant, so I can't help with anything urgent here. If this is an emergency, call 911 now. Otherwise, please call Radiance on ${DIRECT}.`,
    );
    expect(urgentLine({ clinicName: "Radiance", phone: PUBLISHED, urgentPhone: null })).toMatch(
      new RegExp(`call Radiance on \\${PUBLISHED}\\.$`),
    );
    expect(urgentLine({ clinicName: "Radiance", phone: PUBLISHED })).toMatch(
      new RegExp(`call Radiance on \\${PUBLISHED}\\.$`),
    );
    expect(urgentLine({ clinicName: "Radiance", phone: null, urgentPhone: null })).toMatch(
      /call Radiance\.$/,
    );
    // It promises nothing that is not built: no "I've told the team" until
    // the urgent alert sends something.
    expect(direct).not.toMatch(/told|let .* know|alerted|someone will/i);
    // Like every fixed Meta line, it passes the reply guard, service names included.
    expect(
      guardReply(direct, { clinicName: "Radiance", serviceNames: ["Botox", "Lip filler"] }),
    ).toEqual({ ok: true });
  });

  test("the greeting trips the reply guard on its own, which is why it goes in front of a reply the guard has already passed", () => {
    expect(guardReply(greetingFor("Radiance", "messenger"))).toEqual({
      ok: false,
      reason: "guidance",
    });
  });
});

const messengerEvent = (text: string, sender: string, pageId: string) => ({
  object: "page",
  entry: [
    {
      id: pageId,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: pageId },
          message: { mid: `m-${randomUUID()}`, text },
        },
      ],
    },
  ],
});
const instagramEvent = (text: string, sender: string, igId: string) => ({
  object: "instagram",
  entry: [
    {
      id: igId,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: igId },
          message: { mid: `m-${randomUUID()}`, text },
        },
      ],
    },
  ],
});
const whatsappEvent = (text: string, from: string, phoneNumberId: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: phoneNumberId },
            messages: [{ id: `wamid.${randomUUID()}`, from, type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});
const eventOn = (platform: MetaPlatform, text: string, sender: string, externalId: string) =>
  platform === "messenger"
    ? messengerEvent(text, sender, externalId)
    : platform === "instagram"
      ? instagramEvent(text, sender, externalId)
      : whatsappEvent(text, sender, externalId);

function post(body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  return POST(
    new Request("http://app.test/api/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signMetaBody(raw, APP_SECRET),
      },
      body: raw,
    }),
  );
}

/**
 * Every row the clinic's tenant can see, in every table the migrator can
 * read, that contains any of `needles`. Named as "schema.table: needle".
 */
async function rowsContaining(clinicId: string, needles: string[]): Promise<string[]> {
  return inTenant(clinicId, async (client) => {
    const { rows: tables } = await client.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name
         from information_schema.tables
        where table_type = 'BASE TABLE'
          and table_schema not in ('pg_catalog', 'information_schema')
          and has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'SELECT')`,
    );
    expect(tables.length).toBeGreaterThan(50);
    const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
    const hits: string[] = [];
    for (const table of tables) {
      const { rows } = await client.query<{ row: string }>(
        `select row_to_json(r)::text as row from ${quote(table.schema)}.${quote(table.name)} r where row_to_json(r)::text ilike any($1::text[])`,
        [needles.map((n) => `%${n}%`)],
      );
      for (const { row } of rows) {
        for (const needle of needles) {
          if (row.toLowerCase().includes(needle.toLowerCase()))
            hits.push(`${table.schema}.${table.name}: ${needle}`);
        }
      }
    }
    return hits;
  });
}

describeDb("the screen and the greeting, end to end", () => {
  const sent: Parameters<MetaSender>[0][] = [];
  const sender: MetaSender = async (input) => {
    sent.push(input);
  };
  const transport: EmailTransport = {
    name: "capture",
    async send() {
      return { status: "sent", messageId: "m-1" };
    },
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  /**
   * A clinic with its front door on and one channel per entry of `channels`.
   * Synthetic, as every fixture is: the ops switch's refusal of a synthetic
   * clinic is the operation's own rule (meta-front-door.test.ts), and nothing
   * on the answering path reads the classification.
   */
  async function doorOpen(
    label: string,
    channels: { platform: MetaPlatform; externalId: string }[],
    opts: { directLine?: string } = {},
  ) {
    const c = await seedClinic(label);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED });
      if (opts.directLine)
        await updateClinicSettings(tx, { directLineE164: opts.directLine }, "test");
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Lip filler", priceFromUsd: 300, priceToUsd: 600, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      for (const ch of channels) {
        await attachMetaChannel(tx, {
          platform: ch.platform,
          externalId: ch.externalId,
          accessToken: `EAAB-${ch.platform}-token-0123456789`,
        });
      }
      await setMetaFrontDoor(tx, true);
    });
    return { ...c, clinicName: `${label} Clinic` };
  }

  async function frontDoorAudit(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at, id`,
      ),
    );
    return rows.map((r) => r.metadata);
  }

  test("a clinical message never reaches the model, gets the hand-off line, and leaves nothing of its text in any table", async () => {
    const pageId = "910000000000001";
    const c = await doorOpen("screen-clinical", [{ platform: "messenger", externalId: pageId }]);
    const responder = vi.fn<FrontDoorResponder>(async () =>
      modelJson("The practice will call you.", {
        wants: true,
        first_name: "Zephyrine",
        phone: "+14155550144",
        window: "Saturday afternoon",
      }),
    );
    __setMetaRuntimeForTests(responder, sender, transport);

    // The three booking things and a pregnancy in one message: the screen
    // catches the pregnancy, so none of it is extracted, drafted or kept.
    const res = await post(
      messengerEvent(
        "Zephyrine, +1 415 555 0144, Saturday afternoon please — I'm pregnant so mornings are hard",
        "user-c1",
        pageId,
      ),
    );
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(responder).not.toHaveBeenCalled();
    const handoff = handoffLine({ clinicName: c.clinicName, phone: PUBLISHED });
    // The thread's first reply: the greeting, then the fixed line, which
    // moves the person to a call and says why in one sentence.
    expect(sent.map((s) => s.text)).toEqual([
      `${greetingFor(c.clinicName, "messenger")} ${handoff}`,
    ]);
    expect(handoff).toMatch(
      /This channel isn't secure for health details, so I can't go into anything personal here\./,
    );

    // A later clinical message on the same thread: the same line, no greeting.
    await post(
      messengerEvent("Is it safe with my blood thinners? Zephyrine again", "user-c1", pageId),
    );
    expect(responder).not.toHaveBeenCalled();
    expect(sent.map((s) => s.text)).toEqual([
      `${greetingFor(c.clinicName, "messenger")} ${handoff}`,
      handoff,
    ]);

    expect(
      await rowsContaining(c.clinicId, [
        "Zephyrine",
        "pregnant",
        "4155550144",
        "555 0144",
        "thinners",
        "user-c1",
      ]),
    ).toEqual([]);
    const stored = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query(`select 1 from booking_requests`)).rows.length,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
      contacts: (await client.query(`select 1 from contacts`)).rows.length,
      conversations: (await client.query(`select 1 from conversations`)).rows.length,
    }));
    expect(stored).toEqual({ requests: 0, drafts: 0, contacts: 0, conversations: 0 });
    // The audit row says the screen answered, never what it caught.
    const audit = await frontDoorAudit(c.clinicId);
    expect(audit).toEqual([
      { platform: "messenger", source: "handoff", screened: "clinical", greeted: true },
      { platform: "messenger", source: "handoff", screened: "clinical" },
    ]);
  }, 60_000);

  test("an urgent message gets the urgent line without the model, and a half-collected request is left as it was", async () => {
    const pageId = "910000000000002";
    const c = await doorOpen("screen-urgent", [{ platform: "messenger", externalId: pageId }], {
      directLine: DIRECT,
    });

    // First, the person starts a booking request: the model's reply, with a name.
    const responder = vi.fn<FrontDoorResponder>(async () =>
      modelJson("Happy to pass a request on — what's the best number to call you on?", {
        wants: true,
        first_name: "Odalys",
      }),
    );
    __setMetaRuntimeForTests(responder, sender, transport);
    await post(messengerEvent("Hi, I'd like to book something. I'm Odalys.", "user-u1", pageId));
    expect(responder).toHaveBeenCalledTimes(1);
    const draftBefore = await inTenant(c.clinicId, (client) =>
      client.query(
        `select first_name, phone, preferred_window, alternative_windows from meta_booking_drafts`,
      ),
    );
    expect(draftBefore.rows).toEqual([
      { first_name: "Odalys", phone: null, preferred_window: null, alternative_windows: [] },
    ]);

    // Then something urgent: no model, the fixed urgent line with 911 and the
    // clinic's direct line, and no greeting, because it is not the first reply.
    const symptom = FRONT_DOOR_PROBES.find((p) => p.id === "symptom")!.text;
    await post(messengerEvent(`${symptom} My number is 415 555 0145.`, "user-u1", pageId));
    expect(responder).toHaveBeenCalledTimes(1);
    const urgent = urgentLine({ clinicName: c.clinicName, phone: PUBLISHED, urgentPhone: DIRECT });
    expect(sent.at(-1)!.text).toBe(urgent);
    expect(urgent).toMatch(/If this is an emergency, call 911 now\./);
    expect(urgent).toContain(DIRECT);

    // The draft is exactly as it was: the urgent message's number is not in it.
    const draftAfter = await inTenant(c.clinicId, (client) =>
      client.query(
        `select first_name, phone, preferred_window, alternative_windows from meta_booking_drafts`,
      ),
    );
    expect(draftAfter.rows).toEqual(draftBefore.rows);
    expect(
      await rowsContaining(c.clinicId, ["swelling", "4155550145", "555 0145", "yesterday"]),
    ).toEqual([]);
    expect(
      (await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows,
    ).toHaveLength(0);

    // On a new thread the urgent line is the first reply, so it opens with the greeting.
    await post(messengerEvent("I can't breathe properly since the injection", "user-u2", pageId));
    expect(sent.at(-1)!.text).toBe(`${greetingFor(c.clinicName, "messenger")} ${urgent}`);
    expect(responder).toHaveBeenCalledTimes(1);

    const audit = await frontDoorAudit(c.clinicId);
    expect(audit).toEqual([
      { platform: "messenger", source: "model", greeted: true, booking: "collecting" },
      { platform: "messenger", source: "urgent", screened: "urgent" },
      { platform: "messenger", source: "urgent", screened: "urgent", greeted: true },
    ]);
  }, 60_000);

  test("the first reply on a thread opens with the greeting and the second does not, on Instagram, Messenger and WhatsApp", async () => {
    const channels: { platform: MetaPlatform; externalId: string }[] = [
      { platform: "instagram", externalId: "17841400000000003" },
      { platform: "messenger", externalId: "910000000000003" },
      { platform: "whatsapp", externalId: "555000903" },
    ];
    const c = await doorOpen("screen-greeting", channels);
    const reply = "We're open weekdays 9 to 5 — call the practice to book.";
    const responder = vi.fn<FrontDoorResponder>(async () => modelJson(reply));
    __setMetaRuntimeForTests(responder, sender, transport);

    for (const { platform, externalId } of channels) {
      // The same person on each platform: one thread per platform.
      const person = platform === "whatsapp" ? "15550100903" : "person-903";
      sent.length = 0;
      await post(eventOn(platform, "What are your opening hours?", person, externalId));
      await post(eventOn(platform, "And do you have parking?", person, externalId));
      await post(eventOn(platform, "Thanks!", person, externalId));
      expect(
        sent.map((s) => s.text),
        platform,
      ).toEqual([`${greetingFor(c.clinicName, platform)} ${reply}`, reply, reply]);
      expect(sent.every((s) => s.platform === platform && s.recipientId === person)).toBe(true);

      // Someone else on the same platform is a thread of their own.
      sent.length = 0;
      await post(eventOn(platform, "What are your opening hours?", `${person}-other`, externalId));
      expect(
        sent.map((s) => s.text),
        platform,
      ).toEqual([`${greetingFor(c.clinicName, platform)} ${reply}`]);
    }
    // The model saw every message, and its reply went out behind the
    // greeting untouched: the guard passed it before the greeting was added.
    expect(responder).toHaveBeenCalledTimes(12);
    expect(greetingFor(c.clinicName, "messenger")).toMatch(
      /^Hi! I'm an AI assistant for screen-greeting Clinic\. This channel isn't secure/,
    );

    // The record: one row per person per platform, keyed by an HMAC, holding
    // no sender id and nothing anyone wrote.
    const threads = await inTenant(c.clinicId, (client) =>
      client.query<{
        channel: string;
        party_ref: string;
        conversation_id: string;
        greeted_conversation_id: string | null;
        conversations_count: number;
      }>(
        `select channel, party_ref, conversation_id, greeted_conversation_id, conversations_count from chat_threads order by channel, party_ref`,
      ),
    );
    expect(threads.rows).toHaveLength(6);
    for (const row of threads.rows) {
      expect(row.party_ref).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(row.greeted_conversation_id).toBe(row.conversation_id);
      expect(row.conversations_count).toBe(1);
    }
    expect(threads.rows.map((r) => r.channel).sort()).toEqual([
      "instagram",
      "instagram",
      "messenger",
      "messenger",
      "whatsapp",
      "whatsapp",
    ]);
    expect(
      await rowsContaining(c.clinicId, ["person-903", "15550100903", "opening hours", "parking"]),
    ).toEqual([]);
    // Per platform: the person's three messages, then the other person's one.
    const perPlatform = [true, false, false, true];
    expect((await frontDoorAudit(c.clinicId)).map((a) => a.greeted ?? false)).toEqual(
      channels.flatMap(() => perPlatform),
    );
  }, 60_000);

  test("a message more than 24 hours after the person's last one starts a new conversation, and its reply opens with the greeting again", async () => {
    const c = await doorOpen("screen-window", [{ platform: "whatsapp", externalId: "555000904" }]);
    const reply = "We're open weekdays 9 to 5 — call the practice to book.";
    const responder: FrontDoorResponder = async () => modelJson(reply);
    const thread = {
      platform: "whatsapp" as const,
      externalId: "555000904",
      senderId: "15550100904",
      connectionId: null,
    };
    const answerAt = (at: Date) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        answerFrontDoor(tx, {
          platform: "whatsapp",
          text: "Are you open on Saturday?",
          responder,
          thread,
          now: at,
        }),
      );

    const t0 = new Date("2026-10-01T09:00:00Z");
    const greeted = async (at: Date) => (await answerAt(at))!.greeted;
    expect(await greeted(t0)).toBe(true);
    expect(await greeted(new Date(t0.getTime() + 1 * HOUR))).toBe(false);
    // Exactly 24 hours after the last message is still inside the window.
    expect(await greeted(new Date(t0.getTime() + 25 * HOUR))).toBe(false);
    // More than 24 hours of silence: the window closed, and this message
    // opened a new conversation.
    expect(await greeted(new Date(t0.getTime() + 49 * HOUR + 60_000))).toBe(true);
    expect(await greeted(new Date(t0.getTime() + 50 * HOUR))).toBe(false);
    // A message delivered late, sent before the newest one, joins the
    // conversation it belongs to and greets no one.
    expect(await greeted(new Date(t0.getTime() + 2 * HOUR))).toBe(false);

    const row = await inTenant(c.clinicId, (client) =>
      client.query<{ conversations_count: number; last_inbound_at: Date; same: boolean }>(
        `select conversations_count, last_inbound_at, greeted_conversation_id = conversation_id as same from chat_threads`,
      ),
    );
    expect(row.rows).toEqual([
      { conversations_count: 2, last_inbound_at: new Date(t0.getTime() + 50 * HOUR), same: true },
    ]);

    // The text the person got: the greeting in front of the first reply of each conversation only.
    const first = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, {
        platform: "whatsapp",
        text: "hello",
        responder,
        thread,
        now: new Date(t0.getTime() + 80 * HOUR),
      }),
    );
    expect(first!.text).toBe(`${greetingFor(c.clinicName, "whatsapp")} ${reply}`);
  }, 60_000);

  test("a reply whose transaction rolls back leaves the greeting owed to the next one, and without a thread every reply is greeted", async () => {
    const c = await doorOpen("screen-retry", [
      { platform: "messenger", externalId: "910000000000005" },
    ]);
    const reply = "We're open weekdays 9 to 5 — call the practice to book.";
    const responder: FrontDoorResponder = async () => modelJson(reply);
    const thread = {
      platform: "messenger" as const,
      externalId: "910000000000005",
      senderId: "user-r1",
      connectionId: null,
    };
    const t0 = new Date("2026-10-02T09:00:00Z");

    // The webhook sends a reply inside the transaction that answered it, so a
    // send that throws rolls the answer back, the greeting's mark with it.
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
        const answer = await answerFrontDoor(tx, {
          platform: "messenger",
          text: "What are your opening hours?",
          responder,
          thread,
          now: t0,
        });
        expect(answer!.greeted).toBe(true);
        throw new Error("Graph API 500");
      }),
    ).rejects.toThrow(/Graph API 500/);
    const answerAt = (at: Date) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        answerFrontDoor(tx, {
          platform: "messenger",
          text: "Hello? What are your opening hours?",
          responder,
          thread,
          now: at,
        }),
      );
    expect((await answerAt(new Date(t0.getTime() + 60_000)))!.text).toBe(
      `${greetingFor(c.clinicName, "messenger")} ${reply}`,
    );
    expect((await answerAt(new Date(t0.getTime() + 120_000)))!.text).toBe(reply);

    // Called without a thread, nothing records a first reply, so each one opens with the greeting.
    for (let i = 0; i < 2; i += 1) {
      const answer = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        answerFrontDoor(tx, {
          platform: "messenger",
          text: "What are your opening hours?",
          responder,
        }),
      );
      expect(answer).toMatchObject({
        greeted: true,
        text: `${greetingFor(c.clinicName, "messenger")} ${reply}`,
      });
    }
  }, 60_000);
});
