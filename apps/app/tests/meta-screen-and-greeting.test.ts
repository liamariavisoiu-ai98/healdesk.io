import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { updateClinicSettings } from "@/lib/billing/settings";
import { metaChannelGreeting, type Channel } from "@/lib/compliance/disclosure";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import {
  FRONT_DOOR_PROBES,
  answerFrontDoor,
  buildFrontDoorPrompt,
  firstReplyVerdict,
  frontDoorFacts,
  guardReply,
  handoffLine,
  languageLine,
  openWithGreeting,
  screenInbound,
  stripOwnGreeting,
  urgentLine,
  type FrontDoorResponder,
  type MetaPlatform,
} from "@/lib/meta/front-door";
import { recordGreeting } from "@/lib/meta/greeting";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic } from "./setup/factories";

/**
 * Release gate 4 of BAA 1.3.0 (docs/counsel/agreement-changes.md §12.14,
 * PT-12 and PT-13), held in code.
 *
 * Clause 16 promises: "healdesk checks each message a person sends there for
 * clinical content before the language model sees it, and keeps no message
 * there and no summary of one", and "Its first reply in each conversation
 * says that it is an AI assistant and that the channel is not secure". So: a
 * clinical message gets the fixed hand-off line, an urgent one the fixed
 * urgent line, neither reaches the model or any table, and the first reply of
 * each conversation, on every Meta platform, opens with metaChannelGreeting()
 * while no later one does.
 *
 * The rule for "conversation" is lib/meta/greeting.ts's: a message sent
 * more than 24 hours after the person's previous one starts a new
 * conversation, and its reply greets again. "First reply" means the first
 * the person gets: the greeting is recorded only once the reply carrying it
 * has gone out, so a reply dropped outside Meta's window leaves it owed.
 *
 * And release gate 20: that greeting is the only one a first reply carries.
 * The prompt asks the model for none, and a bare salutation or a
 * self-introduction leading the model's text comes off before the greeting
 * goes in front (stripOwnGreeting); a later reply goes out as the model wrote
 * it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-screen-tests";
const PUBLISHED = "+14155550142";
const DIRECT = "+14155550143";
/** The urgent-help number the setup wizard asks for (plan Part E, 2.5). */
const URGENT = "+14155550144";
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
    // A reaction or a complication in the present tense, and trouble
    // swallowing, are urgent too: none of them may reach the model, and a
    // complication someone has is not a question about risks.
    expect(screenInbound("I have a bad reaction to the filler you did yesterday")).toBe("urgent");
    expect(screenInbound("she has a reaction to the botox")).toBe("urgent");
    expect(screenInbound("I think I have a complication from the botox")).toBe("urgent");
    expect(screenInbound("trouble swallowing since my botox")).toBe("urgent");
    expect(screenInbound("difficulty swallowing after the injections")).toBe("urgent");
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "safety")!.text)).toBe("clinical");
    expect(screenInbound("How many units do I need for my forehead?")).toBe("clinical");
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "hours")!.text)).toBeNull();
    expect(screenInbound("How much is it per unit?")).toBeNull();
    expect(screenInbound(FRONT_DOOR_PROBES.find((p) => p.id === "request")!.text)).toBeNull();
  });

  test("a veterinary practice is screened with the animal set; a med spa never is", () => {
    expect(screenInbound("my cat can't pee", "veterinary")).toBe("urgent");
    expect(screenInbound("my dog ate a whole bar of chocolate", "veterinary")).toBe("urgent");
    expect(screenInbound("my dog ate a whole bar of chocolate", "med-spa")).toBeNull();
    // Without a specialty, the set for people, as the front door always had.
    expect(screenInbound("my dog ate a whole bar of chocolate")).toBeNull();
    expect(screenInbound("Can I book a nail trim for Saturday?", "veterinary")).toBeNull();
  });

  test("a veterinary practice's urgent line gives the emergency vet, never 911, and passes the reply guard", () => {
    const facts = {
      clinicName: "Paws",
      phone: PUBLISHED,
      urgentPhone: DIRECT,
      vetReferralPhone: "+14155550911",
      openingHours: { sun: [], mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [], thu: [], fri: [], sat: [] } as const,
      timeZone: "America/Los_Angeles",
    };
    // Tuesday 10:00 in Los Angeles, then the Sunday before.
    const open = urgentLine(facts, { emergency: "veterinary" }, new Date("2026-10-13T17:00:00Z"));
    expect(open).toBe(
      `I'm an AI assistant, so I can't help with anything urgent here. If this is an emergency, call the emergency vet now on +14155550911. If a person is hurt or in danger, call 911 now. Otherwise, please call Paws on ${DIRECT}.`,
    );
    const closed = urgentLine(facts, { emergency: "veterinary" }, new Date("2026-10-11T17:00:00Z"));
    expect(closed).not.toContain(DIRECT);
    for (const line of [open, closed]) {
      // 911 only for a person, after the emergency vet.
      expect(line.indexOf("emergency vet")).toBeLessThan(line.indexOf("911"));
      expect(guardReply(line, { clinicName: "Paws", serviceNames: ["Senior diagnostics"] })).toEqual({ ok: true });
    }
    // A person's own emergency at a vet is 911's on Meta too.
    expect(screenInbound("my husband collapsed", "veterinary")).toBe("urgent");
  });

  test("a message in a language no screen reads is screened as such, and its fixed line passes the guard", () => {
    for (const text of ["Je n'arrive pas à respirer", "Não consigo respirar", "Bonjour, je voudrais un rendez-vous"]) {
      expect(screenInbound(text), text).toBe("language");
    }
    // Spanish is screened, so it is never turned away for its language.
    expect(screenInbound("¿Cuánto cuesta una consulta?")).toBeNull();
    expect(screenInbound("No puedo respirar")).toBe("urgent");
    const line = languageLine({ clinicName: "Radiance", phone: PUBLISHED, urgentPhone: DIRECT });
    expect(line).toContain("I can only help in English or Spanish.");
    expect(line).toContain("call 911 now");
    expect(line).toContain(DIRECT);
    expect(guardReply(line, { clinicName: "Radiance", serviceNames: ["Botox"] })).toEqual({ ok: true });
  });

  test("the prompt carries the clinic's tone, and asks for English only: the guard reads English", () => {
    const facts = {
      clinicName: "Radiance",
      phone: PUBLISHED,
      websiteHint: null,
      services: [],
      notes: null,
      escalationHours: null,
      requirements: [],
      deferredRequirements: [],
    };
    expect(buildFrontDoorPrompt(facts)).toContain("Plain, warm and friendly.");
    expect(buildFrontDoorPrompt({ ...facts, tone: "clinical" })).toContain("Plain, calm and precise.");
    expect(buildFrontDoorPrompt({ ...facts, tone: "clinical" })).not.toContain("warm and friendly");
    expect(buildFrontDoorPrompt(facts)).toContain("Always write in English, whatever language the message is in");
  });

  test("an everyday skin or hair condition is clinical here, never urgent; a front desk's question still passes", () => {
    // Owner, 7 October 2026: the check recognises everyday skin conditions,
    // and on a Meta channel, which signs no BAA, a condition named is clinical.
    for (const text of [
      "I have bad acne, can you help?",
      "do you treat rosacea?",
      "my hair is falling out, do you do PRP?",
      "Any openings this week? My eczema is flaring up",
      FRONT_DOOR_PROBES.find((p) => p.id === "condition")!.text,
      FRONT_DOOR_PROBES.find((p) => p.id === "alts")!.text,
    ]) {
      expect(screenInbound(text), text).toBe("clinical");
    }
    for (const text of [
      "How much is laser hair removal?",
      "Do you do IPL for sun spots?",
      "Can I book with Dr Whitehead?",
      "Any spots left on Saturday?",
      "How much are lip fillers?",
    ]) {
      expect(screenInbound(text), text).toBeNull();
    }
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

describe("one greeting on a first reply, the channel's (BAA 1.3.0 gate 20)", () => {
  const CLINIC = "Radiance Med Spa";
  const strip = (text: string) => stripOwnGreeting(text, CLINIC);

  test("a bare salutation leading the model's text comes off, and so does a self-introduction", () => {
    const cases: [string, string][] = [
      ["Hi! We're open until 6.", "We're open until 6."],
      ["Hi there! We open at 9.", "We open at 9."],
      ["Hello there. We open at 9.", "We open at 9."],
      ["Hello! We open at 9.", "We open at 9."],
      ["Hey! We open at 9.", "We open at 9."],
      ["hi!! We open at 9.", "We open at 9."],
      // With a name, after a comma or not.
      ["Hello, Maria! We open at 9.", "We open at 9."],
      ["Hi Maria Lopez! We open at 9.", "We open at 9."],
      ["Hey Maria. We open at 9.", "We open at 9."],
      // Nothing more on its line.
      ["Hi\nWe open at 9.", "We open at 9."],
      ["Hi Maria,\n\nWe open at 9.", "We open at 9."],
      // A self-introduction, after a bare salutation, run on from one, or alone.
      [`Hi there! I'm the messaging assistant for ${CLINIC}. We open at 9.`, "We open at 9."],
      [`Hi, I'm an AI assistant for ${CLINIC}. We open at 9.`, "We open at 9."],
      [`Hello there — I'm the AI assistant here at ${CLINIC}! We open at 9.`, "We open at 9."],
      [`I'm ${CLINIC}'s virtual assistant! We open at 9.`, "We open at 9."],
      ["I’m an AI assistant for the practice. We open at 9.", "We open at 9."],
      [
        "I am an automated assistant, not a person. A person at the practice can help.",
        "A person at the practice can help.",
      ],
      // A reply that was only a greeting leaves nothing.
      ["Hi there!", ""],
      [`Hi there! I'm the messaging assistant for ${CLINIC}.`, ""],
    ];
    for (const [reply, left] of cases) expect(strip(reply), reply).toBe(left);
  });

  test("nothing else comes off: a salutation running on into its sentence, a word that starts like one, a greeting later on, or a self-introduction that says more", () => {
    for (const reply of [
      "We open at 9. Call the practice to book.",
      "Highlights: we open at 9.",
      "Hey, that's a good question — call the practice to book.",
      "Hey, That's a good question.",
      "Hi, we're open until 6.",
      "Hi there, thanks for reaching out! We open at 9.",
      "Hello and welcome! We open at 9.",
      // Not one of the five.
      "Hey there! We open at 9.",
      "Hiring? No, we open at 9.",
      "Hi-five! We open at 9.",
      "We open at 9. Hi!",
      "Thanks for reaching out! We open at 9.",
      // A title's full stop does not end the salutation.
      "Hi Dr. Patel, we open at 9.",
      "Hi Dr. Patel! We open at 9.",
      "I'm an AI assistant, so I can't help with that here — call the practice.",
      `I'm an AI assistant for ${CLINIC}, and I can pass a booking request on.`,
      "I'm the AI assistant for another clinic. We open at 9.",
      "No, I'm an automated assistant. Call the practice to talk to a person.",
    ]) {
      expect(strip(reply), reply).toBe(reply);
    }
  });

  test("the greeting goes in front of the model's text less its own greeting, and of a fixed line as written", () => {
    const greeting = greetingFor(CLINIC, "messenger");
    const model = (text: string) => openWithGreeting(greeting, { text, source: "model" }, CLINIC);
    expect(model("Hi! We're open until 6.")).toBe(`${greeting} We're open until 6.`);
    expect(model("Hi there!")).toBe(greeting);
    // The fixed lines are the code's, and go in whole: the urgent line's "I'm
    // an AI assistant" is why the person is being moved.
    const urgent = urgentLine({ clinicName: CLINIC, phone: PUBLISHED, urgentPhone: DIRECT });
    expect(openWithGreeting(greeting, { text: urgent, source: "urgent" }, CLINIC)).toBe(
      `${greeting} ${urgent}`,
    );
    const handoff = handoffLine({ clinicName: CLINIC, phone: PUBLISHED });
    expect(openWithGreeting(greeting, { text: handoff, source: "handoff" }, CLINIC)).toBe(
      `${greeting} ${handoff}`,
    );
  });

  test("the QA gate's first-reply check: as sent, no second greeting and no second AI self-introduction, where an answer to 'are you a person?' is not one", () => {
    const hours = FRONT_DOOR_PROBES.find((p) => p.id === "hours")!.text;
    const verdict = (raw: string, inbound = hours) =>
      firstReplyVerdict(raw, { clinicName: CLINIC, platform: "instagram", inbound });
    expect(verdict(modelJson("We open at 9. Call the practice to book."))).toEqual({
      ok: true,
      reason: null,
      sent: `${greetingFor(CLINIC, "instagram")} We open at 9. Call the practice to book.`,
      stripped: false,
    });
    // What the backstop takes off passes, and the verdict says it was needed.
    expect(verdict(modelJson("Hi there! We open at 9."))).toEqual({
      ok: true,
      reason: null,
      sent: `${greetingFor(CLINIC, "instagram")} We open at 9.`,
      stripped: true,
    });
    expect(verdict("Hello! We open at 9.")).toMatchObject({ ok: true, stripped: true });
    // What it leaves, the check catches: any salutation opening a sentence.
    const secondGreeting = { ok: false, reason: "a second greeting" };
    for (const reply of [
      "Hi there, thanks for reaching out! We open at 9.",
      "Hey there! We open at 9.",
      "Good morning! We open at 9.",
      "Thanks! Hello and welcome. We open at 9.",
      // Not stripped, since it runs on into its sentence, but a second "Hey" as sent.
      "Hey, that's easy: we open at 9.",
    ]) {
      expect(verdict(modelJson(reply)), reply).toMatchObject(secondGreeting);
    }
    // And any sentence saying it is an AI assistant, unasked.
    const secondIntroduction = { ok: false, reason: "a second AI self-introduction" };
    for (const reply of [
      `Thanks for your message! I'm the messaging assistant for ${CLINIC}. We open at 9.`,
      "I'm an automated assistant, so I can't check that. Call the practice.",
      "As an AI, I can't book you in, but the practice can: call them.",
      "No, I'm an automated assistant. Call the practice.",
    ]) {
      expect(verdict(modelJson(reply)), reply).toMatchObject(secondIntroduction);
    }
    // Asked what it is, it says so, by the prompt's own rule: an answer, not an introduction.
    const human = FRONT_DOOR_PROBES.find((p) => p.id === "human")!.text;
    const answer = modelJson("No, I'm an automated assistant. A person at the practice can help.");
    expect(verdict(answer, human)).toMatchObject({ ok: true });
    const greeted = modelJson("Hello there, no. I'm an automated assistant.");
    expect(verdict(greeted, human)).toMatchObject(secondGreeting);
  });
});

/** `timestamp` is when the person sent it, as Messenger stamps it (milliseconds); absent, now. */
const messengerEvent = (text: string, sender: string, pageId: string, timestamp?: number) => ({
  object: "page",
  entry: [
    {
      id: pageId,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: pageId },
          ...(timestamp === undefined ? {} : { timestamp }),
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
    opts: { directLine?: string; urgentHelp?: string } = {},
  ) {
    const c = await seedClinic(label);
    // Weekdays 9 to 5: the opening and closing times the reply guard lets a
    // reply name (lib/meta/front-door.ts, publishedTimes).
    const weekday = [["09:00", "17:00"]];
    await getMigratorPool().query(`update clinics set opening_hours = $2::jsonb where id = $1`, [
      c.clinicId,
      JSON.stringify({
        sun: [],
        mon: weekday,
        tue: weekday,
        wed: weekday,
        thu: weekday,
        fri: weekday,
        sat: [],
      }),
    ]);
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
    if (opts.urgentHelp) {
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, urgent_help_e164) values ($1, $2)
           on conflict (clinic_id) do update set urgent_help_e164 = excluded.urgent_help_e164`,
          [c.clinicId, opts.urgentHelp],
        ),
      );
    }
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

  /**
   * Answer as the webhook does when the reply goes out: the greeting the
   * answer carries is recorded in the same transaction, after the send
   * (route.ts). For tests of what a conversation is at fixed instants, whose
   * replies the webhook's 24-hour window, read against the real clock, would
   * drop.
   */
  function answerSent(clinicId: string, input: Parameters<typeof answerFrontDoor>[1]) {
    return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const answer = await answerFrontDoor(tx, input);
      if (answer?.greetingToRecord) await recordGreeting(tx, answer.greetingToRecord);
      return answer;
    });
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

  test("a message naming an everyday skin condition never reaches the model on Instagram, Messenger or WhatsApp, gets the hand-off line, and leaves nothing in any table", async () => {
    const channels: { platform: MetaPlatform; externalId: string }[] = [
      { platform: "instagram", externalId: "17841400000000008" },
      { platform: "messenger", externalId: "910000000000008" },
      { platform: "whatsapp", externalId: "555000908" },
    ];
    const c = await doorOpen("screen-conditions", channels);
    // Had the model been asked, it would have taken a booking out of the second message.
    const responder = vi.fn<FrontDoorResponder>(async () =>
      modelJson("The practice can help with that — they'll call you.", {
        wants: true,
        first_name: "Persephone",
        phone: "+14155550148",
        window: "Friday morning",
      }),
    );
    __setMetaRuntimeForTests(responder, sender, transport);
    const handoff = handoffLine({ clinicName: c.clinicName, phone: PUBLISHED });

    for (const { platform, externalId } of channels) {
      const person = platform === "whatsapp" ? "15550100908" : `person-908-${platform}`;
      sent.length = 0;
      await post(eventOn(platform, "I have bad acne, can you help?", person, externalId));
      await post(
        eventOn(
          platform,
          "do you treat rosacea? I'm Persephone, +1 415 555 0148, Friday morning",
          person,
          externalId,
        ),
      );
      // The thread's first reply opens with the greeting; both are the fixed line.
      expect(
        sent.map((s) => s.text),
        platform,
      ).toEqual([`${greetingFor(c.clinicName, platform)} ${handoff}`, handoff]);
      expect(sent.every((s) => s.platform === platform && s.recipientId === person)).toBe(true);
    }
    expect(responder).not.toHaveBeenCalled();

    expect(
      await rowsContaining(c.clinicId, [
        "acne",
        "rosacea",
        "Persephone",
        "4155550148",
        "555 0148",
        "Friday morning",
        "person-908",
        "15550100908",
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
    expect(await frontDoorAudit(c.clinicId)).toEqual(
      channels.flatMap(({ platform }) => [
        { platform, source: "handoff", screened: "clinical", greeted: true },
        { platform, source: "handoff", screened: "clinical" },
      ]),
    );
  }, 60_000);

  test("a condition named halfway through a booking request adds nothing to it, and the request carries on", async () => {
    const pageId = "910000000000009";
    const c = await doorOpen("screen-condition-draft", [
      { platform: "messenger", externalId: pageId },
    ]);
    const responder = vi.fn<FrontDoorResponder>(async () =>
      modelJson("Happy to pass a request on — what's the best number to call you on?", {
        wants: true,
        first_name: "Odalys",
      }),
    );
    __setMetaRuntimeForTests(responder, sender, transport);
    await post(messengerEvent("Hi, I'd like to book something. I'm Odalys.", "user-d1", pageId));
    const draft = () =>
      inTenant(c.clinicId, (client) =>
        client.query(
          `select first_name, phone, preferred_window, alternative_windows from meta_booking_drafts`,
        ),
      );
    const before = (await draft()).rows;
    expect(before).toEqual([
      { first_name: "Odalys", phone: null, preferred_window: null, alternative_windows: [] },
    ]);

    // The number and a window arrive with a condition: the screen hands off,
    // the model is not called, and the draft is exactly as it was.
    await post(
      messengerEvent(
        "It's 415 555 0149, Saturday afternoon — it's for my melasma",
        "user-d1",
        pageId,
      ),
    );
    expect(responder).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)!.text).toBe(handoffLine({ clinicName: c.clinicName, phone: PUBLISHED }));
    expect((await draft()).rows).toEqual(before);
    expect(
      await rowsContaining(c.clinicId, ["melasma", "4155550149", "555 0149", "Saturday afternoon"]),
    ).toEqual([]);
    expect(
      (await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows,
    ).toHaveLength(0);

    // Sent again without it, the number and the window complete the request.
    responder.mockImplementation(async () =>
      modelJson("Thanks!", { wants: true, phone: "+14155550149", window: "Saturday afternoon" }),
    );
    await post(messengerEvent("415 555 0149, Saturday afternoon", "user-d1", pageId));
    expect(responder).toHaveBeenCalledTimes(2);
    expect(
      (
        await inTenant(c.clinicId, (client) =>
          client.query(`select preferred_window from booking_requests`),
        )
      ).rows,
    ).toEqual([{ preferred_window: "Saturday afternoon" }]);
    expect(await rowsContaining(c.clinicId, ["melasma"])).toEqual([]);
    expect(await frontDoorAudit(c.clinicId)).toEqual([
      { platform: "messenger", source: "model", greeted: true, booking: "collecting" },
      { platform: "messenger", source: "handoff", screened: "clinical" },
      { platform: "messenger", source: "booking", booking: "requested" },
    ]);
  }, 60_000);

  test("the urgent line gives the practice's urgent-help number, else its default as the wizard resolves it", async () => {
    // lib/setup/urgent.ts: the clinic's own urgent-help number; empty, the
    // direct line for a practice with phone, the main number without.
    const facts = (clinicId: string) =>
      withTenant({ clinicId, actor: ACTOR }, (tx) => frontDoorFacts(tx));
    const own = await doorOpen(
      "urgent-own",
      [{ platform: "messenger", externalId: "910000000000031" }],
      {
        directLine: DIRECT,
        urgentHelp: URGENT,
      },
    );
    expect((await facts(own.clinicId))?.urgentPhone).toBe(URGENT);

    const withPhone = await doorOpen(
      "urgent-phone",
      [{ platform: "messenger", externalId: "910000000000032" }],
      {
        directLine: DIRECT,
      },
    );
    await seedChannels(withPhone.clinicId, [{ channel: "voice" }]);
    expect((await facts(withPhone.clinicId))?.urgentPhone).toBe(DIRECT);

    // Chat only: the main number reaches the practice, since nothing forwards it to AYA.
    const chatOnly = await doorOpen(
      "urgent-chat",
      [{ platform: "messenger", externalId: "910000000000033" }],
      {
        directLine: DIRECT,
      },
    );
    expect((await facts(chatOnly.clinicId))?.urgentPhone).toBe(PUBLISHED);
  }, 60_000);

  test("an urgent message gets the urgent line without the model, and a half-collected request is left as it was", async () => {
    const pageId = "910000000000002";
    const c = await doorOpen("screen-urgent", [{ platform: "messenger", externalId: pageId }], {
      directLine: DIRECT,
      urgentHelp: URGENT,
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
    const urgent = urgentLine({ clinicName: c.clinicName, phone: PUBLISHED, urgentPhone: URGENT });
    expect(sent.at(-1)!.text).toBe(urgent);
    expect(urgent).toMatch(/If this is an emergency, call 911 now\./);
    expect(urgent).toContain(URGENT);

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

  test("a reaction or a complication told in the present tense, or trouble swallowing, gets the urgent line and never reaches the model", async () => {
    const pageId = "910000000000006";
    const c = await doorOpen("screen-reaction", [{ platform: "messenger", externalId: pageId }], {
      directLine: DIRECT,
      urgentHelp: URGENT,
    });
    const responder = vi.fn<FrontDoorResponder>(async () =>
      modelJson("We're open weekdays 9 to 5 — call the practice to book."),
    );
    __setMetaRuntimeForTests(responder, sender, transport);

    const messages = [
      "I have a bad reaction to the filler you did yesterday",
      "she has a reaction to the botox",
      "I think I have a complication from the botox",
      "trouble swallowing since my botox",
    ];
    for (const text of messages) await post(messengerEvent(text, "user-x1", pageId));
    expect(responder).not.toHaveBeenCalled();
    const urgent = urgentLine({ clinicName: c.clinicName, phone: PUBLISHED, urgentPhone: URGENT });
    expect(sent.map((s) => s.text)).toEqual([
      `${greetingFor(c.clinicName, "messenger")} ${urgent}`,
      urgent,
      urgent,
      urgent,
    ]);
    expect(
      await rowsContaining(c.clinicId, [
        "filler you did",
        "reaction to the botox",
        "complication from",
        "swallowing since",
      ]),
    ).toEqual([]);
    expect(await frontDoorAudit(c.clinicId)).toEqual([
      { platform: "messenger", source: "urgent", screened: "urgent", greeted: true },
      { platform: "messenger", source: "urgent", screened: "urgent" },
      { platform: "messenger", source: "urgent", screened: "urgent" },
      { platform: "messenger", source: "urgent", screened: "urgent" },
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
    // Each reply went out, so each greeting it carried is recorded.
    const answerAt = (at: Date, text = "Are you open on Saturday?") =>
      answerSent(c.clinicId, { platform: "whatsapp", text, responder, thread, now: at });

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
    const first = await answerAt(new Date(t0.getTime() + 80 * HOUR), "hello");
    expect(first!.text).toBe(`${greetingFor(c.clinicName, "whatsapp")} ${reply}`);
  }, 60_000);

  test("a reply dropped outside Meta's 24-hour window leaves the greeting owed, so the first reply the person gets opens with it", async () => {
    const pageId = "910000000000007";
    const c = await doorOpen("screen-late", [{ platform: "messenger", externalId: pageId }]);
    const reply = "We're open weekdays 9 to 5 — call the practice to book.";
    const responder = vi.fn<FrontDoorResponder>(async () => modelJson(reply));
    __setMetaRuntimeForTests(responder, sender, transport);
    const hoursAgo = (hours: number) => Date.now() - hours * HOUR;

    // A backlog Meta delivers a day late: sent 25 hours ago, so its window
    // has closed, and sendMetaReply drops the reply, greeting and all.
    await post(messengerEvent("What are your opening hours?", "user-l1", pageId, hoursAgo(25)));
    expect(responder).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    // Sent 23 hours after it, so the same conversation, and the first reply
    // the person gets: it opens with the greeting. The next one does not.
    await post(messengerEvent("Hello? Are you open today?", "user-l1", pageId, hoursAgo(2)));
    await post(messengerEvent("And do you have parking?", "user-l1", pageId, hoursAgo(1)));
    expect(sent.map((s) => s.text)).toEqual([
      `${greetingFor(c.clinicName, "messenger")} ${reply}`,
      reply,
    ]);

    // One conversation, whose greeting is recorded only now that it went out.
    const threads = await inTenant(c.clinicId, (client) =>
      client.query<{ conversations_count: number; same: boolean }>(
        `select conversations_count, greeted_conversation_id = conversation_id as same from chat_threads`,
      ),
    );
    expect(threads.rows).toEqual([{ conversations_count: 1, same: true }]);
    // The dropped reply is audited as answered and as outside the window; the
    // answers, one per transaction, in order.
    const audit = await frontDoorAudit(c.clinicId);
    expect(audit.filter((a) => a.outcome === "outside_window")).toEqual([
      { platform: "messenger", outcome: "outside_window" },
    ]);
    expect(audit.filter((a) => a.source !== undefined)).toEqual([
      { platform: "messenger", source: "model", greeted: true },
      { platform: "messenger", source: "model", greeted: true },
      { platform: "messenger", source: "model" },
    ]);
  }, 60_000);

  test("answerFrontDoor leaves the greeting to its caller: owed until a reply that went out records it, and given to every reply without a thread", async () => {
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
    const greeting = greetingFor(c.clinicName, "messenger");

    // Answered, but never sent (dropped outside the window, or the send
    // threw): nothing recorded the greeting, so the next reply in the same
    // conversation carries it again.
    const unsent = (await answerAt(t0))!;
    expect(unsent).toMatchObject({ greeted: true, text: `${greeting} ${reply}` });
    const retried = (await answerAt(new Date(t0.getTime() + 60_000)))!;
    expect(retried).toMatchObject({ greeted: true, text: `${greeting} ${reply}` });
    expect(retried.greetingToRecord!.conversationId).toBe(unsent.greetingToRecord!.conversationId);

    // The webhook records it once sendMetaReply says the reply went out; no
    // later reply in the conversation repeats it.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      recordGreeting(tx, retried.greetingToRecord!),
    );
    expect(await answerAt(new Date(t0.getTime() + 120_000))).toMatchObject({
      greeted: false,
      text: reply,
      greetingToRecord: null,
    });

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
        text: `${greeting} ${reply}`,
        greetingToRecord: null,
      });
    }
  }, 60_000);

  test("a model that greets anyway: the first reply carries one greeting, the channel's, and the second goes out as the model wrote it (BAA 1.3.0 gate 20)", async () => {
    const pageId = "910000000000010";
    const c = await doorOpen("screen-once", [{ platform: "messenger", externalId: pageId }]);
    const greeting = greetingFor(c.clinicName, "messenger");
    const responder = vi.fn<FrontDoorResponder>(async () => "Hi there! We open at 9.");
    const thread = {
      platform: "messenger" as const,
      externalId: pageId,
      senderId: "user-o1",
      connectionId: null,
    };
    const t0 = new Date("2026-10-03T09:00:00Z");
    const ask = (at: Date, input: { responder: FrontDoorResponder; senderId?: string }) =>
      answerSent(c.clinicId, {
        platform: "messenger",
        text: "When do you open?",
        responder: input.responder,
        thread: { ...thread, senderId: input.senderId ?? thread.senderId },
        now: at,
      });

    // The first reply: the channel's greeting, then the model's text without its own.
    const first = (await ask(t0, { responder }))!;
    expect(first).toMatchObject({
      source: "model",
      greeted: true,
      text: `${greeting} We open at 9.`,
    });
    expect(first.text.match(/\b(?:Hi|Hello|Hey)\b/g)).toEqual(["Hi"]);
    expect(first.text.match(/\bAI assistant\b/g)).toEqual(["AI assistant"]);

    // The second reply of the conversation carries no greeting, and the
    // model's text goes out exactly as it wrote it.
    const second = (await ask(new Date(t0.getTime() + 60_000), { responder }))!;
    expect(second).toMatchObject({
      source: "model",
      greeted: false,
      text: "Hi there! We open at 9.",
      greetingToRecord: null,
    });
    expect(responder).toHaveBeenCalledTimes(2);

    // A self-introduction of the model's own comes off as well, by the clinic's name.
    const introducing: FrontDoorResponder = async () =>
      modelJson(`Hi, I'm the messaging assistant for ${c.clinicName}. We open at 9.`);
    const other = (await ask(t0, { responder: introducing, senderId: "user-o2" }))!;
    expect(other).toMatchObject({ greeted: true, text: `${greeting} We open at 9.` });

    // The audit rows are a greeted reply's and a later one's, as ever.
    expect(await frontDoorAudit(c.clinicId)).toEqual([
      { platform: "messenger", source: "model", greeted: true },
      { platform: "messenger", source: "model" },
      { platform: "messenger", source: "model", greeted: true },
    ]);
  }, 60_000);

  test("a model that declines to answer gets the hand-off line, recorded as a refusal and never as a guard refusal", async () => {
    const c = await doorOpen("screen-refusal", [{ platform: "messenger", externalId: "910000000000071" }]);
    const responder = vi.fn<FrontDoorResponder>(async () => ({ refused: true, category: "bio" }));
    const answer = (await answerSent(c.clinicId, { platform: "messenger", text: "What are your opening hours?", responder }))!;
    expect(responder).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ source: "handoff", guard: "model refusal", screened: null, booking: "none" });
    expect(answer.text).toBe(`${greetingFor(c.clinicName, "messenger")} ${handoffLine({ clinicName: c.clinicName, phone: PUBLISHED })}`);
    expect(await frontDoorAudit(c.clinicId)).toEqual([
      { platform: "messenger", source: "handoff", guarded: "model refusal", greeted: true },
    ]);
  }, 60_000);

  test("a veterinary practice's urgent message never reaches the model and gets its emergency vet, its own number only while open", async () => {
    const c = await doorOpen("screen-vet", [{ platform: "messenger", externalId: "910000000000072" }], { directLine: DIRECT });
    await getMigratorPool().query(`update clinics set specialty = 'veterinary', timezone = 'America/Los_Angeles' where id = $1`, [c.clinicId]);
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, vet_referral_e164) values ($1, $2)
         on conflict (clinic_id) do update set vet_referral_e164 = excluded.vet_referral_e164`,
        [c.clinicId, "+14155550911"],
      ),
    );
    const facts = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => frontDoorFacts(tx));
    expect(facts).toMatchObject({ specialty: "veterinary", vetReferralPhone: "+14155550911", timeZone: "America/Los_Angeles" });

    const responder = vi.fn<FrontDoorResponder>(async () => modelJson("Please call the practice."));
    const greeting = greetingFor(c.clinicName, "messenger");
    // Tuesday 10:00 in Los Angeles: open.
    const open = (await answerSent(c.clinicId, { platform: "messenger", text: "my cat can't pee", responder, now: new Date("2026-10-13T17:00:00Z") }))!;
    expect(open).toMatchObject({ source: "urgent", screened: "urgent" });
    expect(open.text).toBe(`${greeting} ${urgentLine(facts!, { emergency: "veterinary" }, new Date("2026-10-13T17:00:00Z"))}`);
    expect(open.text).toContain("call the emergency vet now on +14155550911");
    // 911 only for a person, after the emergency vet.
    expect(open.text.indexOf("+14155550911")).toBeLessThan(open.text.indexOf("call 911"));
    // Sunday: closed, so only the emergency vet.
    const closed = (await answerSent(c.clinicId, { platform: "messenger", text: "my dog ate a whole bar of chocolate", responder, now: new Date("2026-10-11T17:00:00Z") }))!;
    expect(closed.source).toBe("urgent");
    expect(closed.text).toContain("+14155550911");
    expect(closed.text).not.toContain("Otherwise, please call");
    expect(responder).not.toHaveBeenCalled();
    // And a person's own emergency there is 911's.
    const person = (await answerSent(c.clinicId, { platform: "messenger", text: "call 911, my husband collapsed", responder, now: new Date("2026-10-13T17:00:00Z") }))!;
    expect(person.source).toBe("urgent");
    expect(person.text).toContain("If this is an emergency, call 911 now.");
    // 911 leads, and at a vet the emergency vet is always given too.
    expect(person.text.indexOf("call 911")).toBeLessThan(person.text.indexOf("emergency vet"));
    expect(person.text).toContain("+14155550911");
    expect(responder).not.toHaveBeenCalled();
  }, 60_000);

  test("a message in another language never reaches the model, and a reply in anything but English is never sent", async () => {
    const c = await doorOpen("screen-language", [{ platform: "messenger", externalId: "910000000000073" }]);
    const responder = vi.fn<FrontDoorResponder>(async () => modelJson("We're open weekdays 9 to 5 — call the practice to book."));
    const french = (await answerSent(c.clinicId, { platform: "messenger", text: "Je n'arrive pas à respirer", responder }))!;
    expect(responder).not.toHaveBeenCalled();
    expect(french).toMatchObject({ source: "handoff", screened: "language" });
    expect(french.text).toContain("I can only help in English or Spanish.");
    expect(french.text).toContain("Si es una emergencia, llame al 911 ahora.");

    // A Spanish message is screened, so it reaches the model; a Spanish reply is not sent.
    const spanish = vi.fn<FrontDoorResponder>(async () => modelJson("Abrimos de lunes a viernes, de 9 a 5. Llame a la clínica para reservar."));
    const answer = (await answerSent(c.clinicId, { platform: "messenger", text: "¿Cuál es su horario?", responder: spanish }))!;
    expect(spanish).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ source: "handoff", guard: "a reply not in English" });
    expect(answer.text).toContain(handoffLine({ clinicName: c.clinicName, phone: PUBLISHED }));
  }, 60_000);
});
