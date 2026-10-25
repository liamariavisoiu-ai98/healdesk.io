import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { closeSupportCase, recordChatEscalation } from "@/lib/support/cases";
import { openCasesText, readOpenCases, type OpenCase } from "@/lib/support/draft/open-cases";
import { supportLines } from "@/lib/support/lines";
import type { SupportModelClient } from "@/lib/support/model";
import { SUPPORT_PROMPT_STABLE } from "@/lib/support/prompt";
import { SUPPORT_TOOLS } from "@/lib/support/tools";
import { runSupportTurn, type SupportToolbox } from "@/lib/support/turn";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * The portal chat's get_open_cases (design E5 §8 S8; owner D16; lane P7b):
 * the practice's own open requests as dates, topics and states, so the chat
 * says "we have your request from Tuesday" instead of opening a second case.
 * Only dates and states cross: never a ref, an id or a word of text, and
 * never another clinic's request.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "support-open-cases-test" } as const;
const TUESDAY = new Date("2026-10-27T15:00:00Z");

const OPEN: OpenCase[] = [
  { openedOn: "2026-10-27", category: "forwarding", state: "drafted", replyByOn: "2026-10-29" },
  { openedOn: "2026-10-20", category: "billing", state: "waiting_clinic", replyByOn: "2026-10-21" },
];

describe("get_open_cases", () => {
  test("is a strict tool with no input, offered before the escalation", () => {
    const names = SUPPORT_TOOLS.map((t) => t.name);
    expect(names.indexOf("get_open_cases")).toBeLessThan(names.indexOf("escalate_to_support"));
    const tool = SUPPORT_TOOLS.find((t) => t.name === "get_open_cases")!;
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  test("the chat's rules say to look first and to answer with the day it opened and the reply-by day", () => {
    expect(SUPPORT_PROMPT_STABLE).toContain("Before escalate_to_support, call get_open_cases.");
    expect(SUPPORT_PROMPT_STABLE).toContain("We have your request from Tuesday; a person replies by Thursday");
  });

  test("its result: days, topics and where each stands, nothing else", () => {
    expect(openCasesText(OPEN)).toBe(
      [
        "This practice's open support requests (dates, topics and where each stands; never anyone's words):",
        "- Opened Tuesday 27 October 2026 (2026-10-27), about Call forwarding: with the healdesk team; a person replies by Thursday 29 October 2026 (2026-10-29).",
        "- Opened Tuesday 20 October 2026 (2026-10-20), about Billing or an invoice: healdesk replied by email and is waiting on the practice.",
      ].join("\n"),
    );
    expect(openCasesText([])).toBe("This practice has no open support requests.");
  });

  test("the chat runs it and the model reads only that text", async () => {
    const requests: Anthropic.MessageStreamParams[] = [];
    const rounds: Anthropic.Message[] = [
      { content: [{ type: "tool_use", id: "toolu_1", name: "get_open_cases", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "We have your request from Tuesday; a person replies by Thursday.", citations: null }], stop_reason: "end_turn" },
    ].map((r, i) => ({ id: `msg_${i}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...r }) as unknown as Anthropic.Message);
    const client: SupportModelClient = {
      stream(params) {
        const round = rounds[requests.length]!;
        requests.push(JSON.parse(JSON.stringify(params)));
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => round };
      },
    };
    const tools: SupportToolbox = {
      accountState: async () => null,
      forwardingSteps: async () => null,
      linkTo: () => null,
      openCases: async () => OPEN,
      escalate: async () => ({ status: "failed" }) as never,
    };
    const outcome = await runSupportTurn({
      client,
      system: { stable: "s", turn: "t" },
      messages: [{ role: "user", content: "Did you get my request about forwarding?" }],
      tools,
      screen: { numbers: [], emails: [] },
      lines: supportLines(null),
      emit: () => {},
    });
    expect(outcome).toBe("answered");
    const toolResult = (requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(toolResult.content).toBe(openCasesText(OPEN));
  });
});

describeDb("readOpenCases", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePools();
  });

  test("the practice's own open cases, as days, topics and states only; never a closed one or another clinic's", async () => {
    const mine = await seedClinic("opencases-mine");
    const other = await seedClinic("opencases-other");
    const fields = (topic: "forwarding" | "billing" | "calendar") => ({ topic, symptom: "other", carrier: null, phoneSystem: null, mode: null, channel: null });
    const open = await recordChatEscalation({ clinicId: mine.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("forwarding"), replyByOn: "2026-10-28", now: TUESDAY });
    const done = await recordChatEscalation({ clinicId: mine.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("billing"), replyByOn: "2026-10-28", now: TUESDAY });
    await closeSupportCase(done.caseId, "no_reply_needed", TUESDAY);
    const theirs = await recordChatEscalation({ clinicId: other.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("calendar"), replyByOn: "2026-10-28", now: TUESDAY });

    const cases = await readOpenCases(mine.clinicId);
    expect(cases).toEqual([{ openedOn: "2026-10-27", category: "forwarding", state: "new", replyByOn: "2026-10-28" }]);
    for (const c of cases) expect(Object.keys(c).sort()).toEqual(["category", "openedOn", "replyByOn", "state"]);

    const text = openCasesText(cases);
    for (const secret of [open.ref, open.caseId, theirs.ref, theirs.caseId, other.clinicId, mine.clinicId]) {
      expect(text).not.toContain(secret);
    }
    const { rows } = await getMigratorPool().query(`select count(*)::int as n from support_cases where subject_clinic_id = $1`, [mine.clinicId]);
    expect(rows[0]!.n).toBe(2);
  });
});
