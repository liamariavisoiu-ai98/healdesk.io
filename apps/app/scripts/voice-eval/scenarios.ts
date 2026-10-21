import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serviceNames, unknownQuestions } from "./clinics";
import { EVAL_SPECIALTIES, type EvalSpecialty } from "./rubric";

/**
 * The scenario library: synthetic callers, 30 per specialty, kept as data
 * files (scenarios/<specialty>.json) so a reviewer reads exactly what runs.
 * The files are written by generate-scenarios.ts from generateScenarios()
 * below, which is deterministic (a seeded generator, no clock, no network):
 * tests/voice-eval-scenarios.test.ts regenerates them and fails if a file
 * was edited by hand or went stale.
 *
 * Every caller is made up: first names from a fixed list, numbers in the
 * 555-01xx range reserved for fiction, pets with storybook names. Nothing
 * here comes from a real call; we keep no transcripts to take it from.
 *
 * `scripted` is what the caller says in a dry run (the mock caller reads it
 * in order); a real run hands `persona`, `goal` and `opening` to the caller
 * simulator (caller.ts), which improvises from there.
 */

export const ARCHETYPES = [
  "anxious",
  "rushed",
  "rambling",
  "price_shopping",
  "angry",
  "hard_of_hearing",
  "wrong_number",
  "cut_off_redial",
  "interrupting",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

export const INTENTS = ["book", "price", "practical", "unknown", "reschedule"] as const;
export type Intent = (typeof INTENTS)[number];

export type Scenario = {
  id: string;
  specialty: EvalSpecialty;
  archetype: Archetype;
  intent: Intent;
  /** The caller's synthetic first name and number (555-01xx). */
  callerName: string;
  callerNumber: string;
  /** At a veterinary practice, the animal's (storybook) name. */
  petName: string | null;
  /** When the caller would like to come in, in their words. */
  preferredTime: string;
  /** What the caller wants from the call. */
  goal: string;
  /** How the caller behaves, for the simulator. */
  persona: string;
  /** The caller's first line, said verbatim on a real run as on a dry run. */
  opening: string;
  /** The rest of the caller's lines in a dry run. */
  scripted: string[];
  /** The caller hangs up after this many of their own turns at most. */
  maxTurns: number;
  /** A cut-off: the first call drops after this many caller turns, then they call back. */
  cutAfterTurns: number | null;
  /** The first line of the call back, for a cut-off. */
  redialOpening: string | null;
  /** What the judge should look for in this scenario beyond the rubric. */
  notes: string;
};

// ----------------------------------------------------------------------------
// Deterministic pieces
// ----------------------------------------------------------------------------

/** FNV-1a: a stable 32-bit seed from a string. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG, so the same id always draws the same caller. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

/** Common first names, chosen for being generic; no surnames are ever used. */
const FIRST_NAMES = [
  "Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Robin", "Avery",
  "Quinn", "Drew", "Rowan", "Elliot", "Harper", "Reese", "Skyler", "Emery", "Parker", "Blake",
] as const;

const PET_NAMES = ["Biscuit", "Pepper", "Mochi", "Clover", "Waffles", "Juniper", "Noodle", "Pickles"] as const;
const PET_KINDS = ["dog", "cat", "rabbit"] as const;

const TIMES = [
  "Thursday afternoon",
  "next Tuesday morning",
  "this Saturday before noon",
  "Monday around ten",
  "Wednesday at two",
  "Friday morning",
] as const;

/** +1 415 555 01NN, NN from 50 to 99: the fictional range, kept clear of the practice's own 40-44. */
function fictionalNumber(rand: () => number): string {
  const nn = 50 + Math.floor(rand() * 50);
  return `+1415555${String(100 + nn).padStart(4, "0")}`;
}

/** The number as a caller says it aloud: "four one five, five five five, zero one five two". */
export function saidNumber(e164: string): string {
  const digits = e164.replace(/^\+1/, "");
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const say = (part: string) => [...part].map((d) => words[Number(d)]).join(" ");
  return `${say(digits.slice(0, 3))}, ${say(digits.slice(3, 6))}, ${say(digits.slice(6))}`;
}

// ----------------------------------------------------------------------------
// What each specialty's callers ask about
// ----------------------------------------------------------------------------

type IntentText = { goal: string; ask: string; follow: string[] };

function intentText(specialty: EvalSpecialty, intent: Intent, rand: () => number, s: { name: string; time: string; number: string; pet: string | null; kind: string }): IntentText {
  const services = serviceNames(specialty);
  const service = services[1] ?? services[0]!;
  const unknown = pick(rand, unknownQuestions(specialty));
  const forWhom = s.pet ? ` for my ${s.kind}, ${s.pet}` : "";
  const myName = s.pet ? `I'm ${s.name}, ${s.pet}'s owner.` : `My name's ${s.name}.`;
  switch (intent) {
    case "book":
      return {
        goal: `Book a ${service.toLowerCase()} appointment${forWhom}, ideally ${s.time}.`,
        ask: `I'd like to book a ${service.toLowerCase()}${forWhom}.`,
        follow: [`${s.time[0]!.toUpperCase()}${s.time.slice(1)} would be ideal.`, `${myName} You can reach me on ${saidNumber(s.number)}.`],
      };
    case "price":
      return {
        goal: `Find out what a ${service.toLowerCase()} costs, and maybe book a consultation.`,
        ask: `How much is a ${service.toLowerCase()}?`,
        follow: ["Is there anything cheaper to start with?", `Okay. ${myName} Maybe I'll come in ${s.time}.`],
      };
    case "practical":
      return {
        goal: "Check opening hours and parking before a first visit.",
        ask: "What time are you open on Saturdays?",
        follow: ["And is there parking nearby?", "Great, that's all I needed."],
      };
    case "unknown":
      return {
        goal: `Get an answer to: "${unknown}" (the practice's facts do not say).`,
        ask: unknown,
        follow: ["Are you sure? Can you just guess?", `Fine. ${myName} Have someone call me on ${saidNumber(s.number)}.`],
      };
    case "reschedule":
      return {
        goal: `Move an existing appointment${forWhom} to ${s.time}.`,
        ask: `I need to move my appointment${forWhom}.`,
        follow: [`${myName} It was booked for Monday.`, `Could we do ${s.time} instead?`],
      };
  }
}

// ----------------------------------------------------------------------------
// How each kind of caller behaves
// ----------------------------------------------------------------------------

const WRONG_TARGETS = [
  { place: "a pizza place", line: "Hi, is this the pizza place on Elm Street? I'd like a large pepperoni for pickup." },
  { place: "a hardware store", line: "Hello, do you have any ten-foot ladders in stock?" },
  { place: "a hotel", line: "Hi, I'm calling to check in late tonight, the booking's under Jordan." },
] as const;

function persona(archetype: Archetype): string {
  switch (archetype) {
    case "anxious":
      return "Nervous and a little hesitant; says so early. Needs reassurance before details. Polite.";
    case "rushed":
      return "In a hurry, short sentences, wants answers fast, may say they have to go soon.";
    case "rambling":
      return "Chatty, tells side stories, buries the actual question in the middle of long turns.";
    case "price_shopping":
      return "Comparing several practices on price; asks for numbers directly and pushes for a deal.";
    case "angry":
      return "Frustrated (long hold times, a past mix-up); curt and annoyed but not abusive, calms down if handled well.";
    case "hard_of_hearing":
      return "Hard of hearing; sometimes asks the assistant to repeat or mishears a number or day.";
    case "wrong_number":
      return "Dialled the wrong business by mistake and is confused at first.";
    case "cut_off_redial":
      return "Ordinary caller whose first call drops part-way; calls straight back and expects to pick up where they left off.";
    case "interrupting":
      return "Cuts in before the assistant finishes, changes direction mid-sentence, adds details out of order.";
  }
}

function openingFor(archetype: Archetype, ask: string): string {
  switch (archetype) {
    case "anxious":
      return `Hi, um, sorry, I'm honestly a bit nervous calling about this. ${ask}`;
    case "rushed":
      return `Quick one, I've only got a minute. ${ask}`;
    case "rambling":
      return `Hi there, so my sister was telling me about you the other day, we were at her place for dinner and it came up, anyway, ${/^I\b/.test(ask) ? ask : `${ask[0]!.toLowerCase()}${ask.slice(1)}`}`;
    case "price_shopping":
      return `Hi, I'm ringing round a few places to compare. ${ask}`;
    case "angry":
      return `I've been trying to get through for ages and honestly I'm pretty annoyed. ${ask}`;
    case "hard_of_hearing":
      return `Hello? Sorry, I don't hear very well on the phone, so bear with me. ${ask}`;
    case "cut_off_redial":
    case "interrupting":
    case "wrong_number":
      return ask;
  }
}

function scriptedFor(archetype: Archetype, follow: string[]): string[] {
  switch (archetype) {
    case "hard_of_hearing":
      return ["Sorry, could you say that again a bit slower?", ...follow];
    case "interrupting":
      return [`Sorry, wait. ${follow[0]!}`, ...follow.slice(1)];
    case "angry":
      return [...follow.slice(0, 1), "That's the third time I've had to explain this.", ...follow.slice(1)];
    default:
      return follow;
  }
}

const NOTES: Readonly<Record<Archetype, string>> = {
  anxious: "Look for a brief acknowledgement of the nerves before facts.",
  rushed: "Look for very short replies that respect the caller's time.",
  rambling: "Look for the assistant finding the real question and gently steering.",
  price_shopping: "Look for listed prices given plainly, one at a time, and an offer of a consultation where no price is listed.",
  angry: "Look for acknowledging the frustration once, without grovelling, then fixing the problem.",
  hard_of_hearing: "Look for patient repetition, slower simpler wording, and confirming numbers and days back.",
  wrong_number: "Look for a kind, quick correction (this is a different business) and a natural close.",
  cut_off_redial: "Look for a graceful restart on the call back without blaming the caller.",
  interrupting: "Look for the assistant following the caller's change of direction without losing track.",
};

/** The 30 callers for one specialty: each archetype with three intents, plus three more unknown-fact probes. */
export function generateScenarios(specialty: EvalSpecialty): Scenario[] {
  const out: Scenario[] = [];
  const plan: { archetype: Archetype; intent: Intent; variant: number }[] = [];
  ARCHETYPES.forEach((archetype, a) => {
    for (let k = 0; k < 3; k += 1) plan.push({ archetype, intent: INTENTS[(a + k * 2) % INTENTS.length]!, variant: k });
  });
  for (const archetype of ["anxious", "angry", "hard_of_hearing"] as const) plan.push({ archetype, intent: "unknown", variant: 3 });

  for (const { archetype, intent, variant } of plan) {
    const id = `${specialty}-${archetype}-${intent}-${variant}`;
    const rand = prng(seedOf(id));
    const name = pick(rand, FIRST_NAMES);
    const number = fictionalNumber(rand);
    const pet = specialty === "veterinary" ? pick(rand, PET_NAMES) : null;
    const kind = pick(rand, PET_KINDS);
    const time = pick(rand, TIMES);
    const text = intentText(specialty, intent, rand, { name, time, number, pet, kind });
    const wrong = WRONG_TARGETS[variant % WRONG_TARGETS.length]!;
    const isWrong = archetype === "wrong_number";
    out.push({
      id,
      specialty,
      archetype,
      intent: isWrong ? "practical" : intent,
      callerName: name,
      callerNumber: number,
      petName: pet,
      preferredTime: time,
      goal: isWrong ? `Reach ${wrong.place}; this practice is the wrong number.` : text.goal,
      persona: persona(archetype),
      opening: isWrong ? wrong.line : openingFor(archetype, text.ask),
      scripted: isWrong ? ["Oh! Sorry, wrong number then.", "Thanks, bye."] : scriptedFor(archetype, text.follow),
      maxTurns: 8,
      cutAfterTurns: archetype === "cut_off_redial" ? 2 : null,
      redialOpening: archetype === "cut_off_redial" ? `Hi, sorry, I was just talking to you and the call dropped. ${text.ask}` : null,
      notes: NOTES[archetype],
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// The data files
// ----------------------------------------------------------------------------

export const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), "scenarios");

export function scenarioFile(specialty: EvalSpecialty): string {
  return join(SCENARIO_DIR, `${specialty}.json`);
}

/** The JSON a data file holds: stable formatting so a regenerated file is byte-identical. */
export function scenarioFileText(specialty: EvalSpecialty): string {
  return `${JSON.stringify(generateScenarios(specialty), null, 2)}\n`;
}

/** Read the reviewed data files (not the generator): what a run uses. */
export function loadScenarios(specialties: readonly EvalSpecialty[] = EVAL_SPECIALTIES): Scenario[] {
  return specialties.flatMap((s) => JSON.parse(readFileSync(scenarioFile(s), "utf8")) as Scenario[]);
}
