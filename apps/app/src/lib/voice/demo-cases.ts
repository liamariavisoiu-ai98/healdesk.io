import { DEMO_CALLBACK_OFFER, type DemoCallClinic } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";

import { CALLBACK_FAILED_LINE, callbackSentLine } from "./demo-callback";
import {
  demoRoleplayOpener,
  LOVE_THAT,
  shortClinicName,
  SKIPPED_ANSWER,
  talkSoonLine,
  type DemoBeat,
  type DemoProgress,
  type DemoQuestion,
  type DemoQuirk,
  type DemoStage,
} from "./demo-facts";

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

export const DEMO_CASES_VERSION = "2026-10-26.3";

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
  state: {
    asked?: DemoQuestion | null;
    beats?: DemoBeat[];
    callback?: { phone: string; note: string };
    pushback?: string;
    skip?: DemoQuestion;
    resume?: boolean;
    quirk?: DemoQuirk;
    end?: boolean;
  } | null = {},
): string {
  const details: Record<string, unknown> = { handoff: false, end: state?.end === true };
  if (state) {
    details.state = {
      asked: state.asked ?? null,
      beats: state.beats ?? [],
      ...(state.callback ? { callback: state.callback } : {}),
      ...(state.pushback ? { pushback: state.pushback } : {}),
      ...(state.skip ? { skip: state.skip } : {}),
      ...(state.resume ? { resume: true } : {}),
      ...(state.quirk ? { quirk: state.quirk } : {}),
    };
  }
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
  /** The pushback move the call holds after the turn (DemoProgress.pushback). */
  pushback?: DemoProgress["pushback"];
  /** Whether the answer ended the call. */
  ends?: boolean;
  /** The signature touches the call has said after the turn (DemoProgress.quirks; absent reads as none). */
  quirks?: readonly DemoQuirk[];
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
/** The short name the notes use after the opening line (demo-facts.ts, shortClinicName): "Lumen". */
const SHORT = shortClinicName(CLINIC);

/** The words close to the close and the live discount, none of which may reach a note before coverage is answered. */
export const CLOSE_WORDS: readonly string[] = [`Want to get ${SHORT} set up?`, "% off the setup fee", "discount", "Book Onboarding", "checkout"];

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
            `Not at all: Aya Voice for your phone, Aya Web Chat for your site, and Aya Meta Chat for Instagram, Messenger and WhatsApp. What brought you to an AI assistant?`,
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
        modelSays("Not at all: Aya Voice for your phone, Aya Web Chat for your site, and Aya Meta Chat for Instagram, Messenger and WhatsApp. So, what made you look into this?", { asked: "goal" }),
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
      check: { noGuardLine: true, answers: { coverage: "After hours, mostly." }, noteIncludes: [`Want to get ${SHORT} set up?`, "50% off the setup fee, for the next 46 hours"] },
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

const OFFER_CALL = DEMO_CALLBACK_OFFER.text;
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
        model: [modelSays(`Thanks so much for your time. ${talkSoonLine("Josh")}`, { quirk: "talkSoon", end: true })],
        check: {
          heardIncludes: ["Talk soon, Josh!"],
          ends: true,
          quirks: ["talkSoon"],
          noteIncludes: ["The team already has their call-back request: never offer a call-back again", 'your last words are exactly "Talk soon, Josh!"'],
          noteExcludes: [OFFER_CALL],
        },
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
        model: [modelSays("Thanks so much, Josh. Have a great day!")],
        // No sign-off after a call back that did not get through (6h, D).
        check: { noteIncludes: ["They already have hello at healdesk dot io: never offer a call-back again"], noteExcludes: ['your last words are exactly "Talk soon'] },
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

/** The words of every stage's shared rules (demo-facts.ts, TALK, DEFLECT, the pushback moves) the cases look for. */
const LENGTH_RULE = "Every reply is at most one short sentence of reaction, and often none, then one short sentence of content";
const NO_REFLECTION_RULE = 'never open with "Sounds like...", "It sounds like...", "I hear you"';
const SAY_AGAIN_RULE = 'say only something like "Sorry, say that again?" and wait; never repeat your question in its place';

/** Phase 6 (owner, 26 October 2026): what the last two test calls still did wrong. */
const phase6: DemoCase[] = [
  {
    id: "reply-length",
    title: "One short reaction at most, then one short sentence of content, in every stage",
    why: "6a: the transcripts opened nearly every reply with a reflection and a reassurance before the point; the cap is in every stage's note.",
    turns: [
      { ...TO_PITCH[0]!, check: { ...TO_PITCH[0]!.check, noteIncludes: [LENGTH_RULE] } },
      TO_PITCH[1]!,
      TO_PITCH[2]!,
      { ...TO_PITCH[3]!, check: { ...TO_PITCH[3]!.check, noteIncludes: [LENGTH_RULE] } },
      TO_PITCH[4]!,
      { caller: "Pretty good.", model: [modelSays(`Glad you liked it. What made you want to look at an AI assistant for ${SHORT}?`, { asked: "goal" })], check: { noteIncludes: [LENGTH_RULE] } },
    ],
  },
  {
    id: "no-reflection-opener",
    title: "A reply that opens by reflecting the caller's words back is noticed, and the next is told to skip it",
    why: `6c: "Sounds like you're losing business on calls you can't pick up" and "I hear you, Lia" opened nearly every reply.`,
    turns: [
      ...TO_VOLUME.slice(0, -1),
      {
        caller: "We miss calls when we're busy.",
        model: [modelSays("Sounds like you're losing business on calls you can't pick up. Generally, how many calls do you get a day?", { asked: "volume" })],
        check: { noteIncludes: [NO_REFLECTION_RULE, "Only when they voice something negative"] },
      },
      {
        caller: "Five.",
        model: [modelSays(volumeCheck("Five", 5).replace("a month?", "calls a month?"), { asked: "volumeCheck" })],
        check: { noteIncludes: ["Your recent replies opened by reflecting their words back"] },
      },
    ],
  },
  {
    id: "repeat-the-caller",
    title: 'Unclear words: "Sorry, say that again?", the question still asked, and their retry answers it',
    why: `6e: "sorry, I didn't catch that" followed by the whole question again; a person asks them to say it again and waits.`,
    turns: [
      ...TO_VOLUME,
      {
        caller: "Uh, the, the—",
        model: [modelSays("Sorry, say that again?")],
        check: { heard: "Sorry, say that again?", asked: "volume", noteIncludes: [SAY_AGAIN_RULE] },
      },
      {
        caller: "Five.",
        model: [modelSays(volumeCheck("Five", 5).replace("a month?", "calls a month?"), { asked: "volumeCheck" })],
        check: { answers: { volume: "Five." }, asked: "volumeCheck" },
      },
    ],
  },
  {
    id: "pushback-rotation",
    title: "Pushback: a move instead of the same question, the dropped question never asked again, and another move next time",
    why: "6f: after resistance she re-asked the same question; the moves rotate (skip, proof, permission, shortcut) and the call keeps which was used.",
    turns: [
      ...TO_VOLUME,
      {
        caller: "Why does that even matter? Just tell me what it does.",
        model: [modelSays("Fair enough, skip the numbers: every call after hours gets answered, and booked.", { pushback: "skip", skip: "volume" })],
        check: { answers: { volume: SKIPPED_ANSWER }, pushback: "skip", noteIncludes: ['"skip", drop the question and go straight to the point it was for'], noGuardLine: true },
      },
      {
        caller: "Okay, and?",
        model: [modelSays("What happens with those calls after hours right now?", { asked: "missed" })],
        check: { noteIncludes: ['and not "skip", which you used last'], noteExcludes: ['Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"'] },
      },
    ],
  },
  {
    id: "disinterest-then-contact-ask",
    title: "Not interested: the call back asked for once, then a warm close; a firm no gets only the goodbye",
    why: "6g: a clear disinterest signal ended the call outright; now one ask for a number, in the offer's own words, before a warm close.",
    turns: [
      TO_PITCH[0]!,
      {
        caller: "Honestly, I'm not interested.",
        model: [modelSays(DEMO_CALLBACK_OFFER.text, { asked: "callback" })],
        check: { heard: DEMO_CALLBACK_OFFER.text, asked: "callback", noteIncludes: [`answer with exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback), once in the call`, "Never push past a firm no"] },
      },
      {
        caller: "No thanks.",
        model: [modelSays("No worries at all, thanks for giving me a try, Josh. Have a great day!", { end: true })],
        check: { ends: true, noteIncludes: ["close on one short, genuinely warm note"] },
      },
    ],
  },
  {
    id: "firm-no-goodbye",
    title: "A firm refusal to go on: no ask, just a brief positive goodbye",
    why: "6g: never push past a hard no.",
    turns: [
      TO_PITCH[0]!,
      {
        caller: "Leave me alone.",
        model: [modelSays("Of course. Take care, Josh!", { end: true })],
        check: {
          ends: true,
          quirks: [],
          noteIncludes: ['If they firmly refuse to go on at all ("leave me alone", "stop calling", "I said no"), skip that question', 'one brief, positive goodbye with no "Talk soon"'],
        },
      },
    ],
  },
  {
    id: "disinterest-then-number",
    title: "Not interested, but a number given: the call back goes to the team from the intro, too",
    why: "6g with the delivery of DEMO-LEAD: the read-back and the one line work outside the pitch.",
    callbacks: [{ phoneE164: "+15125550147", note: "Pricing for two locations" }],
    turns: [
      TO_PITCH[0]!,
      { caller: "Honestly, I'm not interested right now.", model: [modelSays(DEMO_CALLBACK_OFFER.text, { asked: "callback" })] },
      { caller: "Fine, it's 512 555 0147.", model: [modelSays("That's five one two, five five five, oh one four seven, right? And what should the team come prepared with?", { asked: "callbackNote" })], check: { asked: "callbackNote" } },
      {
        caller: "Yes. Pricing for two locations.",
        model: [modelSays("Perfect.", { callback: { phone: "512 555 0147", note: "Pricing for two locations" } })],
        check: { heard: callbackSentLine("+15125550147"), callback: "sent", stage: "intro" },
      },
    ],
  },
  {
    id: "roleplay-resume",
    title: '"Wait, continue": the same role-play resumed with a recap, never refused and never restarted',
    why: `6d: after "how was that?" a caller who wanted to carry on was refused, or the role-play began again from "Ring ring!".`,
    turns: [
      ...TO_PITCH,
      {
        caller: "Wait, continue.",
        model: [modelSays("Right, you'd just booked Friday morning. Anything you'd like to know before your visit?", { resume: true })],
        check: {
          stage: "roleplay",
          heardExcludes: ["Ring ring"],
          noteIncludes: [
            'never refusing and never starting over with "Ring ring"',
            `Where it stopped: they said "Sure, Friday morning.", and you said "Perfect, the team will confirm Friday morning. Take care!"`,
          ],
        },
      },
    ],
  },
];

/** Aya's signature touches (owner, 26 October 2026, 6h: C and a revised D; demo-facts.ts, DEMO_QUIRKS). */
const LOVE_THAT_RULE = `your reaction may be exactly "${LOVE_THAT}"`;
const quirks: DemoCase[] = [
  {
    id: "quirk-love-that-once",
    title: `"${LOVE_THAT}" when they share good news, once in the call, and never in the role-play`,
    why: "6h, C: a warm micro-affirmation is recognisable once and a tic twice, so it leaves the note the moment it is said.",
    turns: [
      ...TO_PITCH,
      {
        caller: "Pretty good. And we just opened a second location in Round Rock!",
        model: [modelSays(`${LOVE_THAT} What made you want to look at an AI assistant for ${CLINIC}?`, { asked: "goal", quirk: "loveThat" })],
        check: { heardIncludes: [LOVE_THAT], quirks: ["loveThat"], asked: "goal", noteIncludes: [LOVE_THAT_RULE], noGuardLine: true },
      },
      {
        caller: "We also just hired two new injectors.",
        model: [modelSays("Busy times. Generally, how many calls do you get a day?", { asked: "volume" })],
        check: { quirks: ["loveThat"], noteIncludes: [`You already said "${LOVE_THAT}" on this call: never again.`], noteExcludes: [LOVE_THAT_RULE] },
      },
    ],
  },
];

/** "Better than competitors, never named" (owner, 26 October 2026; demo-facts.ts, POSITIONING). */
const positioning: DemoCase[] = [
  {
    id: "better-never-named",
    title: "Why healdesk over the others: confident, true, and no company named",
    why: `Owner, 26 October 2026: "AYA needs to say that we're better than competitors but should never name competition."`,
    turns: [
      ...TO_PITCH,
      {
        caller: "Why would I pick you over the other AI receptionists out there?",
        model: [modelSays("Unlike a phone-only bot, I answer your phone, website chat, Instagram, Messenger and WhatsApp together. What happens with your missed calls today?", { asked: "missed" })],
        check: {
          noGuardLine: true,
          heardIncludes: ["Unlike a phone-only bot"],
          noteIncludes: ["Say with confidence that Aya does more than the usual options", 'never name, describe or quote any company, and never say "the only"', "designed to send the clinic's own deposit link"],
        },
      },
    ],
  },
];

export const DEMO_CASES: readonly DemoCase[] = [...bareNumbers, ...discovery, josh, ...callbacks, ...phase6, ...quirks, ...positioning];
