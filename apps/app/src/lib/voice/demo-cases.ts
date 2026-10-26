import type { DemoCallClinic } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";

import { CALLBACK_FAILED_LINE, callbackSentLine } from "./demo-callback";
import { demoRoleplayOpener, type DemoBeat, type DemoProgress, type DemoQuestion, type DemoStage } from "./demo-facts";

/**
 * A personalised demo call's regression cases (owner, 25 October 2026: "every
 * fix must be provable against" the failing test call, and "regression-test
 * forever after"), the demo's counterpart of the practice questions' cases
 * (lib/engine/practice/cases.ts). Each is a scripted conversation run through
 * the real demo pipeline, the call session, its notes, the turn, the guard
 * and the fail-soft layer, by tests/voice-demo-cases.test.ts: the caller's
 * words, and for each of them what the model writes (more than one when the
 * guard refuses it and it is asked again), as written on the failing calls.
 * No model writes a case, so a case runs the same way every time; the
 * caller's words are kept apart from the model's, so a live eval can put the
 * same words to a real model.
 *
 * What each turn checks is written beside it: what the caller heard, the
 * note the model was given, the stage, and what the call kept (DemoProgress).
 * Bump DEMO_CASES_VERSION with any change to a case's words.
 *
 * Business data only, about a made-up clinic: the person on a demo call is
 * a clinic's owner talking about their business, never a patient.
 */

export const DEMO_CASES_VERSION = "2026-10-26.1";

/** The made-up clinic every case calls about. */
export const DEMO_CASE_CLINIC: DemoCallClinic = {
  clinicName: "Lumen Aesthetics",
  summary: "A boutique med spa in downtown Austin.",
  specialty: "med-spa",
  phone: "+15125550100",
  address: "200 Congress Ave, Austin, TX 78701",
  hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
  services: [
    { name: "Botox", description: null, price: "$12/unit", duration: "30 min" },
    { name: "HydraFacial", description: null, price: "$199", duration: "1 hour" },
    { name: "Lip Filler", description: null, price: "from $650", duration: null },
  ],
  providers: [{ name: "Dr. Maya Chen", title: "Medical Director" }],
  faqs: [],
  policies: ["24-hour cancellation policy."],
  booking: "Book online or by phone.",
  highlights: ["Voted best med spa in Austin"],
};

/** The requester's first name in every case. */
export const DEMO_CASE_FIRST_NAME = "Josh";

/** What the model writes for a call: the words, the delimiter, then the details with her state update. */
export function modelSays(
  words: string,
  state: { asked?: DemoQuestion | null; beats?: DemoBeat[]; callback?: { phone: string; note: string } } | null = {},
): string {
  const details: Record<string, unknown> = { handoff: false, end: false };
  if (state) details.state = { asked: state.asked ?? null, beats: state.beats ?? [], ...(state.callback ? { callback: state.callback } : {}) };
  return `${words}\n${SPOKEN_END}\n${JSON.stringify(details)}`;
}

export type DemoCaseCheck = {
  /** Exactly what the caller heard as the turn's answer. */
  heard?: string;
  heardIncludes?: readonly string[];
  heardExcludes?: readonly string[];
  /** None of the guard's fixed lines (guard.ts, guardedLine and movingOnLine) was heard on this turn. */
  noGuardLine?: boolean;
  /** The stage after the turn. */
  stage?: DemoStage;
  /** The question the call holds as asked after the turn. */
  asked?: DemoQuestion | null;
  /** Answers the call holds after the turn, each in the caller's words. */
  answers?: Partial<Record<DemoQuestion, string>>;
  /** Where a call back stands after the turn (DemoProgress.callback; absent reads as null). */
  callback?: DemoProgress["callback"];
  /** Words in the turn context the model was given first on this turn. */
  noteIncludes?: readonly string[];
  noteExcludes?: readonly string[];
};

export type DemoCaseTurn = {
  caller: string;
  /** What the model writes, in order: a later entry is its answer when asked again after a refusal. */
  model: string[];
  check?: DemoCaseCheck;
};

export type DemoCase = {
  id: string;
  title: string;
  /** What went wrong on a real call, and what the case pins. */
  why: string;
  /** A live discount on the demo, so a case can prove where it may and may not be said. */
  offer?: { percentOfSetupFee: number; hoursLeft: number };
  /** The case stands in for a transcript the owner has not yet handed over: rebuilt from his description. */
  reconstructed?: string;
  /** Whether apps/web takes a call-back request on this call (demo-callback.ts); taken unless false. */
  callbackTaken?: boolean;
  /** The call-back requests the call sends, in order; none unless listed. */
  callbacks?: readonly { phoneE164: string; note: string }[];
  turns: DemoCaseTurn[];
};

const CLINIC = DEMO_CASE_CLINIC.clinicName;

/** The words close to the close and the live discount, none of which may reach a note before coverage is answered. */
export const CLOSE_WORDS: readonly string[] = [`Want to get ${CLINIC} set up?`, "% off the setup fee", "discount", "Book Onboarding", "checkout"];

/** The start every case walks: who they are, their role, the choice, a short role-play, and out of it. */
const TO_PITCH: DemoCaseTurn[] = [
  {
    caller: "Yeah, that's me.",
    model: [modelSays(`Great to meet you! What's your role at ${CLINIC}?`, { asked: "role" })],
    check: { answers: { identity: "Yeah, that's me." }, asked: "role", noteIncludes: ["never ask it again"] },
  },
  {
    caller: "I'm the owner.",
    model: [modelSays(`Oh nice. Would you like to hear what I can do for ${CLINIC}, or jump straight into a quick role-play where you call in as a patient?`, { asked: "choice" })],
    check: { answers: { role: "I'm the owner." }, asked: "choice" },
  },
  {
    caller: "Whatever is best.",
    model: [modelSays(`Let's do it, you be the patient. ${demoRoleplayOpener(CLINIC)}`)],
    check: { stage: "roleplay" },
  },
  {
    caller: "Hi, how much is a HydraFacial?",
    model: [modelSays("A HydraFacial is $199. Want me to put in a booking request?")],
    check: { stage: "roleplay" },
  },
  {
    caller: "Sure, Friday morning.",
    model: [modelSays("Perfect, the team will confirm Friday morning. Take care! And that's the role-play! So, how was that?")],
    check: { stage: "pitch" },
  },
];

/** Out of the role-play to the volume question. */
const TO_VOLUME: DemoCaseTurn[] = [
  ...TO_PITCH,
  {
    caller: "Pretty good.",
    model: [modelSays(`Glad you liked it. What made you want to look at an AI assistant for ${CLINIC}?`, { asked: "goal" })],
    check: { asked: "goal", noGuardLine: true },
  },
  {
    caller: "We miss calls when we're busy.",
    model: [modelSays("That's the big one. Generally, how many calls do you get a day?", { asked: "volume" })],
    check: { answers: { goal: "We miss calls when we're busy." }, asked: "volume", noGuardLine: true },
  },
];

const COUNTS: readonly (readonly [string, number])[] = [
  ["Five", 5],
  ["Six", 6],
  ["12", 12],
  ["20", 20],
];

/**
 * The volume check the failing call's model wrote, with the month's figure
 * lacking the word "calls": the guard read "around 110" as a dose without its
 * unit and the caller heard the clinicians' line in answer to "Five".
 */
function volumeCheck(said: string, perDay: number): string {
  return `${said} a day, got it. I see you're open 5 days a week, so would it be fair to say about ${perDay * 5} calls a week, or around ${Math.round((perDay * 5 * 13) / 30) * 10} a month?`;
}

const bareNumbers: DemoCase[] = COUNTS.map(([said, perDay]) => ({
  id: `bare-number-${said.toLowerCase()}`,
  title: `A bare "${said}" to the volume question`,
  why: `The failing call: "Five" to "how many calls do you get a day?", and the model's volume check refused as clinical for a figure without the word "calls" after it (guard.ts, UNITLESS_DOSE), so the caller heard the clinicians' line.`,
  turns: [
    ...TO_VOLUME,
    {
      caller: said,
      model: [modelSays(volumeCheck(said, perDay), { asked: "volumeCheck" })],
      check: { heard: volumeCheck(said, perDay), noGuardLine: true, answers: { volume: said }, asked: "volumeCheck", stage: "pitch" },
    },
  ],
}));

/**
 * A month's figure in words, which the guard reads as a price ("a hundred and
 * ten" with no currency word), and rightly on a patient's call, where "a
 * hundred and ten a month" is a membership's price. One sentence, so it is
 * refused before a word of it is spoken; SPOKEN_MONTH_AFTER says a sentence
 * first, so the refusal comes midway.
 */
const SPOKEN_MONTH = "So would it be fair to say about twenty-five calls a week, or about a hundred and ten a month?";
const SPOKEN_MONTH_AFTER = `Five a day, got it. ${SPOKEN_MONTH}`;

const discovery: DemoCase[] = [
  {
    id: "bare-number-refused-then-answered",
    title: "A volume check the guard refuses is asked again, and the second answer is heard",
    why: "No text classifier is perfect: on a discovery turn a refused reply is asked again with the reason rather than answered with a guard line (turn.ts, softRefusal).",
    turns: [
      ...TO_VOLUME,
      {
        caller: "Five",
        model: [modelSays(SPOKEN_MONTH, { asked: "volumeCheck" }), modelSays(volumeCheck("Five", 5).replace("a month?", "calls a month?"), { asked: "volumeCheck" })],
        check: { heard: volumeCheck("Five", 5).replace("a month?", "calls a month?"), noGuardLine: true, asked: "volumeCheck" },
      },
    ],
  },
  {
    id: "bare-number-refused-twice",
    title: "Refused twice on a discovery turn: the recovery line, never the clinicians' line",
    why: "The fail-soft layer's last word: a person who lost the thread and moves on to the next question, which the call keeps as asked.",
    turns: [
      ...TO_VOLUME,
      {
        caller: "Five",
        model: [modelSays(SPOKEN_MONTH, { asked: "volumeCheck" }), modelSays(SPOKEN_MONTH, { asked: "volumeCheck" })],
        check: {
          heard: "Sorry, I lost my train of thought for a second there. You said 5 calls a day, so would it be fair to say about 25 calls a week?",
          noGuardLine: true,
          answers: { volume: "Five" },
          asked: "volumeCheck",
        },
      },
    ],
  },
  {
    id: "bare-number-refused-midway",
    title: "Refused after a sentence was already spoken: the bridge to the next question",
    why: "Replies are spoken sentence by sentence: once words are out, the turn ends on the next question rather than an apology mid-reply.",
    turns: [
      ...TO_VOLUME,
      {
        caller: "Five",
        model: [modelSays(SPOKEN_MONTH_AFTER, { asked: "volumeCheck" })],
        check: { heard: "Five a day, got it. So would it be fair to say about 25 calls a week?", noGuardLine: true, asked: "volumeCheck" },
      },
    ],
  },
  {
    id: "not-convinced-before-coverage",
    title: `"I'm not convinced" with missed calls and coverage unanswered: no close, no discount`,
    why: "The failing call asked for the sale after a guard loop, with missed calls and coverage never asked: the close and the discount are in no note until coverage is answered.",
    offer: { percentOfSetupFee: 50, hoursLeft: 40 },
    turns: [
      ...TO_VOLUME,
      { caller: "Five", model: [modelSays(volumeCheck("Five", 5).replace("a month?", "calls a month?"), { asked: "volumeCheck" })] },
      {
        caller: "Yeah, about that.",
        model: [modelSays("Got it. What happens with those calls after hours, or when your team's busy with patients?", { asked: "missed" })],
        check: { answers: { volumeCheck: "Yeah, about that." }, asked: "missed", noteExcludes: CLOSE_WORDS },
      },
      {
        caller: "I'm not convinced.",
        model: [modelSays("Fair enough. What would you need to see? And quickly, what happens with those calls after hours right now?", { asked: "missed" })],
        check: { noteExcludes: CLOSE_WORDS, noteIncludes: ['Next: ask: "How do you see me helping you best'], noGuardLine: true },
      },
    ],
  },
  {
    id: "channels-three-ways",
    title: `"Phone only?", "social media?", "WhatsApp?": one whole answer, and the repeat noticed`,
    why: "The failing call answered each channel question in part, once with \"I can't tell you which channels you'd get\": the note carries the whole answer from the catalog, and a question asked again is flagged as an answer that did not land.",
    turns: [
      ...TO_PITCH,
      {
        caller: "Is it phone only?",
        model: [
          modelSays(
            `Not at all: healdesk's Aya comes as Aya Voice for your phone line, Aya Web Chat on your website, and Aya Meta Chat for Instagram, Messenger and WhatsApp, website chat included. What made you want to look at an AI assistant for ${CLINIC}?`,
            { asked: "goal" },
          ),
        ],
        check: { noteIncludes: ["If channels come up at any point", "Aya Meta Chat for Instagram, Messenger and WhatsApp"], noGuardLine: true },
      },
      {
        caller: "What about social media?",
        model: [modelSays("All of it: Instagram, Messenger and WhatsApp are Aya Meta Chat, and it includes your website chat too. One Aya across every channel you pick.")],
        check: { noteIncludes: ["They asked nearly the same thing a moment ago"], noGuardLine: true },
      },
      {
        caller: "And WhatsApp?",
        model: [modelSays("Yes, WhatsApp too: it's part of Aya Meta Chat, alongside Instagram and Messenger.")],
        check: { noteIncludes: ["They asked nearly the same thing a moment ago"], noGuardLine: true },
      },
    ],
  },
  {
    id: "price-objection-after-quote",
    title: "A cost objection right after two prices were quoted is about those prices",
    why: "The failing call quoted prices in the role-play, heard \"that's a lot\", and answered \"I don't have a price for that one\": the note ties the objection to the price just quoted, and a made-up figure is asked again rather than met with the price line.",
    turns: [
      ...TO_PITCH.slice(0, 3),
      {
        caller: "How much are Botox and the HydraFacial?",
        model: [modelSays("Botox is $12 per unit, and the HydraFacial is $199.")],
        check: { stage: "roleplay" },
      },
      {
        caller: "Hmm, that's a lot.",
        model: [
          modelSays("We could do the HydraFacial for $150 for you."),
          modelSays("Fair, $199 is an investment. It covers the full facial, and the team can go through options at a consultation. Want me to request one?"),
        ],
        check: {
          heard: "Fair, $199 is an investment. It covers the full facial, and the team can go through options at a consultation. Want me to request one?",
          heardExcludes: ["I don't have a price for that one"],
          noteIncludes: ["the pushback is about that price"],
          stage: "roleplay",
        },
      },
    ],
  },
  {
    id: "price-objection-refused-midway",
    title: "A made-up figure after words already spoken: the consultation, never \"I don't have a price\"",
    why: "As on the failing call: \"I hear you.\" went out, the next sentence named a figure off the menu, and the turn ended on \"I don't have a price for that one\" just after two prices were quoted.",
    turns: [
      ...TO_PITCH.slice(0, 3),
      { caller: "How much are Botox and the HydraFacial?", model: [modelSays("Botox is $12 per unit, and the HydraFacial is $199.")] },
      {
        caller: "Hmm, that's a lot.",
        model: [modelSays("I hear you. We could do the HydraFacial for $150 for you.")],
        check: {
          heard: "I hear you. The team can go through the options and pricing with you at a consultation. Want me to request one?",
          heardExcludes: ["I don't have a price for that one"],
          stage: "roleplay",
        },
      },
    ],
  },
];

/**
 * The failing call of 25 October 2026 (reference d2d9a915-04a5-48cc-ba16-
 * 4711b931324d), as the owner described it: the identity asked twice, "Five"
 * answered with the clinicians' line, the channels asked three ways, a price
 * objection right after two prices, "I'm not convinced" at a close asked too
 * early. Rebuilt from that description until the transcript itself is in
 * hand, then replaced turn for turn.
 */
const josh: DemoCase = {
  id: "josh-lumen-d2d9a915",
  title: "The Josh / Lumen call, replayed",
  why: "Every failure of the owner's test call in one conversation; no guard line may reach the caller on any discovery turn after the role-play.",
  reconstructed: "Rebuilt from the owner's description; replace with transcript d2d9a915 turn for turn.",
  offer: { percentOfSetupFee: 50, hoursLeft: 46 },
  turns: [
    ...TO_PITCH.slice(0, 3),
    { caller: "How much are Botox and the HydraFacial?", model: [modelSays("Botox is $12 per unit, and the HydraFacial is $199.")] },
    {
      caller: "That's expensive.",
      model: [
        modelSays("Totally get it, maybe $150 works better."),
        modelSays("Fair, $199 covers the full facial, and the team can go through options at a consultation. Want me to put that request in?"),
      ],
      check: { heardExcludes: ["I don't have a price for that one"] },
    },
    {
      caller: "Okay, sure.",
      model: [modelSays("Done, the team will confirm. Take care! And that's the role-play! So, how was that?")],
      check: { stage: "pitch" },
    },
    {
      caller: "It was fine.",
      model: [modelSays(`Glad to hear it. What made you want to look at an AI assistant for ${CLINIC}?`, { asked: "goal" })],
      check: { noGuardLine: true, noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "Is it phone only?",
      model: [
        modelSays("Not at all: Aya Voice for your phone, Aya Web Chat on your website, and Aya Meta Chat for Instagram, Messenger and WhatsApp, website chat included. So, what made you look into this?", { asked: "goal" }),
      ],
      check: { noGuardLine: true, noteIncludes: ["If channels come up at any point"] },
    },
    {
      caller: "What about social media?",
      model: [modelSays("That's Aya Meta Chat: Instagram, Messenger and WhatsApp, with your website chat included. What made you look into this?", { asked: "goal" })],
      check: { noGuardLine: true, noteIncludes: ["They asked nearly the same thing a moment ago"] },
    },
    {
      caller: "We just miss a lot of calls.",
      model: [modelSays("That's exactly what I'm for. Generally, how many calls do you get a day?", { asked: "volume" })],
      check: { noGuardLine: true, answers: { goal: "We just miss a lot of calls." }, asked: "volume", noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "Five",
      model: [modelSays(volumeCheck("Five", 5), { asked: "volumeCheck" })],
      check: { heard: volumeCheck("Five", 5), noGuardLine: true, answers: { volume: "Five" }, asked: "volumeCheck", noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "I'm not convinced.",
      model: [modelSays("Fair enough. Let me ask it another way: would it be fair to say about 25 calls a week?", { asked: "volumeCheck" })],
      check: { noGuardLine: true, noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "Yeah.",
      model: [modelSays("Got it. What happens with those calls after hours, or when your team's busy with patients?", { asked: "missed" })],
      check: { noGuardLine: true, answers: { volumeCheck: "Yeah." }, asked: "missed", noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "They go to voicemail.",
      model: [modelSays("How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?", { asked: "coverage" })],
      check: { noGuardLine: true, asked: "coverage", noteExcludes: CLOSE_WORDS },
    },
    {
      caller: "After hours, mostly.",
      model: [modelSays("So those after-hours calls that go to voicemail, those are the ones I'd be picking up.", { beats: ["pain"] })],
      check: { noGuardLine: true, answers: { coverage: "After hours, mostly." }, noteIncludes: [`Want to get ${CLINIC} set up?`, "50% off the setup fee, for the next 46 hours"] },
    },
  ],
};

/** Through discovery to the first pitch beat: coverage answered, so the close and the call-back offer are in the note. */
const TO_COVERED: DemoCaseTurn[] = [
  ...TO_VOLUME,
  { caller: "Five", model: [modelSays(volumeCheck("Five", 5).replace("a month?", "calls a month?"), { asked: "volumeCheck" })] },
  { caller: "Yeah, about that.", model: [modelSays("Got it. What happens with those calls after hours, or when your team's busy with patients?", { asked: "missed" })] },
  {
    caller: "They go to voicemail.",
    model: [modelSays("How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?", { asked: "coverage" })],
  },
  {
    caller: "After hours, mostly.",
    model: [modelSays("So those after-hours calls that go to voicemail, those are the ones I'd be picking up.", { beats: ["pain"] })],
    check: { noteIncludes: ["Want someone from our team to give you a quick call?"] },
  },
];

const OFFER_CALL = "No problem at all. Want someone from our team to give you a quick call? What's the best number to reach you on?";
const READ_BACK = "That's five one two, five five five, oh one four seven, right? And what should the team come prepared with?";
const NUMBER = { phone: "512 555 0147", note: "Pricing for two locations" };

/** Hesitant at the close, the call back offered, the number given and read back, and the one line. */
function callbackTurns(): DemoCaseTurn[] {
  return [
    ...TO_COVERED,
    {
      caller: "I need to think about it.",
      model: [modelSays(OFFER_CALL, { asked: "callback" })],
      check: { heard: OFFER_CALL, noGuardLine: true, asked: "callback", callback: null },
    },
    {
      caller: "Sure, it's 512 555 0147.",
      model: [modelSays(READ_BACK, { asked: "callbackNote" })],
      check: { heard: READ_BACK, noGuardLine: true, asked: "callbackNote", noteIncludes: ["read it back digit by digit"], answers: { callback: "Sure, it's 512 555 0147." } },
    },
  ];
}

const callbacks: DemoCase[] = [
  {
    id: "callback-taken",
    title: "A hesitant owner asks for a call: the number goes to the team, and only then is the call promised",
    why: "Owner, 26 October 2026: lead capture on a demo that does not close. The team is said to have it only once apps/web took it, and the model's own words in that turn are never spoken.",
    callbacks: [{ phoneE164: "+15125550147", note: "Pricing for two locations" }],
    turns: [
      ...callbackTurns(),
      {
        caller: "Yes. Pricing for two locations.",
        model: [modelSays("Perfect.", { callback: NUMBER })],
        check: { heard: callbackSentLine("+15125550147"), noGuardLine: true, callback: "sent", asked: null, noteIncludes: ["add to the state a \"callback\" object"] },
      },
      {
        caller: "No, that's all, thanks.",
        model: [modelSays("Thanks so much, Josh! Talk soon.")],
        check: { noteIncludes: ["The team already has their call-back request: never offer a call-back again"], noteExcludes: [OFFER_CALL] },
      },
    ],
  },
  {
    id: "callback-not-taken",
    title: "The request does not get through: hello@, never a promise nobody received",
    why: "If apps/web is down, slow or refuses, the caller hears the team's address instead (lib/support/escalate.ts's rule).",
    callbackTaken: false,
    callbacks: [{ phoneE164: "+15125550147", note: "Pricing for two locations" }],
    turns: [
      ...callbackTurns(),
      {
        caller: "Yes. Pricing for two locations.",
        model: [modelSays("Perfect.", { callback: NUMBER })],
        check: { heard: CALLBACK_FAILED_LINE, noGuardLine: true, callback: "failed", heardExcludes: ["will call you"] },
      },
      {
        caller: "Okay, thanks.",
        model: [modelSays("Thanks so much, Josh! Talk soon.")],
        check: { noteIncludes: ["They already have hello at healdesk dot io: never offer a call-back again"] },
      },
    ],
  },
  {
    id: "callback-declined",
    title: "A call offered and turned down: the page's button and hello@, and nothing sent",
    why: "Only a number they give, for a call they asked for, ever leaves the call.",
    turns: [
      ...TO_COVERED,
      { caller: "I need to think about it.", model: [modelSays(OFFER_CALL, { asked: "callback" })] },
      {
        caller: "No thanks, I'll look at the page.",
        model: [modelSays("No problem at all. Whenever you're ready, Book Onboarding is right there on your demo page. Thanks so much, Josh!")],
        check: { noGuardLine: true, callback: null, asked: null, noteIncludes: ["If they gave no number or would rather not"] },
      },
    ],
  },
];

export const DEMO_CASES: readonly DemoCase[] = [...bareNumbers, ...discovery, josh, ...callbacks];
