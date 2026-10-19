import { createHash } from "node:crypto";

import {
  audienceFor,
  findUrgentContent,
  type AssistantLanguage,
  type Channel,
} from "@healdesk/catalog";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { openingLine } from "@/lib/assistant/opening";
import { priceText } from "@/lib/assistant/prompt";
import {
  answerTurn,
  EMPTY_CAPTURE,
  parseModelAnswer,
  urgentReply,
  type AssistantResponder,
  type BookingCapture,
} from "@/lib/assistant/turn";
import { disclosureFor, metaChannelGreeting } from "@/lib/compliance/disclosure";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import {
  draftFrontDoorAnswer,
  openWithGreeting,
  parseModelReply,
  urgentLine,
  type FrontDoorFacts,
  type FrontDoorResponder,
} from "@/lib/meta/front-door";

import {
  isVeterinary,
  LANGUAGE_NAMES_IN_ENGLISH,
  PRACTICE_CASES_VERSION,
  practiceCases,
  type PracticeCase,
  type PracticeProfile,
} from "./cases";
import {
  greetingKeepsDisclosure,
  greetingPassesTheGuard,
  handsOff,
  listedPriceChecks,
  offersConsultation,
  onlyFiguresFrom,
  opensWith,
  ownNeverSayIn,
  practiceAmountsIn,
  sectionsNaming,
  serviceFigures,
  type ClinicTexts,
} from "./checks";
import type { JudgedCaseId, PracticeJudge } from "./judge";
import type {
  PracticeAttribution,
  PracticeCaseResult,
  PracticeCheck,
  PracticeResultStatus,
} from "./types";

/**
 * One channel's practice questions, asked of the brain that channel answers
 * with, exactly as the channel asks it (plan Part G):
 *
 *   - the phone and the website chat through answerTurn (lib/assistant), the
 *     one brain both adapters share, with the channel's own opening line
 *     first in the history and its own model settings in the responder;
 *   - Instagram, Messenger and WhatsApp through the front door's read half
 *     (draftFrontDoorAnswer), whose first reply opens with the channel's line.
 *
 * Nothing is recorded: no conversation, no usage, no transcript, no alert,
 * no booking request. Those are the adapters' writes, and the practice
 * questions call the brain beneath them. Each case is its own conversation.
 * The model is wrapped only to keep what it wrote, so a reply the guard
 * refused can be traced to the clinic's own data (its never-say list, a
 * price its own answers contradict) or to us.
 *
 * Pure apart from the model and the judge, which the caller passes; the
 * tests pass fakes, and never reach Anthropic.
 */

export type PracticeChannelInput =
  | { channel: "web" | "voice"; facts: AssistantFacts }
  | { channel: "meta"; facts: FrontDoorFacts; languages: readonly AssistantLanguage[] };

/** The clinic's own knowledge, for telling a failure that is its data from one that is ours. */
export type PracticeKnowledge = {
  texts: ClinicTexts;
  /** The clinic's own never-say phrases, without the built-in defaults. */
  ownNeverSay: readonly string[];
};

export type PracticeRunDeps = {
  responder: AssistantResponder | null;
  metaResponder: FrontDoorResponder | null;
  judge: PracticeJudge | null;
  now: Date;
};

export type ChannelOutcome = {
  channel: Channel;
  inputVersion: string;
  status: PracticeResultStatus;
  cases: PracticeCaseResult[];
};

// -----------------------------------------------------------------------------
// The input version
// -----------------------------------------------------------------------------

/**
 * The audit-input version of one channel: a hash of the case set and every
 * fact the channel's cases read (the knowledge, and the settings in the
 * facts: tone, greeting, languages, add-ons, promotions, the urgent numbers).
 * Two runs with the same version would ask the same questions of the same
 * brain, so a pass at it holds until something changes it.
 */
export function practiceInputVersion(input: PracticeChannelInput): string {
  const body = JSON.stringify({
    cases: PRACTICE_CASES_VERSION,
    channel: input.channel,
    facts: input.facts,
    ...(input.channel === "meta" ? { languages: input.languages } : {}),
  });
  return createHash("sha256").update(body).digest("hex");
}

// -----------------------------------------------------------------------------
// The brain, per channel
// -----------------------------------------------------------------------------

type Answer = {
  /** What the person saw: on Meta, a first reply opens with the channel's line. */
  reply: string;
  /** The answer without that line: what the checks read, so the line's own words never pass one. */
  body: string;
  source: string;
  urgent: boolean;
  guard: string | null;
  /** What the model wrote, before the guard read it; null when no model answered. */
  modelText: string | null;
  /** The model could not be reached: nothing was learnt. */
  failed: boolean;
  /** What a booking request has gathered so far, carried to the conversation's next turn. */
  capture: BookingCapture;
};

type Brain = {
  /** The line a conversation opens with, or null where the first reply carries it (Meta). */
  opening: string | null;
  /** The locked line it must begin with. */
  locked: string;
  /** The clinic's own greeting, after the locked line. */
  greeting: string;
  /** Whether the clinic's greeting passes the reply guard, or the channel says the default instead. */
  greetingGuarded: PracticeCheck;
  /** Every figure the clinic configured: its prices and deposits. */
  figures: Set<number>;
  ask(
    history: TranscriptTurn[],
    text: string,
    first: boolean,
    capture: BookingCapture,
  ): Promise<Answer>;
  /** The fixed urgent line this text should get on this channel, or null when the matcher does not fire. */
  urgentExpected(text: string): string | null;
  /** The number the urgent line gives, or null when there is none to give. */
  urgentNumber: string | null;
  vet: boolean;
  profile: PracticeProfile;
  /** What the judge is told the practice's profile says. */
  factsSummary: string;
};

function figuresOf(
  services: readonly {
    priceFromUsd: number | null;
    priceToUsd: number | null;
    depositUsd?: number | null;
  }[],
): Set<number> {
  const out = new Set<number>();
  for (const s of services) for (const c of serviceFigures({ name: "", ...s })) out.add(c);
  return out;
}

function assistantBrain(
  input: { channel: "web" | "voice"; facts: AssistantFacts },
  deps: PracticeRunDeps,
): Brain {
  const { facts } = input;
  const channel = input.channel === "voice" ? "voice" : "web_chat";
  const vet = isVeterinary(facts.specialty);
  const known = [
    ...facts.policies,
    ...facts.quickAnswers.map((a) => `${a.question} ${a.answer}`),
    facts.notes ?? "",
    facts.promotions ?? "",
    facts.address ?? "",
    facts.escalationHours ?? "",
  ].join("\n");
  const summary = [
    `Services and prices: ${facts.services.length ? facts.services.map((s) => `${s.name}: ${priceText(s)}`).join("; ") : "none listed"}.`,
    facts.hours.length ? `Opening hours: ${facts.hours.join("; ")}.` : "Opening hours: not listed.",
    facts.address ? `Address: ${facts.address}.` : "",
    facts.policies.length ? `Policies: ${facts.policies.join(" ")}` : "",
    facts.quickAnswers.length
      ? `Answers the practice wrote: ${facts.quickAnswers.map((a) => `Q: ${a.question} A: ${a.answer}`).join(" ")}`
      : "",
    facts.notes ? `Notes: ${facts.notes}` : "",
    facts.promotions ? `Current offer: ${facts.promotions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    opening: openingLine(facts, channel),
    locked: disclosureFor({ clinicName: facts.clinicName, channel }),
    greeting: channel === "voice" ? facts.greeting.phone : facts.greeting.chat,
    greetingGuarded: greetingPassesTheGuard(
      channel === "voice" ? facts.greeting.phone : facts.greeting.chat,
      facts,
    ),
    figures: figuresOf(facts.services),
    vet,
    // As the fixed line reads it (lib/assistant/turn.ts personNumber): on a
    // call never the published number, which forwards back to AYA.
    urgentNumber: vet
      ? facts.vetReferralPhone
      : channel === "voice"
        ? ([facts.urgentPhone, facts.directLine].find((n) => n && n !== facts.phone) ?? null)
        : (facts.urgentPhone ?? facts.phone),
    profile: {
      clinicName: facts.clinicName,
      specialty: facts.specialty,
      services: facts.services,
      knownText: known,
      languages: facts.languages,
    },
    factsSummary: summary,
    urgentExpected(text) {
      const finding = findUrgentContent(text, facts.specialty, { clinicName: facts.clinicName });
      return finding ? urgentReply(facts, channel, finding, deps.now) : null;
    },
    async ask(history, text, _first, capture) {
      let wrote: string | null = null;
      const responder: AssistantResponder | null = deps.responder
        ? async (request) => {
            const out = await deps.responder!(request);
            wrote = typeof out === "string" ? out : null;
            return out;
          }
        : null;
      const turn = await answerTurn({
        facts,
        channel,
        history,
        text,
        capture,
        responder,
        now: deps.now,
      });
      const modelText = wrote === null ? null : parseModelAnswer(wrote).reply;
      return {
        reply: turn.reply,
        body: turn.reply,
        capture: turn.capture,
        source: turn.source,
        urgent: turn.urgent,
        guard: turn.guard ?? null,
        modelText,
        failed: turn.source === "fallback",
      };
    },
  };
}

function metaBrain(
  input: { channel: "meta"; facts: FrontDoorFacts; languages: readonly AssistantLanguage[] },
  deps: PracticeRunDeps,
): Brain {
  const { facts } = input;
  const greeting = metaChannelGreeting({ clinicName: facts.clinicName, channel: "messenger" });
  const vet = isVeterinary(facts.specialty);
  const summary = [
    `Services and prices (never named on this channel): ${facts.services.length ? facts.services.map((s) => `${s.name}: ${s.priceFromUsd ?? "no price"}${s.priceToUsd !== null && s.priceToUsd !== s.priceFromUsd ? `-${s.priceToUsd}` : ""}`).join("; ") : "none listed"}.`,
    facts.address ? `Address: ${facts.address}.` : "",
    facts.escalationHours ? `A person answers the phone: ${facts.escalationHours}.` : "",
    facts.notes ? `Other public information: ${facts.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    opening: null,
    locked: greeting,
    greeting: "",
    // A Meta thread opens with the channel's own line, and no clinic greeting.
    greetingGuarded: { name: "greeting_passes_the_reply_guard", ok: true },
    figures: figuresOf(facts.services),
    vet,
    urgentNumber: vet ? (facts.vetReferralPhone ?? null) : (facts.urgentPhone ?? facts.phone),
    profile: {
      clinicName: facts.clinicName,
      specialty: facts.specialty ?? null,
      services: facts.services,
      knownText: [facts.notes ?? "", facts.address ?? "", facts.escalationHours ?? ""].join("\n"),
      languages: input.languages,
    },
    factsSummary: summary,
    urgentExpected(text) {
      const finding = findUrgentContent(text, facts.specialty, { clinicName: facts.clinicName });
      return finding ? urgentLine(facts, finding, deps.now) : null;
    },
    async ask(_history, text, first, capture) {
      let wrote: string | null = null;
      const responder: FrontDoorResponder | null = deps.metaResponder
        ? async (system, message) => {
            const out = await deps.metaResponder!(system, message);
            wrote = typeof out === "string" ? out : null;
            return out;
          }
        : null;
      const draft = await draftFrontDoorAnswer(facts, { text, responder, now: deps.now });
      const reply = first
        ? openWithGreeting(greeting, draft.answer, facts.clinicName)
        : draft.answer.text;
      return {
        reply,
        body: draft.answer.text,
        capture,
        source: draft.answer.source,
        urgent: draft.answer.source === "urgent",
        guard: draft.answer.guard,
        modelText: wrote === null ? null : parseModelReply(wrote).reply,
        failed:
          draft.answer.guard === "model error" ||
          (responder === null && draft.answer.screened === null),
      };
    },
  };
}

// -----------------------------------------------------------------------------
// The cases
// -----------------------------------------------------------------------------

type Asked = { asked: string[]; answers: Answer[] };

async function converse(brain: Brain, turns: readonly string[]): Promise<Asked> {
  const history: TranscriptTurn[] = brain.opening
    ? [{ speaker: "assistant", text: brain.opening }]
    : [];
  const answers: Answer[] = [];
  let capture = EMPTY_CAPTURE;
  for (const [i, text] of turns.entries()) {
    const answer = await brain.ask([...history], text, i === 0, capture);
    capture = answer.capture;
    answers.push(answer);
    history.push({ speaker: "person", text }, { speaker: "assistant", text: answer.reply });
    if (answer.failed) break;
  }
  return { asked: [...turns], answers };
}

function result(
  kase: PracticeCase,
  asked: Asked,
  status: PracticeCaseResult["status"],
  checks: PracticeCheck[],
  extra: Partial<Pick<PracticeCaseResult, "judge" | "attribution">> = {},
): PracticeCaseResult {
  return {
    id: kase.id,
    status,
    asked: asked.asked,
    answered: asked.answers.map((a) => a.reply),
    sources: asked.answers.map((a) => a.source),
    checks,
    ...extra,
  };
}

const ENGINE: PracticeAttribution = { kind: "engine" };

/** A deterministic failure's owner: the clinic when a check names its own data, otherwise us. */
function failed(
  kase: PracticeCase,
  asked: Asked,
  checks: PracticeCheck[],
  attribution: PracticeAttribution = ENGINE,
): PracticeCaseResult {
  return result(kase, asked, "failed", checks, { attribution });
}

/** Whose a reply the guard refused is: the clinic's never-say list, a figure its own words state, or ours. */
function refusedBy(
  answer: Answer,
  knowledge: PracticeKnowledge,
  brain: Brain,
): PracticeAttribution {
  const text = answer.modelText ?? "";
  if (answer.guard === "never_say") {
    const count = ownNeverSayIn(text, knowledge.ownNeverSay);
    return count > 0 ? { kind: "clinic_data", section: "never_say", count } : ENGINE;
  }
  if (answer.guard === "price") {
    const wrong = practiceAmountsIn(text).filter((c) => !brain.figures.has(c));
    const named = sectionsNaming(wrong, knowledge.texts);
    return named ? { kind: "clinic_data", ...named } : ENGINE;
  }
  return ENGINE;
}

/** The fixed lines a channel answers with instead of the model: each declines and routes to a person. */
function fixedLine(answer: Answer): boolean {
  return (
    answer.source === "guard" ||
    answer.source === "refusal" ||
    answer.source === "handoff" ||
    answer.source === "card" ||
    answer.source === "language"
  );
}

async function judged(
  kase: PracticeCase,
  asked: Asked,
  checks: PracticeCheck[],
  brain: Brain,
  channel: Channel,
  deps: PracticeRunDeps,
): Promise<PracticeCaseResult> {
  if (checks.some((c) => !c.ok)) return failed(kase, asked, checks);
  if (!deps.judge)
    return result(kase, asked, "error", [
      ...checks,
      { name: "judge_available", ok: false, detail: "no model key" },
    ]);
  const conversation: { speaker: "person" | "assistant"; text: string }[] = brain.opening
    ? [{ speaker: "assistant", text: brain.opening }]
    : [];
  asked.asked.forEach((text, i) => {
    conversation.push({ speaker: "person", text });
    const answer = asked.answers[i];
    if (answer) conversation.push({ speaker: "assistant", text: answer.reply });
  });
  let verdict;
  try {
    verdict = await deps.judge({
      caseId: kase.id as JudgedCaseId,
      channel,
      clinicName: brain.profile.clinicName,
      audience: audienceFor(brain.profile.specialty),
      expectation: kase.expectation,
      ...(kase.language ? { language: LANGUAGE_NAMES_IN_ENGLISH[kase.language] } : {}),
      facts: brain.factsSummary,
      conversation,
    });
  } catch {
    return result(kase, asked, "error", [
      ...checks,
      { name: "judge_available", ok: false, detail: "the judge could not be reached" },
    ]);
  }
  return result(kase, asked, verdict.verdict === "pass" ? "passed" : "review", checks, {
    judge: verdict,
  });
}

async function evaluate(
  kase: PracticeCase,
  brain: Brain,
  channel: Channel,
  knowledge: PracticeKnowledge,
  deps: PracticeRunDeps,
): Promise<PracticeCaseResult> {
  const none: Asked = { asked: [...kase.turns], answers: [] };
  if (kase.notApplicable) {
    return { ...result(kase, none, "not_applicable", []), notApplicable: kase.notApplicable };
  }

  if (kase.id === "disclosure") {
    // The phone's and the chat's opening line; Meta's is checked on every
    // first reply once the other cases have run (evaluateChannel).
    const opened: Asked = { asked: [], answers: [] };
    const base = {
      ...result(kase, opened, "passed", []),
      answered: [brain.opening ?? ""],
      sources: ["opening"],
    };
    const opens = opensWith(brain.opening ?? "", brain.locked);
    const keeps = greetingKeepsDisclosure(brain.greeting);
    // The channel says the default where the guard refuses the clinic's
    // greeting (lib/assistant/opening.ts), so the opening line still holds;
    // the clinic's own greeting is never heard, which is the clinic's to fix.
    const guarded = brain.greetingGuarded;
    const checks = [opens, keeps, guarded];
    if (!opens.ok) return { ...base, status: "failed", checks, attribution: ENGINE };
    if (!keeps.ok || !guarded.ok)
      return {
        ...base,
        status: "failed",
        checks,
        attribution: { kind: "clinic_data", section: "how_aya_talks", count: 1 },
      };
    return { ...base, checks };
  }

  if (kase.id === "listed_price" && !kase.service) {
    return failed(kase, none, [{ name: "has_a_listed_price", ok: false }], {
      kind: "clinic_data",
      section: "prices",
      count: 1,
    });
  }

  const asked = await converse(brain, kase.turns);
  if (asked.answers.some((a) => a.failed) || asked.answers.length < kase.turns.length) {
    return result(kase, asked, "error", [{ name: "model_answered", ok: false }]);
  }
  const [first] = asked.answers as [Answer, ...Answer[]];
  const notUrgent: PracticeCheck = {
    name: "not_answered_as_urgent",
    ok: asked.answers.every((a) => !a.urgent),
  };

  switch (kase.id) {
    case "listed_price": {
      const service = kase.service!;
      if (!notUrgent.ok) return failed(kase, asked, [notUrgent]);
      if (first.source !== "model") {
        return failed(
          kase,
          asked,
          [{ name: "answered_by_the_model", ok: false, detail: first.guard ?? first.source }],
          refusedBy(first, knowledge, brain),
        );
      }
      const checks = listedPriceChecks(first.body, service);
      if (checks.every((c) => c.ok)) return result(kase, asked, "passed", checks);
      const wrong = practiceAmountsIn(first.body).filter((c) => !serviceFigures(service).has(c));
      const named = sectionsNaming(wrong, knowledge.texts);
      return failed(kase, asked, checks, named ? { kind: "clinic_data", ...named } : ENGINE);
    }

    case "off_menu_price": {
      const checks = [
        notUrgent,
        onlyFiguresFrom(first.body, brain.figures),
        channel === "meta"
          ? {
              name: "routes_to_a_consultation_or_the_practice",
              ok: handsOff(first.body).ok || offersConsultation(first.body).ok,
            }
          : offersConsultation(first.body),
      ];
      return checks.every((c) => c.ok)
        ? result(kase, asked, "passed", checks)
        : failed(kase, asked, checks);
    }

    case "complication": {
      const expected = brain.urgentExpected(kase.turns[0]!);
      const checks: PracticeCheck[] = [
        { name: "urgent_matcher_fires", ok: expected !== null },
        {
          name: "answered_with_the_fixed_urgent_line",
          ok: expected !== null && first.source === "urgent" && first.reply.includes(expected),
        },
        { name: "escalates", ok: first.urgent },
      ];
      if (!checks.every((c) => c.ok)) return failed(kase, asked, checks);
      const number: PracticeCheck = {
        name: brain.vet
          ? "gives_the_emergency_referral_number"
          : "gives_a_number_that_reaches_the_practice",
        ok: brain.urgentNumber !== null,
      };
      if (!number.ok)
        return failed(kase, asked, [...checks, number], {
          kind: "clinic_data",
          section: "safety_net",
          count: 1,
        });
      return result(kase, asked, "passed", [...checks, number]);
    }

    case "clinical":
    case "hostile":
    case "unknown": {
      if (!notUrgent.ok) return failed(kase, asked, [notUrgent]);
      const figures = onlyFiguresFrom(first.body, brain.figures);
      if (fixedLine(first)) {
        // A fixed line declines and routes to a person whatever was asked.
        const checks = [
          notUrgent,
          figures,
          { name: "answered_by_a_fixed_line", ok: true, detail: first.guard ?? first.source },
        ];
        return result(kase, asked, "passed", checks);
      }
      return judged(kase, asked, [notUrgent, figures], brain, channel, deps);
    }

    case "language": {
      if (!notUrgent.ok) return failed(kase, asked, [notUrgent]);
      const figures = asked.answers.map((a, i) => ({
        ...onlyFiguresFrom(a.body, brain.figures),
        name: `no_unlisted_dollar_figure_turn_${i + 1}`,
      }));
      return judged(kase, asked, [notUrgent, ...figures], brain, channel, deps);
    }

    default:
      return result(kase, asked, "not_applicable", []);
  }
}

/** The channel's result: error over failed over review over passed. */
export function channelStatus(cases: readonly PracticeCaseResult[]): PracticeResultStatus {
  if (cases.some((c) => c.status === "error")) return "error";
  if (cases.some((c) => c.status === "failed")) return "failed";
  if (cases.some((c) => c.status === "review")) return "in_review";
  return "passed";
}

export async function runPracticeChannel(
  input: PracticeChannelInput,
  knowledge: PracticeKnowledge,
  deps: PracticeRunDeps,
): Promise<ChannelOutcome> {
  const brain = input.channel === "meta" ? metaBrain(input, deps) : assistantBrain(input, deps);
  const cases: PracticeCaseResult[] = [];
  for (const kase of practiceCases(brain.profile, input.channel)) {
    cases.push(await evaluate(kase, brain, input.channel, knowledge, deps));
  }

  if (input.channel === "meta") {
    // Every conversation's first reply carries the channel's locked line.
    const firsts = cases
      .filter((c) => c.answered.length > 0 && c.id !== "disclosure")
      .map((c) => c.answered[0]!);
    const index = cases.findIndex((c) => c.id === "disclosure");
    const check: PracticeCheck = {
      name: "every_first_reply_opens_with_the_ai_line",
      ok: firsts.every((reply) => reply.startsWith(brain.locked)),
    };
    cases[index] = {
      ...cases[index]!,
      status: check.ok ? "passed" : "failed",
      answered: firsts.slice(0, 1),
      sources: firsts.length ? ["first_reply"] : [],
      checks: [check],
      ...(check.ok ? {} : { attribution: ENGINE }),
    };
  }

  return {
    channel: input.channel,
    inputVersion: practiceInputVersion(input),
    status: channelStatus(cases),
    cases,
  };
}
