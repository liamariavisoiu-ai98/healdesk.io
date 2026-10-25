import type Anthropic from "@anthropic-ai/sdk";
import {
  CARRIERS,
  CARRIER_SERVICE_NUMBERS,
  COVERAGE_MODES,
  lintSupportTone,
  PATIENT_MODEL_IDS,
  SUPPORT_BANNED_PHRASES,
  SUPPORT_TONE_RULES,
} from "@healdesk/catalog";
import { SETTING_KEYS } from "@/lib/portal/settings";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SUPPORT_ESCALATION_FIXTURE } from "@/lib/email/templates/support_escalation";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import type { SetupState } from "@/lib/setup/state";
import type { AccountState } from "@/lib/support/account-state";
import {
  handleSupportChat,
  messagesFor,
  readChatRequest,
  screenAllowFor,
  type SupportChatContext,
} from "@/lib/support/chat";
import { forwardingAnswerFrom, forwardingStepsFrom, type ForwardingFacts } from "@/lib/support/forwarding";
import { HELP_TEXT } from "@/lib/support/help-text";
import { SUPPORT_LIMITS, SupportLimiter } from "@/lib/support/limits";
import { SUPPORT_MODEL, supportRequest, type SupportModelClient } from "@/lib/support/model";
import { buildSupportPrompt, SUPPORT_PROMPT_STABLE, SUPPORT_TONE } from "@/lib/support/prompt";
import { linkTo, LINK_TARGETS, SETTING_PLACES } from "@/lib/support/targets";
import { SUPPORT_TOOLS } from "@/lib/support/tools";
import type { SupportEvent } from "@/lib/support/turn";

/**
 * The portal's support chat (plan Part H), end to end without a database and
 * without the real API: the model is a fake that streams what each test
 * scripts and records every request it is sent. What is held:
 *
 *   - the request: claude-opus-5-5, the stable prefix cached and nothing
 *     about the clinic in it, four strict read-only tools;
 *   - the identifier screen and the treatment names, before the model and
 *     before the person;
 *   - a refusal as its own outcome, with the fixed line;
 *   - the limits, per device and per clinic;
 *   - get_forwarding_steps giving nothing before voice is ready;
 *   - link_to built from the public origin;
 *   - an escalation that carries no chat text to hello@, and no log line
 *     anywhere that carries any.
 */

const ORIGIN = "https://app.healdesk.test";
const INTERNAL = "https://app-internal.healdesk.test";
const SUPPORT_PHONE = "+18886889404";
const CLINIC_ID = "0c1d2e3f-0000-4000-8000-000000000000";

const SAVED: Record<string, string | undefined> = {};
const ENV = ["BETTER_AUTH_URL", "HEALDESK_APP_URL", "HEALDESK_SUPPORT_PHONE"] as const;

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.HEALDESK_APP_URL = INTERNAL;
  process.env.HEALDESK_SUPPORT_PHONE = SUPPORT_PHONE;
});

afterEach(() => {
  for (const key of ENV) {
    const value = SAVED[key];
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// The fake model
// -----------------------------------------------------------------------------

type Round = {
  text?: readonly string[];
  tools?: readonly { name: string; input: unknown }[];
  stop?: Anthropic.Message["stop_reason"];
};

function message(round: Round, index: number): Anthropic.Message {
  const content: unknown[] = [];
  const text = (round.text ?? []).join("");
  if (text) content.push({ type: "text", text, citations: null });
  (round.tools ?? []).forEach((tool, i) =>
    content.push({
      type: "tool_use",
      id: `toolu_${index}_${i}`,
      name: tool.name,
      input: tool.input,
    }),
  );
  const stop = round.stop ?? (round.tools?.length ? "tool_use" : "end_turn");
  return {
    id: `msg_${index}`,
    type: "message",
    role: "assistant",
    model: SUPPORT_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details:
      stop === "refusal" ? { type: "refusal", category: "cyber", explanation: null } : null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function fakeModel(rounds: readonly Round[]): SupportModelClient & {
  requests: Anthropic.MessageStreamParams[];
} {
  const requests: Anthropic.MessageStreamParams[] = [];
  return {
    requests,
    stream(params) {
      const index = requests.length;
      // A deep copy: the turn appends to its messages after each round.
      requests.push(JSON.parse(JSON.stringify(params)) as Anthropic.MessageStreamParams);
      const round = rounds[index] ?? { text: ["(no more rounds)"] };
      return {
        async *[Symbol.asyncIterator]() {
          for (const piece of round.text ?? []) {
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: piece },
            } as Anthropic.MessageStreamEvent;
          }
        },
        finalMessage: async () => message(round, index),
      };
    },
  };
}

// -----------------------------------------------------------------------------
// The clinic
// -----------------------------------------------------------------------------

const ACCOUNT: AccountState = SUPPORT_ESCALATION_FIXTURE.accountRows[0];

const STATE = {
  clinic: {
    id: CLINIC_ID,
    slug: "glow",
    name: "Radiance Med Spa",
    specialty: "med-spa",
    timezone: "America/New_York",
    publishedPhoneE164: "+15125550100",
  },
  settings: {
    directLineE164: "+15125550101",
    transferE164: null,
    urgentHelpE164: "+15125550102",
    vetReferralE164: null,
  },
  knowledge: { services: [{ name: "Signature Glow Facial" }] },
  address: null as string | null,
} as unknown as SetupState;

type Sent = { to: string; message: OutgoingEmail };

function capture(): EmailTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    name: "capture",
    sent,
    async send(recipient, msg): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, message: msg });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: Sent[] };
}

/** What each escalation handed the case writer (lib/support/cases.ts is the database's; support-cases-db.test.ts). */
let recordedCases: Parameters<NonNullable<SupportChatContext["recordCase"]>>[0][] = [];
beforeEach(() => {
  recordedCases = [];
});

function context(
  client: SupportModelClient | null,
  over: Partial<SupportChatContext> = {},
): SupportChatContext {
  return {
    recordCase: async (input) => {
      recordedCases.push(input);
      return { outcome: "opened", caseId: "7a1b2c3d-0000-4000-8000-000000000000", ref: "7F3KQ" };
    },
    clinicId: CLINIC_ID,
    slug: "glow",
    deviceKey: "device-a",
    actor: { type: "user", userId: "user-1", label: "Front desk Mac" },
    limiter: new SupportLimiter(),
    client,
    readAccount: async () => ({ account: ACCOUNT, state: STATE }),
    readForwarding: async () => null,
    now: new Date("2026-10-14T15:00:00Z"),
    newId: () => "6f1e2d3c-4b5a-4968-8776-655443322110",
    ...over,
  };
}

async function chat(
  ctx: SupportChatContext,
  text: string,
  history: { role: "user" | "assistant"; text: string }[] = [],
): Promise<{ events: SupportEvent[]; outcome: string }> {
  const events: SupportEvent[] = [];
  const outcome = await handleSupportChat(ctx, { history, text }, (e) => events.push(e));
  return { events, outcome };
}

function replyOf(events: readonly SupportEvent[]): string {
  let reply = "";
  for (const e of events) {
    if (e.type === "delta") reply += e.text;
    if (e.type === "replace") reply = e.text;
  }
  return reply;
}

// -----------------------------------------------------------------------------

describe("the request", () => {
  test("claude-opus-5-5, the help text cached as a static prefix, the clinic after it, five strict tools", () => {
    const system = buildSupportPrompt({
      clinicName: "Radiance Med Spa",
      audience: "patients",
      agreementKind: "baa",
      timeZone: "America/New_York",
      now: new Date("2026-10-14T15:00:00Z"),
    });
    const request = supportRequest({ system, messages: [{ role: "user", content: "Hi" }] });
    expect(request.model).toBe("claude-opus-5-5");
    // On the patient-data key, so one of the models whose retention the terms
    // and agreements describe; never a Covered Model (model-retention.ts).
    expect(PATIENT_MODEL_IDS).toContain(SUPPORT_MODEL);
    expect(request.output_config).toEqual({ effort: "low" });
    expect(request.tool_choice).toEqual({ type: "auto" });
    const blocks = request.system as Anthropic.TextBlockParam[];
    expect(blocks[0]).toEqual({
      type: "text",
      text: SUPPORT_PROMPT_STABLE,
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toMatchObject({ type: "text" });
    expect(blocks[1]!.cache_control).toBeUndefined();
    expect(blocks[1]!.text).toContain("Radiance Med Spa");
    expect(blocks[1]!.text).toContain("Wednesday, October 14, 2026");

    // The prefix is the same bytes for every clinic and every day.
    const other = buildSupportPrompt({
      clinicName: "Paws Vet",
      audience: "clients",
      agreementKind: "dpa",
      timeZone: "America/Chicago",
      now: new Date("2027-01-02T09:00:00Z"),
    });
    expect(other.stable).toBe(system.stable);
    expect(system.stable).not.toMatch(/Radiance|2026-10-14|October 14/);

    expect(SUPPORT_TOOLS.map((t) => t.name)).toEqual([
      "get_account_state",
      "get_forwarding_steps",
      "link_to",
      "get_open_cases",
      "escalate_to_support",
    ]);
    for (const tool of SUPPORT_TOOLS) {
      expect(tool.strict, tool.name).toBe(true);
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
    }
  });

  test("the tone layer: every rule and every banned phrase is in the cached prefix, before the help text", () => {
    for (const rule of SUPPORT_TONE_RULES) expect(SUPPORT_PROMPT_STABLE, rule).toContain(rule);
    for (const phrase of SUPPORT_BANNED_PHRASES) expect(SUPPORT_TONE, phrase).toContain(`"${phrase}"`);
    expect(SUPPORT_PROMPT_STABLE.indexOf(SUPPORT_TONE)).toBeGreaterThan(0);
    expect(SUPPORT_PROMPT_STABLE.indexOf(SUPPORT_TONE)).toBeLessThan(SUPPORT_PROMPT_STABLE.indexOf(HELP_TEXT));
    // Signed by the team, never a first name.
    expect(SUPPORT_TONE).toContain('signed "The Healdesk Team", never with a first name');
    // The prefix names no clinic and no day, so the tone block keeps it cacheable.
    expect(SUPPORT_TONE).not.toMatch(/\b20\d\d\b/);
  });

  test("a scripted reply with an exclamation mark or a banned phrase fails the tone lint; a calm one passes", () => {
    const calm =
      "Calls are going to your direct line, so nobody is missed. The forwarding codes are in Settings, Channels; once they are set, AYA answers from the next call.";
    expect(lintSupportTone(calm)).toEqual([]);
    expect(lintSupportTone(`${calm} All done!`)).toEqual([{ rule: "exclamation" }]);
    expect(lintSupportTone(`Unfortunately the calendar disconnected. ${calm}`)).toEqual([
      { rule: "banned_phrase", phrase: "unfortunately" },
    ]);
  });

  test("the help text is partly generated from the Settings registry: every switch is in it", () => {
    for (const key of SETTING_KEYS) {
      expect(HELP_TEXT, key).toContain(`link_to "${key}"`);
      expect(HELP_TEXT, key).toContain(SETTING_PLACES[key].label);
    }
    expect(HELP_TEXT).not.toMatch(/HIPAA compliant\b(?!")/);
  });

  /**
   * Released with the Data Protection Agreement on 20 October 2026: a practice
   * under it signed no business associate agreement, and a vet's people are
   * clients. The prefix every clinic shares names neither agreement as the
   * practice's; the turn says which one this practice signed, in its own word.
   */
  test("the agreement the chat describes is the practice's own: a business associate agreement, or a data protection agreement", () => {
    const at = new Date("2026-10-20T15:00:00Z");
    const turn = (agreementKind: "baa" | "dpa" | null, audience: "patients" | "clients") =>
      buildSupportPrompt({ clinicName: "A Practice", audience, agreementKind, timeZone: "UTC", now: at }).turn;

    for (const baa of [turn("baa", "patients"), turn(null, "patients")]) {
      expect(baa).toContain(
        'Its agreement with healdesk is a business associate agreement: say "we sign a business associate agreement and handle patient data under it".',
      );
      expect(baa).not.toMatch(/data protection agreement/);
    }

    const vet = turn("dpa", "clients");
    expect(vet).toContain(
      'Its agreement with healdesk is a data protection agreement, not a business associate agreement: say "we sign a data protection agreement and handle your clients\' information under it", and never that healdesk signs a business associate agreement with it.',
    );
    expect(vet).toContain(
      'If asked how that information is protected, say "healdesk protects it with the safeguards it uses where HIPAA does apply, the HIPAA Security Rule\'s included".',
    );
    expect(vet).not.toMatch(/\bpatients?\b(?!" and)/);
    expect(vet).not.toMatch(/HIPAA compliant/);

    const spa = turn("dpa", "patients");
    expect(spa).toContain(
      'say "we sign a data protection agreement and handle your patients\' information under it"',
    );
    expect(spa).not.toContain("handle patient data under it");

    // The prefix every clinic shares claims neither agreement for the practice.
    expect(SUPPORT_PROMPT_STABLE).not.toContain(
      "we sign a business associate agreement and handle patient data under it",
    );
    expect(SUPPORT_PROMPT_STABLE).not.toMatch(/HIPAA compliant\b(?!")/);
    expect(HELP_TEXT).not.toContain("so patients never dial AYA directly");
  });

  test("a vet's turn reaches the model with its own agreement and its own word", async () => {
    const model = fakeModel([{ text: ["Sure."] }]);
    const vetState = {
      ...STATE,
      clinic: { ...STATE.clinic, name: "Paws & Claws", specialty: "veterinary", agreementKind: "dpa" },
    } as unknown as SetupState;
    await chat(context(model, { readAccount: async () => ({ account: ACCOUNT, state: vetState }) }), "Is my data safe?");
    const system = model.requests[0]!.system as Anthropic.TextBlockParam[];
    expect(system[1]!.text).toContain("It serves clients");
    expect(system[1]!.text).toContain("handle your clients' information under it");
    expect(system[1]!.text).toContain("never that healdesk signs a business associate agreement with it");
  });

  test("the help text says where the build's three answers are given, and that AYA waits on them", () => {
    // It said all three were "in Knowledge", which has no most-asked field.
    expect(HELP_TEXT).not.toContain("all in Knowledge");
    expect(HELP_TEXT).toContain("Until all three are there AYA isn't built");
    expect(HELP_TEXT).toContain(
      "the most-asked question is answered only on Setup's most-asked question screen, as Knowledge has no field for it.",
    );
  });
});

describe("the screen, before the model and before the person", () => {
  test("a caller's number, a stranger's address and a treatment never reach the model; the person sees what it saw", async () => {
    const model = fakeModel([{ text: ["Thanks, I can help with that."] }]);
    const { events } = await chat(
      context(model),
      "Why didn't AYA book (512) 555-0199 for Botox? Her email is jane.doe@gmail.com",
    );
    const sent = JSON.stringify(model.requests);
    expect(sent).not.toMatch(/555-0199|5550199|jane\.doe|botox/i);
    expect(events[0]).toEqual({
      type: "screened",
      text: "Why didn't AYA book [number hidden] for [treatment]? Her email is [email hidden]",
      notices: [
        "We hid a phone number or an email address: this chat is for questions about healdesk, not about a person.",
        "We hide treatment names here.",
      ],
    });
    const user = model.requests[0]!.messages.at(-1)!;
    expect(user.content).toBe(
      "Why didn't AYA book [number hidden] for [treatment]? Her email is [email hidden]",
    );
  });

  test("the practice's own numbers pass both ways", async () => {
    const model = fakeModel([
      { text: ["Your direct line is (512) 555-0101 and it's set correctly in Safety net. "] },
    ]);
    const { events } = await chat(context(model), "Is (512) 555-0100 our main number?");
    expect(events[0]).toMatchObject({ text: "Is (512) 555-0100 our main number?", notices: [] });
    expect(replyOf(events)).toContain("(512) 555-0101");
  });

  test("the earlier messages are screened again: the browser is not trusted to have kept them screened", () => {
    const allow = screenAllowFor(STATE, SUPPORT_PHONE);
    const messages = messagesFor(
      [
        { role: "assistant", text: "Hello, how can I help?" },
        { role: "user", text: "My patient at 512-555-0199 wants Dysport" },
        { role: "assistant", text: "I can't look at a patient here." },
      ],
      "OK, how do I change the greeting?",
      allow,
    );
    expect(messages).toEqual([
      { role: "user", content: "My patient at [number hidden] wants [treatment]" },
      { role: "assistant", content: "I can't look at a patient here." },
      { role: "user", content: "OK, how do I change the greeting?" },
    ]);
  });

  test("a treatment name in the model's reply is hidden before the person reads it", async () => {
    const model = fakeModel([
      {
        text: [
          "To list a price for Bo",
          "tox or a lip fil",
          "ler, open Knowledge and then Prices, and save the list.",
        ],
      },
    ]);
    const { events } = await chat(context(model), "How do I add a price?");
    const reply = replyOf(events);
    expect(reply).not.toMatch(/botox|filler/i);
    expect(reply).toBe(
      "To list a price for [treatment] or a [treatment], open Knowledge and then Prices, and save the list.",
    );
  });

  test("a request body is read strictly: twenty messages at most, each cut at 2,000 characters", () => {
    expect(readChatRequest({ text: 5 })).toBeNull();
    expect(readChatRequest({ text: "hi", history: [{ role: "system", text: "x" }] })).toBeNull();
    const long = readChatRequest({
      text: "x".repeat(5_000),
      history: Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        text: "y",
      })),
    });
    expect(long?.text).toHaveLength(2_000);
    expect(long?.history).toHaveLength(20);
  });
});

describe("a refusal", () => {
  test("is its own outcome: the reply so far gives way to the fixed line with the phone and hello@, and its tools never run", async () => {
    const accountState = vi.fn(async () => ACCOUNT);
    const model = fakeModel([
      {
        text: [
          "Sure, here is a long answer that starts streaming before the model declines. ",
          "More words follow here.",
        ],
        tools: [{ name: "get_account_state", input: {} }],
        stop: "refusal",
      },
    ]);
    const ctx = context(model, {
      readAccount: async () => {
        await accountState();
        return { account: ACCOUNT, state: STATE };
      },
    });
    const { events, outcome } = await chat(ctx, "Tell me something");
    expect(outcome).toBe("refused");
    const replace = events.filter((e) => e.type === "replace");
    expect(replace).toEqual([
      {
        type: "replace",
        text: "I can't help with that here. A person can: please call (888) 688-9404 or email hello@healdesk.io.",
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "refused" });
    expect(replyOf(events)).not.toContain("More words");
    // Only the read at the start of the turn: the refused turn's tool never ran.
    expect(accountState).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
  });

  test("without a support phone set, the line gives the email alone", async () => {
    delete process.env.HEALDESK_SUPPORT_PHONE;
    const { events } = await chat(context(fakeModel([{ stop: "refusal" }])), "Tell me something");
    expect(replyOf(events)).toBe(
      "I can't help with that here. A person can: please email hello@healdesk.io.",
    );
  });

  test("no key, or a model that fails, gives the failure line with the same phone and email", async () => {
    const none = await chat(context(null), "How do I change the greeting?");
    expect(none.outcome).toBe("failed");
    expect(replyOf(none.events)).toContain("call (888) 688-9404 or email hello@healdesk.io");

    const broken: SupportModelClient = {
      stream() {
        throw new Error("overloaded");
      },
    };
    const failed = await chat(context(broken), "How do I change the greeting?");
    expect(failed.outcome).toBe("failed");
    expect(replyOf(failed.events)).toContain("hello@healdesk.io");
  });
});

describe("the limits", () => {
  test("per device: past the hour's messages the same fixed line, and the model is not asked", async () => {
    const limiter = new SupportLimiter();
    const model = fakeModel(
      Array.from({ length: SUPPORT_LIMITS.device.perHour + 1 }, () => ({ text: ["Answer."] })),
    );
    const ctx = context(model, { limiter });
    for (let i = 0; i < SUPPORT_LIMITS.device.perHour; i += 1) {
      expect((await chat(ctx, `Question ${i}`)).outcome).toBe("answered");
    }
    const past = await chat(ctx, "One more");
    expect(past.outcome).toBe("limited");
    expect(replyOf(past.events)).toBe(
      "I can't help with that here. A person can: please call (888) 688-9404 or email hello@healdesk.io.",
    );
    expect(model.requests).toHaveLength(SUPPORT_LIMITS.device.perHour);

    // Another device at the same clinic still gets answers.
    expect((await chat({ ...ctx, deviceKey: "device-b" }, "Hello")).outcome).toBe("answered");
  });

  test("per clinic: a clinic past its day's messages is limited on every device", async () => {
    const limiter = new SupportLimiter();
    const now = new Date("2026-10-14T15:00:00Z").getTime();
    for (let i = 0; i < SUPPORT_LIMITS.clinic.perDay; i += 1) {
      expect(limiter.take("message", CLINIC_ID, `device-${i}`, now)).toBe(true);
    }
    const model = fakeModel([{ text: ["Answer."] }]);
    const { outcome } = await chat(context(model, { limiter, deviceKey: "device-new" }), "Hello");
    expect(outcome).toBe("limited");
    expect(model.requests).toHaveLength(0);
  });

  test("the windows: an hour per device, a day per device and per clinic; a refused use counts nothing", () => {
    const limiter = new SupportLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < SUPPORT_LIMITS.device.perHour; i += 1) {
      expect(limiter.take("message", "c1", "d1", t0)).toBe(true);
    }
    expect(limiter.take("message", "c1", "d1", t0)).toBe(false);
    expect(limiter.take("message", "c1", "d1", t0 + 60 * 60 * 1000)).toBe(true);

    for (let i = 0; i < SUPPORT_LIMITS.device.escalationsPerDay; i += 1) {
      expect(limiter.take("escalation", "c2", "d2", t0)).toBe(true);
    }
    expect(limiter.take("escalation", "c2", "d2", t0)).toBe(false);
    // The clinic's own escalations: other devices until the clinic's day is full.
    let taken = SUPPORT_LIMITS.device.escalationsPerDay;
    for (let d = 3; taken < SUPPORT_LIMITS.clinic.escalationsPerDay; d += 1, taken += 1) {
      expect(limiter.take("escalation", "c2", `d${d}`, t0)).toBe(true);
    }
    expect(limiter.take("escalation", "c2", "d-other", t0)).toBe(false);
    expect(limiter.take("escalation", "c2", "d-other", t0 + 24 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("get_forwarding_steps", () => {
  const ready: ForwardingFacts = {
    phoneStepsNumberE164: "+15125550142",
    carrier: "verizon",
    phoneSystem: "landline",
    mode: "overflow_after_hours",
    isClosed: false,
  };

  test("returns nothing until voice is ready: no number until phone is ready on our side, or a closed account", () => {
    expect(forwardingStepsFrom({ ...ready, phoneStepsNumberE164: null })).toBeNull();
    expect(forwardingStepsFrom({ ...ready, phoneStepsNumberE164: "5125550142" })).toBeNull();
    expect(forwardingStepsFrom({ ...ready, isClosed: true })).toBeNull();
  });

  test("a closed account gets the undo steps alone, which need no number", () => {
    // The cancellation email asks the clinic to undo forwarding before the
    // pass-through days end, and Settings shows a closed account nothing.
    for (const facts of [{ ...ready, isClosed: true }, { ...ready, isClosed: true, phoneStepsNumberE164: null }]) {
      const answer = forwardingAnswerFrom(facts)!;
      expect(answer).toMatchObject({ closed: true, carrier: "Verizon" });
      expect(answer.undo.map((s) => s.dial)).toEqual(["*43", "", "*73"]);
      expect(JSON.stringify(answer)).not.toContain("5125550142");
    }
    expect(forwardingAnswerFrom(ready)).toEqual(forwardingStepsFrom(ready));
  });

  test("through the chat, a closed account is told to undo forwarding now, never to leave it", async () => {
    const answer = forwardingAnswerFrom({ ...ready, carrier: "att", isClosed: true })!;
    const line = answer.undo.find((s) => s.label.includes("800.288.2020"))!;
    const model = fakeModel([
      { tools: [{ name: "get_forwarding_steps", input: {} }] },
      { text: [line.label] },
    ]);
    const { events } = await chat(
      context(model, { readForwarding: async () => answer }),
      "How do I undo call forwarding?",
    );
    const result = model.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    const told = result[0]!.content as string;
    expect(told).toMatch(/^The service has ended/);
    expect(told).toMatch(/undo it now/);
    expect(told).not.toMatch(/not to change|Nothing yet/);
    expect(told).toContain("Cancel busy forwarding on AT&T Phone: *91#");
    // The carrier's own number in an undo step still reads as a number.
    expect(replyOf(events)).toBe(line.label);
  });

  test("once voice is ready, the carrier's codes for the coverage mode, dialling AYA's number", () => {
    const steps = forwardingStepsFrom(ready)!;
    expect(steps.carrier).toBe("Verizon");
    expect(steps.mode).toBe("Overflow and after hours");
    // Verizon's home phone (*42, or *41 if the test call fails) and its
    // mobile line (*71); the two steps after them have nothing to dial: the
    // warning about a machine answering first, and the test call.
    expect(steps.steps.map((s) => s.dial)).toEqual(["*425125550142", "*715125550142", "", ""]);
    expect(steps.steps.at(-1)!.label).toMatch(/^Then test it/);
    // *43 on the home phone, the service-order step with nothing to dial, *73 on the mobile line.
    expect(steps.undo.map((s) => s.dial)).toEqual(["*43", "", "*73"]);
  });

  test("through the chat: before voice is ready the model is told there is nothing, and makes up no code", async () => {
    const model = fakeModel([
      { tools: [{ name: "get_forwarding_steps", input: {} }] },
      { text: ["Phone isn't ready for forwarding yet, so don't change your call forwarding yet."] },
    ]);
    await chat(context(model), "What do I dial to forward calls?");
    const result = model.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(result[0]!.content).toMatch(/^Nothing yet: phone isn't ready for call forwarding/);
  });

  test("once ready, AYA's number in the codes passes the screen", async () => {
    const steps = forwardingStepsFrom(ready);
    const model = fakeModel([
      { tools: [{ name: "get_forwarding_steps", input: {} }] },
      {
        text: [
          "From the main line, dial *42 512-555-0142, and if a test call doesn't reach AYA, dial *43, then *41 512-555-0142. Undo with *43.",
        ],
      },
    ]);
    const { events } = await chat(context(model, { readForwarding: async () => steps }), "Codes?");
    expect(replyOf(events)).toContain("*42 512-555-0142");
    expect(replyOf(events)).toContain("*41 512-555-0142");
  });

  test("a carrier's service number in the steps passes the screen: a traditional AT&T landline is set up by calling AT&T", async () => {
    const steps = forwardingStepsFrom({ ...ready, carrier: "att" })!;
    const line = steps.steps.find((s) => s.label.includes("800.288.2020"))!;
    expect(line.label).toMatch(/^On a traditional AT&T landline/);
    const model = fakeModel([
      { tools: [{ name: "get_forwarding_steps", input: {} }] },
      { text: [`${line.label} ${line.dial}`] },
    ]);
    const { events } = await chat(context(model, { readForwarding: async () => steps }), "Codes?");
    expect(replyOf(events)).toBe(`${line.label} ${line.dial}`);
    expect(replyOf(events)).not.toContain("[number hidden]");
  });

  test("every number the steps print passes the screen, for every carrier, phone system and coverage mode", async () => {
    // Whatever the chat repeats from get_forwarding_steps reads as the
    // steps do: no carrier service number or AYA's number comes out hidden.
    expect(CARRIER_SERVICE_NUMBERS.length).toBeGreaterThan(0);
    for (const carrier of [...CARRIERS.map((c) => c.id), null]) {
      for (const phoneSystem of ["landline", "voip", "unknown"] as const) {
        for (const mode of COVERAGE_MODES) {
          const steps = forwardingStepsFrom({ ...ready, carrier, phoneSystem, mode })!;
          const said = [...steps.steps, ...steps.undo]
            .map((s) => (s.dial ? `${s.label} ${s.dial}` : s.label))
            .concat(steps.notes)
            .join("\n");
          const model = fakeModel([
            { tools: [{ name: "get_forwarding_steps", input: {} }] },
            { text: [said] },
          ]);
          const { events } = await chat(
            context(model, { readForwarding: async () => steps }),
            "Codes?",
          );
          expect(replyOf(events), `${carrier} ${phoneSystem} ${mode}`).toBe(said);
        }
      }
    }
  });

  test("a carrier service number is let through only once the steps have given it", async () => {
    // The steps are why the number is in the reply; a reply that names it
    // without reading them is screened like any other number.
    const model = fakeModel([{ text: ["Call 800.288.2020 about it."] }]);
    const { events } = await chat(context(model), "Who do I call?");
    expect(replyOf(events)).toBe("Call [number hidden] about it.");
  });
});

describe("link_to", () => {
  test("built from the public origin, never HEALDESK_APP_URL, to the card that holds the switch", () => {
    for (const target of LINK_TARGETS) {
      const link = linkTo("glow", target);
      expect(link!.url.startsWith(`${ORIGIN}/c/glow`), target).toBe(true);
      expect(link!.url).not.toContain(INTERNAL);
    }
    // Bookings is a screen of this build since package E, so the chat links it.
    expect(linkTo("glow", "bookings")).toEqual({
      label: "Bookings",
      url: `${ORIGIN}/c/glow/bookings`,
    });
    expect(linkTo("glow", "direct_line")).toEqual({
      label: "Settings → Safety net → Direct line",
      url: `${ORIGIN}/c/glow/settings#safety-net`,
    });
  });

  test("through the chat: a button under the reply, once; an unknown target gives none", async () => {
    const model = fakeModel([
      {
        tools: [
          { name: "link_to", input: { setting: "phone_greeting" } },
          { name: "link_to", input: { setting: "chat_greeting" } },
          { name: "link_to", input: { setting: "https://evil.test" } },
        ],
      },
      { text: ["Both greetings are in Settings, under How AYA talks."] },
    ]);
    const { events } = await chat(context(model), "Where's the greeting?");
    expect(events.filter((e) => e.type === "link")).toEqual([
      {
        type: "link",
        label: "Settings → How AYA talks → When AYA answers a call",
        url: `${ORIGIN}/c/glow/settings#how-aya-talks`,
      },
    ]);
  });
});

describe("an escalation", () => {
  const CHAT_WORDS = "Marisol says the zebra-striped handsets keep dropping our quokka line";
  const MODEL_WORDS = "I'll pass this to the healdesk team about the pangolin trouble.";

  test("emails hello@ the topic, the fields and the account state, never the chat's words, and no log line carries them", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const transport = capture();
    const model = fakeModel([
      {
        text: [MODEL_WORDS],
        tools: [
          {
            name: "escalate_to_support",
            input: {
              category: "forwarding",
              symptom: "calls_not_reaching_aya",
              fields: {
                carrier: "verizon",
                phone_system: "landline",
                mode: "overflow_after_hours",
                channel: "voice",
              },
            },
          },
        ],
      },
      { text: ["Done: a person will reply by Thursday."] },
    ]);
    const { events, outcome } = await chat(context(model, { email: { transport } }), CHAT_WORDS, [
      { role: "user", text: "Earlier the wombat greeting was wrong" },
      { role: "assistant", text: "You can change the narwhal greeting in Settings." },
    ]);
    expect(outcome).toBe("answered");
    // The capture works: the turn and the escalation each wrote their line.
    expect(lines.some((l) => l.includes("support escalation sent"))).toBe(true);
    expect(lines.some((l) => l.includes("support chat turn"))).toBe(true);

    expect(transport.sent).toHaveLength(1);
    const [email] = transport.sent;
    expect(email!.to).toBe("hello@healdesk.io");
    const everything = JSON.stringify(email!.message);
    for (const word of ["zebra", "quokka", "Marisol", "wombat", "narwhal", "pangolin"]) {
      expect(everything, word).not.toContain(word);
      expect(lines.join("\n"), word).not.toContain(word);
    }
    expect(email!.message.subject).toBe("Support request: Call forwarding");
    expect(email!.message.text).toContain("What's wrong: Calls aren't reaching AYA");
    expect(email!.message.text).toContain("Carrier: Verizon");
    expect(email!.message.text).toContain("Practice id: 0c1d2e3f-0000-4000-8000-000000000000");
    expect(email!.message.text).toContain("Channel: Phone: ready on healdesk's side");
    // The channel field is dropped: forwarding doesn't carry one.
    expect(email!.message.text).not.toMatch(/^Channel: Phone$/m);
    expect(email!.message.idempotencyKey).toBe(
      "hd-support_escalation-6f1e2d3c-4b5a-4968-8776-655443322110-1",
    );
    // No clinic tag: a bounce from our own inbox says nothing about the clinic's address.
    expect(email!.message.tags?.map((t) => t.name)).toEqual(["app", "kind", "delivery"]);

    expect(events.filter((e) => e.type === "escalated")).toEqual([
      { type: "escalated", topic: "forwarding", replyByOn: "2026-10-15", to: null },
    ]);

    // Once I3 has gone, the request becomes a case: its id, the fields and
    // L25's day, never a word of the chat.
    expect(recordedCases).toHaveLength(1);
    expect(recordedCases[0]).toMatchObject({
      clinicId: CLINIC_ID,
      requestId: "6f1e2d3c-4b5a-4968-8776-655443322110",
      replyByOn: "2026-10-15",
      fields: {
        topic: "forwarding",
        symptom: "calls_not_reaching_aya",
        carrier: "verizon",
        phoneSystem: "landline",
        mode: "overflow_after_hours",
        channel: null,
      },
    });
    for (const word of ["zebra", "quokka", "Marisol", "wombat", "narwhal", "pangolin"]) {
      expect(JSON.stringify(recordedCases), word).not.toContain(word);
    }
  });

  test("a case that cannot be written is logged and the escalation still stands", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const transport = capture();
    const model = fakeModel([
      { tools: [{ name: "escalate_to_support", input: { category: "other", symptom: "other", fields: {} } }] },
      { text: ["Sent."] },
    ]);
    const { events } = await chat(
      context(model, {
        email: { transport },
        recordCase: async () => {
          throw new Error("database unavailable");
        },
      }),
      "Please get me a person",
    );
    expect(transport.sent).toHaveLength(1);
    expect(events.some((e) => e.type === "escalated")).toBe(true);
    expect(lines.some((l) => l.includes("support case not recorded"))).toBe(true);
  });

  test("an escalation that never reached hello@ opens no case", async () => {
    const model = fakeModel([
      { tools: [{ name: "escalate_to_support", input: { category: "other", symptom: "other", fields: {} } }] },
      { text: ["Please call or email us."] },
    ]);
    const failing: EmailTransport = {
      name: "failing",
      async send(): Promise<DeliveryResult> {
        return { status: "failed", reason: "transport_down" } as DeliveryResult;
      },
    } as EmailTransport;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await chat(context(model, { email: { transport: failing } }), "Please get me a person");
    expect(recordedCases).toHaveLength(0);
  });

  test("a topic or a symptom off its list sends nothing", async () => {
    const transport = capture();
    const model = fakeModel([
      {
        tools: [
          {
            name: "escalate_to_support",
            input: { category: "forwarding", symptom: "wont_connect", fields: {} },
          },
        ],
      },
      { text: ["Let me try that again."] },
    ]);
    await chat(context(model, { email: { transport } }), "Please get me a person");
    expect(transport.sent).toHaveLength(0);
  });

  test("past the escalation limit nothing is sent, and the model is told to give the phone and email", async () => {
    const transport = capture();
    const limiter = new SupportLimiter();
    const now = new Date("2026-10-14T15:00:00Z").getTime();
    for (let i = 0; i < SUPPORT_LIMITS.device.escalationsPerDay; i += 1) {
      limiter.take("escalation", CLINIC_ID, "device-a", now);
    }
    const model = fakeModel([
      {
        tools: [
          {
            name: "escalate_to_support",
            input: { category: "other", symptom: "other", fields: {} },
          },
        ],
      },
      { text: ["Please call or email us."] },
    ]);
    await chat(context(model, { email: { transport }, limiter }), "Please get me a person");
    expect(transport.sent).toHaveLength(0);
    const result = model.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(result[0]).toMatchObject({ is_error: true });
    expect(String(result[0]!.content)).toContain("hello@healdesk.io");
  });
});
