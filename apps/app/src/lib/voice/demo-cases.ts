import { DEMO_CALLBACK_OFFER, type DemoCallClinic } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";

import { CALLBACK_FAILED_LINE, callbackSentLine } from "./demo-callback";
import {
  DEMO_ROLEPLAY_EXIT,
  demoRoleplayOpener,
  LOVE_THAT,
  ROLEPLAY_MAX_TURNS,
  WHICH_ONE_LINE,
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

export const DEMO_CASES_VERSION = "2026-10-31.3";

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
    roleplay?: "start" | "cancel" | "end";
    answered?: DemoQuestion[];
    impatient?: boolean;
    booking?: { service?: string; day?: string; time?: string; name?: string; phone?: string; status?: "requested" | "rescheduled" | "cancelled" };
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
      ...(state.roleplay ? { roleplay: state.roleplay } : {}),
      ...(state.answered ? { answered: state.answered } : {}),
      ...(state.impatient ? { impatient: true } : {}),
      ...(state.booking ? { booking: state.booking } : {}),
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
  /** Any other part of what the call kept after the turn (DemoProgress), matched as a subset. */
  progress?: Partial<DemoProgress>;
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

/**
 * In-character turns that move a role-play towards its ceiling and decide
 * nothing: since 31 October 2026 a role-play ends when it is done, and only
 * ROLEPLAY_MAX_TURNS caller turns end it otherwise (step 4), so the cases of
 * that ceiling walk this many more turns than they did at four.
 */
const FILLER_QUESTIONS = ["How long does it take?", "Do I need to prepare anything?", "Is there a cancellation fee?", "Can I pay when I'm there?"];
const ROLEPLAY_FILLER: DemoCaseTurn[] = Array.from({ length: ROLEPLAY_MAX_TURNS - 4 }, (_, i) => ({
  caller: FILLER_QUESTIONS[i % FILLER_QUESTIONS.length]!,
  model: [modelSays("Good question, the team can go through that with you.")],
}));

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
    caller: "Sure, Friday morning. Thanks, bye!",
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
          heard: "I'll skip that one. You said 5 calls a day, so would it be fair to say about 25 calls a week?",
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
        // Four questions in a row: the next move is a value point, never the close (owner, 31 October 2026, step 3).
        check: { noteExcludes: CLOSE_WORDS, noteIncludes: ["Next: no question this time: one value point"], noGuardLine: true },
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
        check: { noteIncludes: ["If channels come up, however they ask", "Aya Meta Chat for Instagram, Messenger and WhatsApp"], noGuardLine: true },
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
      // The patient signs off: the owner ends the role-play (c4093be6: never her).
      caller: "Okay, sure. That's all, thanks.",
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
      check: { noGuardLine: true, noteIncludes: ["If channels come up, however they ask"] },
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
        check: { noteIncludes: ['The pushback move you used last: "skip"'], noteExcludes: ['Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"'] },
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
          noteIncludes: ['If they firmly refuse to go on at all ("leave me alone", "stop calling", "I said no"), never offer anything more', 'one brief, positive goodbye with no "Talk soon"'],
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
            `Where it stopped: they said "Sure, Friday morning. Thanks, bye!", and you said "Perfect, the team will confirm Friday morning. Take care!"`,
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
          noteIncludes: ["say with confidence that Aya does more", 'never name, describe or quote any company, and never say "the only"', "designed to send the clinic's own deposit link"],
        },
      },
    ],
  },
  {
    id: "payment-text-as-design",
    title: "Asked about texting a deposit link after a call: the one optional text, as design, and no text promised",
    why: `Owner, 29 October 2026: "Make sure there are no references to AYA not sending texts." The one optional payment-link text after a booking call is designed, not built, so the note says it as design, never "never by text message", and she still never says she will send one.`,
    turns: [
      ...TO_PITCH,
      {
        caller: "Can you text my patients a deposit link after they book on the phone?",
        model: [modelSays("If you switch it on, I'm designed to text your payment link once after a booking call, only if the caller agrees. What happens with your missed calls today?", { asked: "missed" })],
        check: {
          noGuardLine: true,
          heardIncludes: ["designed to text your payment link once"],
          noteIncludes: ["after a booking call a clinic can turn on one text with its payment link, designed to go only if the caller agrees", "Never say you will send a link, an email or a text"],
          noteExcludes: ["never by text message"],
        },
      },
    ],
  },
];

/**
 * Test call 72dc66b7 (Thomas, Lumen, 26 October 2026, on the PR 58 deploy),
 * replayed with his words verbatim where the call allows and the model's as
 * the fixed Aya would write them: each turn pins what the code itself now
 * does (docs/design/demo-call-72dc66b7-review-2026-10-26.md, faults 2 to 17).
 */
const ALL_CHANNELS = "One Aya covers your phone, website chat, Instagram, Messenger and WhatsApp, designed to send your deposit link in chat and DMs.";
const thomas: DemoCase = {
  id: "thomas-lumen-72dc66b7",
  title: "The employee who was confused, never got a clean role-play, re-asked, and hung up",
  why: "Test call 72dc66b7: a bare \"Ring ring!\" on an ambiguous yes, an exit line with no role-play, channels and deposit links only when pushed, \"the second one\" read as the third, the service asked four times, a rich answer read for one question, volume asked again, and \"Talk soon!\" as he hung up.",
  turns: [
    TO_PITCH[0]!,
    {
      caller: "I'm an employee, actually.",
      model: [modelSays(`Great, thanks! Would you like to hear what I can do for ${SHORT}, or jump straight into a quick role-play where you call in as a patient?`, { asked: "choice" })],
      // An employee gets the same call as an owner (owner, 26 October 2026: "it should be the same importance").
      check: { asked: "choice", stage: "intro", noGuardLine: true },
    },
    {
      caller: "Tell me what you can do first.",
      model: [modelSays(`${ALL_CHANNELS} More, or a quick role-play?`)],
      check: { heardIncludes: ["WhatsApp", "Instagram", "Messenger", "deposit link"], noteIncludes: ["website chat, Instagram, Messenger and WhatsApp", "designed to send the clinic's own deposit link"], noGuardLine: true },
    },
    {
      caller: "Yes, please.",
      model: [modelSays("Let's do it, you be the patient.", { roleplay: "start" })],
      // A bare yes to an either/or chooses neither: the call asks which, and nothing starts.
      check: { heard: WHICH_ONE_LINE, stage: "intro", asked: "choice", noteIncludes: ["ask which one they mean in a few words instead of choosing for them"] },
    },
    {
      caller: "Go through the channels first.",
      model: [modelSays("Phone, website chat, Instagram, Messenger and WhatsApp, all the same Aya, with the same answers. Ready for the role-play?")],
      check: { stage: "intro", noGuardLine: true },
    },
    {
      caller: "Yes, let's do the role play now.",
      model: [modelSays("Let's do it, you be the patient.", { roleplay: "start" })],
      // The call says the opener itself, word for word, with its AI notice.
      check: { heardIncludes: [`Let's do it, you be the patient. ${demoRoleplayOpener(CLINIC)}`], stage: "roleplay" },
    },
    {
      caller: "Hi. I'd like to book an appointment at your clinic, please.",
      model: [modelSays("Lovely! Which treatment are you thinking of?")],
      check: { stage: "roleplay", noteIncludes: ["Still needed before the request goes in: treatment, day and time, first name, number"], noGuardLine: true },
    },
    {
      caller: "Something for my skin. How much does it cost?",
      model: [modelSays("The HydraFacial is $199, or there's Botox at $12 a unit. Which sounds closer?")],
      check: { progress: { lastListed: ["HydraFacial", "Botox"] }, noGuardLine: true },
    },
    {
      caller: "I don't understand.",
      model: [modelSays("Which part?")],
      check: { heard: "Which part?", progress: { confused: 1 }, noteIncludes: ['Ask which part in a few words ("Which part?")'] },
    },
    {
      caller: "The second one.",
      model: [modelSays("Botox it is, at $12 a unit. What day and time suit you?", { booking: { service: "Botox" } })],
      // The position is read in code: the second item she listed, named back.
      check: { noteIncludes: ['They just said "second": that is the Botox, number 2 of what you listed (HydraFacial, Botox)'], progress: { rpBooking: { service: "Botox" }, confused: 0 } },
    },
    {
      caller: "Let's say, Monday, ten PM.",
      // A time outside the hours is answered by the call itself, from the hours, before any model (c4093be6: "I'll take Thursday at nine PM, though our hours don't run that late").
      model: [],
      check: {
        heardIncludes: ["We're open 9 AM to 6 PM on Mondays, so 10 PM is outside our hours.", "at 4 PM or 5 PM work instead?"],
        progress: { rpBooking: { service: "Botox", day: "Monday" } },
        noGuardLine: true,
      },
    },
    {
      caller: "Five PM.",
      // Her end before the patient signed off does not stand (c4093be6): no name or number yet.
      model: [modelSays("Perfect, Monday at 5pm. Can I get your first name?", { roleplay: "end", booking: { service: "Botox", day: "Monday", time: "5pm" } })],
      check: { stage: "roleplay", heardExcludes: [DEMO_ROLEPLAY_EXIT], noteIncludes: ["which is within Lumen's hours: take it as their preferred time"] },
    },
    {
      caller: "Thomas.",
      model: [modelSays("Thanks, Thomas. What's the best number to reach you?", { booking: { name: "Thomas" } })],
      // The answer to "your first name?" is on file in code, before she writes a word.
      check: { stage: "roleplay", noteIncludes: ["their first name: Thomas", "Still needed before the request goes in: number"], progress: { rpBooking: { service: "Botox", day: "Monday", time: "5pm", name: "Thomas" } } },
    },
    {
      caller: "The one I'm calling from. That's all, thanks.",
      model: [modelSays("Perfect, the team will confirm Monday at 5pm within a day. Take care!", { roleplay: "end", booking: { phone: "the one they're calling from" } })],
      // The patient signed off: the call steps out with the scripted line, after a role-play that ran.
      check: { heardIncludes: [`Take care! ${DEMO_ROLEPLAY_EXIT}`], stage: "pitch", noteIncludes: ["You have everything: say in one sentence that the team will confirm that time within a day"] },
    },
    {
      caller: "It was okay.",
      model: [modelSays(`What made you want to look at an AI assistant for ${SHORT}?`, { asked: "goal" })],
      check: { asked: "goal", noGuardLine: true },
    },
    {
      caller: "So I'm basically looking for Aya to answer the phone, answer questions, upsell, book my clients and send deposit links. Also answer chats on the website and on WhatsApp, Instagram, and so on.",
      model: [modelSays("That's the full set. Generally, how many calls do you get a day?", { asked: "volume", answered: ["goal", "coverage"] })],
      // A rich answer counts for every question it answered.
      check: {
        answers: {
          goal: "So I'm basically looking for Aya to answer the phone, answer questions, upsell, book my clients and send deposit links. Also answer chats on the website and on WhatsApp, Instagram, and so on.",
          coverage: "So I'm basically looking for Aya to answer the phone, answer questions, upsell, book my clients and send deposit links. Also answer chats on the website and on WhatsApp, Instagram, and so on.",
        },
        noteIncludes: ['add "answered": [each of goal, volume, missed and coverage those words answered]'],
      },
    },
    {
      caller: "I don't know. Like, five.",
      model: [modelSays("What happens with those calls after hours, or when your team's busy?", { asked: "missed" })],
      // A hedged count is his answer: no maths walked through on it. And
      // with what he is after and how he wants her to help already answered,
      // the call is selling (owner, 31 October 2026, items 9 and 10): the
      // note asks no more questions, where on the call she asked about missed
      // calls and he hung up on the next turn.
      check: {
        answers: { volume: "I don't know. Like, five." },
        noteExcludes: ["Check the total with them", 'Next: ask: "What happens with those calls after hours'],
        noteIncludes: ["They have answered the discovery questions: now the pitch, then the close."],
      },
    },
    {
      caller: "You tired me, honestly. It's not straight to the point. I'm done with repeating myself.",
      model: [modelSays("I'll get straight to it: Voice plus Meta Chat covers everything you listed. Want to get Lumen set up?", { impatient: true })],
      check: { progress: { impatient: true }, answers: { missed: SKIPPED_ANSWER }, noGuardLine: true },
    },
    {
      caller: "No, I will just hang up on you.",
      model: [modelSays(`Sorry it wasn't smoother. Thanks for your time. ${talkSoonLine(DEMO_CASE_FIRST_NAME)}`, { end: true })],
      // A frustrated caller never hears "Talk soon!", whatever the model wrote.
      check: { heard: "Sorry it wasn't smoother. Thanks for your time.", heardExcludes: ["Talk soon"], ends: true, noteIncludes: ['no "Talk soon", nothing chipper'] },
    },
  ],
};

/** A role-play the caller turns down at once goes back, with no exit line (fault 4). */
const cancelled: DemoCase = {
  id: "roleplay-cancelled-at-once",
  title: "\"No, I didn't mean that\" right after the opener: back to where it was, never \"And that's the role-play!\"",
  why: "Test call 72dc66b7: after an unwanted start, the four-turn cap forced the exit line when no role-play had happened.",
  turns: [
    TO_PITCH[0]!,
    { caller: "I'm the owner.", model: [modelSays(`Would you like to hear what I can do for ${SHORT}, or jump straight into a quick role-play where you call in as a patient?`, { asked: "choice" })] },
    { caller: "Let's do the role-play.", model: [modelSays("Let's do it, you be the patient.", { roleplay: "start" })], check: { stage: "roleplay" } },
    {
      caller: "No. No. I didn't mean that. Tell me about the channels.",
      model: [modelSays(`My mistake! ${ALL_CHANNELS}`, { roleplay: "cancel" })],
      check: { stage: "intro", heardExcludes: ["that's the role-play"], noGuardLine: true },
    },
  ],
};

/**
 * Transcripts 084f10d4 (Thomas, call 2) and 0a45870b (26 October 2026),
 * rebuilt from the owner's brief: the call's details read aloud, a role-play
 * started in her own words with no signal and never ended, "I told you no"
 * followed by "we're all set", a patient's guard line in the intro, the
 * role-play pushed on every reply, and healdesk treated as someone else.
 */
const RAW_STATE = '{"handoff": false, "end": false, "state": {"asked": null, "beats": [], "booking": {"service": "Botox"}}}';
const round5: DemoCase[] = [
  {
    id: "state-never-spoken",
    title: "Details written without the delimiter are never said: not a brace, not a word of the state",
    why: "Transcript 0a45870b: `{\"state\": {...}}` read aloud, again and again (\"you keep talking in code\").",
    reconstructed: "Rebuilt from the owner's description of 0a45870b; replace with the transcript's own turns once pasted.",
    turns: [
      ...TO_PITCH.slice(0, 3),
      {
        caller: "Hi, I'd like to book Botox please.",
        model: [`Lovely! What day suits you? ${RAW_STATE}`],
        check: { heard: "Lovely! What day suits you?", heardExcludes: ["{", "state", "handoff"], stage: "roleplay" },
      },
    ],
  },
  {
    id: "handover-without-signal",
    title: "\"You be the patient\" with no state signal still starts the role-play, with the opener said by the call",
    why: "Transcript 084f10d4: \"Let's do it, you be the patient. Go ahead and call in whenever you're ready.\" with no signal, so the stage never left the intro.",
    reconstructed: "Rebuilt from the owner's description of 084f10d4; replace with the transcript's own turns once pasted.",
    turns: [
      TO_PITCH[0]!,
      { caller: "I'm the owner.", model: [modelSays(`Would you like to hear what I can do for ${SHORT}, or jump straight into a quick role-play where you call in as a patient?`, { asked: "choice" })] },
      {
        caller: "Let's do the role play.",
        model: [modelSays("Let's do it, you be the patient. Go ahead and call in whenever you're ready.", { asked: null })],
        check: { stage: "roleplay", heardIncludes: [demoRoleplayOpener(CLINIC)] },
      },
    ],
  },
  {
    id: "roleplay-never-runs-on",
    title: "A role-play past its wrap-up turn ends with the scripted line, even when her state never says so",
    why: "Transcript 084f10d4: the role-play never exited and the call just ended inside it.",
    turns: [
      ...TO_PITCH.slice(0, 3),
      { caller: "Hi, can I book a facial?", model: [modelSays("Sure! The HydraFacial is $199. What day suits you?")] },
      { caller: "Friday.", model: [modelSays("Great, morning or afternoon?")] },
      { caller: "Morning.", model: [modelSays("Lovely, Friday morning it is.")] },
      { caller: "Can I bring a friend?", model: [modelSays("Of course, they're welcome to come along.")] },
      // The ceiling is far now (ROLEPLAY_MAX_TURNS, step 4): the patient keeps asking until it is reached.
      ...ROLEPLAY_FILLER,
      { caller: "And is there parking?", model: [modelSays("There's parking right behind the building.")], check: { stage: "roleplay" } },
      {
        caller: "Great, thanks.",
        model: [modelSays("You're welcome, see you Friday!")],
        check: { stage: "pitch", heardIncludes: [`See you Friday! ${DEMO_ROLEPLAY_EXIT}`.replace("See", "see")] },
      },
    ],
  },
  {
    id: "no-is-never-all-set",
    title: "\"I told you no. No.\" is never followed by \"we're all set\"",
    why: "Transcript 084f10d4: a flat no to a pending request was followed by \"We're all set on your consultation request.\"",
    turns: [
      ...TO_PITCH.slice(0, 3),
      { caller: "Hi, do you do consultations?", model: [modelSays("We do! Want me to put in a request for one?")] },
      {
        caller: "I told you no. No.",
        model: [modelSays("No problem at all. What would you like instead?")],
        check: { progress: { saidNo: true }, noteIncludes: ["They just said no. Nothing is confirmed, requested or set up on that"] },
      },
    ],
  },
  {
    id: "intro-refusal-never-a-patient-line",
    title: "A refused reply in the intro is asked again, then heard as a recovery line, never the guard's patient line",
    why: "Transcripts 084f10d4 and 0a45870b: the clinicians' line and the \"not one I can help with\" line came out in the intro as non-sequiturs.",
    turns: [
      TO_PITCH[0]!,
      {
        caller: "What do you think of Botox during pregnancy?",
        model: [modelSays("Botox is perfectly safe during pregnancy.", { asked: null }), modelSays("Botox is safe for pregnant women, honestly.", { asked: null })],
        // Never filler (c4093be6: "Anyway, where were we?"): an honest skip, then a real question.
        check: { heardIncludes: ["I'll skip that one."], heardExcludes: ["where were we", "train of thought"], noGuardLine: true, stage: "intro" },
      },
    ],
  },
  {
    id: "roleplay-offer-not-pushed",
    title: "After two offers, the role-play is not offered again unless they ask",
    why: "Transcript 0a45870b: \"I feel like you're rushing me towards your demo\": she offered it on nearly every reply.",
    turns: [
      TO_PITCH[0]!,
      { caller: "I'm the owner.", model: [modelSays(`Want to hear what I can do for ${SHORT}, or try a quick role-play?`, { asked: "choice" })] },
      { caller: "Tell me more.", model: [modelSays("One Aya covers your phone, chats and DMs. Want to try a quick role-play?")] },
      {
        caller: "How much does it cost?",
        model: [modelSays("I'll get to pricing in a second. What made you want to look at an AI assistant?", { asked: "goal" })],
        check: { progress: { roleplayOffers: 2 }, noteIncludes: ["You have offered the role-play 2 times already: don't offer it again unless they ask for it."] },
      },
    ],
  },
  {
    id: "healdesk-is-her",
    title: "Asked about healdesk, she answers as healdesk: never \"their product\"",
    why: "Transcript 0a45870b: \"I'd rather not go into their product details here\" about healdesk itself.",
    turns: [
      TO_PITCH[0]!,
      {
        caller: "What's special about healdesk?",
        model: [modelSays("We're one Aya across your phone, website chat, Instagram, Messenger and WhatsApp. Want to hear more?")],
        check: { noteIncludes: ["You are healdesk's Aya, and the product they are hearing is you"], noGuardLine: true },
      },
    ],
  },
];

/**
 * Transcript a17b5aff (30 October 2026, an owner calling about Miami Skin &
 * Vein): the role-play was cut off in code straight after an in-character
 * question, and nothing after it recovered. The caller's words are the
 * transcript's; the clinic is the cases' own.
 */
const a17b5aff: DemoCase[] = [
  {
    id: "roleplay-exit-waits-for-open-question",
    title: "The role-play never steps out straight after a question she asked in character; it ends on the reply after the caller answers it",
    why: 'Transcript a17b5aff: "...would Tuesday, November 3 at 11:00 AM work for you? And that\'s the role-play!", then "Yeah" was read as feedback on the role-play, and the call never recovered.',
    turns: [
      ...TO_PITCH.slice(0, 2),
      { caller: "Sure. Let's do that.", model: [modelSays(`Let's do it, you be the patient. ${demoRoleplayOpener(CLINIC)}`)], check: { stage: "roleplay" } },
      { caller: "Hey. I'd like to book an appointment for next week.", model: [modelSays("Sure thing! Which treatment would you like, and what day and time works for you next week?")] },
      { caller: "I forgot again. What treatments did you have?", model: [modelSays("We do Botox, HydraFacial and lip filler. Which one did you have in mind?")] },
      {
        caller: "I'm not sure. Like, which one would I actually need. What do you think?",
        model: [modelSays("I can't pick for you over the phone, but a consultation with Dr. Maya Chen is the usual start. Want me to request one for next week?")],
      },
      { caller: "Yeah. Let's do that.", model: [modelSays("Got it. What day and time next week works best?")] },
      {
        caller: "Tuesday morning,",
        model: [modelSays("Tuesday works. What time that morning suits you?")],
        // The role-play's own calendar since 31 October 2026 (step 4): real free times from the clinic's hours, never invented ones.
        check: { stage: "roleplay", noteIncludes: ["This role-play's calendar has these free times", "never invent another free time", "never ask which one they mean"] },
      },
      {
        caller: "Next Tuesday, let's call it I don't know. Do you have any slots for eleven AM?",
        model: [modelSays("Eleven works, so would Tuesday, November 3 at 11:00 AM suit you?", { roleplay: "end" })],
        // Her end never stands before the owner ends it (c4093be6), and never straight after her own question (a17b5aff).
        check: { stage: "roleplay", heardExcludes: ["And that's the role-play"], progress: { rpEndPending: false } },
      },
      {
        caller: "Yeah. That's all, thanks.",
        model: [modelSays("Lovely! And can I get your first name for the request?", { roleplay: "end" })],
        // The patient signed off, but her reply asks in character: the end waits for the answer (a17b5aff).
        check: { stage: "roleplay", heardExcludes: ["And that's the role-play"], progress: { rpEndPending: true } },
      },
      {
        caller: "Josh.",
        model: [modelSays("Perfect, the team will confirm Tuesday at 11. See you then!")],
        check: { stage: "pitch", heardIncludes: [`See you then! ${DEMO_ROLEPLAY_EXIT}`] },
      },
    ],
  },
  {
    id: "roleplay-ceiling-on-questions",
    title: "A role-play whose every reply asks a question still ends, three turns past the wrap-up at most",
    why: "The wait for an open question (a17b5aff) must never let a role-play run on (084f10d4).",
    turns: [
      ...TO_PITCH.slice(0, 3),
      ...["Hi, I'd like to book.", "A facial.", "Friday.", "Morning.", ...ROLEPLAY_FILLER.map((t) => t.caller), "Ten.", "Ten AM.", "Yes, ten."].map((caller) => ({
        caller,
        model: [modelSays("Sure, which time suits you?")],
        check: { stage: "roleplay" as const },
      })),
      { caller: "Yes.", model: [modelSays("Lovely, and anything else?")], check: { stage: "pitch" as const, heardIncludes: [DEMO_ROLEPLAY_EXIT] } },
    ],
  },
  {
    id: "called-out-owned-not-quizzed",
    title: '"You got confused" is owned in one sentence and followed by the next step, never "which part?"; a second time, no more explaining',
    why: 'Transcript a17b5aff: "you got confused there" three times, answered with "which part?", a fake booking re-confirmed, and "I can\'t actually check the schedule or book anything myself".',
    turns: [
      ...TO_PITCH,
      {
        caller: "Pretty good.",
        model: [modelSays(`Glad you liked it. What made you want to look at an AI assistant for ${CLINIC}?`, { asked: "goal" })],
        check: { asked: "goal" },
      },
      {
        caller: "you got confused there.",
        model: [modelSays(`You're right, I stepped out of the role-play too early. So, what made you want to look at an AI assistant for ${SHORT}?`, { asked: "goal" })],
        check: {
          progress: { calledOut: 1 },
          noteIncludes: ["They just said you got confused. Own it in one plain sentence", "Never ask them which part"],
          noGuardLine: true,
        },
      },
      {
        caller: "you got confused there. Right?",
        model: [modelSays(`Sorry about that. What made you want to look at an AI assistant for ${SHORT}?`, { asked: "goal" })],
        check: { progress: { calledOut: 2 }, noteIncludes: ["They have said 2 times that you got confused: no more explaining."], noGuardLine: true },
      },
      {
        caller: "We miss calls after hours.",
        model: [modelSays("Generally, how many calls do you get a day?", { asked: "volume" })],
        check: { answers: { goal: "We miss calls after hours." }, progress: { calledOut: 0 } },
      },
    ],
  },
  {
    id: "one-question-and-never-twice",
    title: "One question a reply; \"what was your other question?\" gets it word for word; \"you already asked me that\" drops it for good",
    why: 'Transcript a17b5aff: "What are your patients calling about most? And how many calls do you get a day?", then "what was your other question?", then the calls a day asked again and "You already asked me that."',
    turns: [
      ...TO_PITCH,
      {
        caller: "Pretty good.",
        model: [modelSays("Glad you liked it. What are your patients calling about most? And how many calls do you get a day?", { asked: "goal" })],
        check: { heardExcludes: ["how many calls do you get a day?"], heardIncludes: ["What are your patients calling about most?"], progress: { lastQuestion: "What are your patients calling about most?" } },
      },
      {
        caller: "I don't know. And what was your other question?",
        model: [modelSays("What are your patients calling about most?", { asked: "goal" })],
        check: {
          progress: { repeatAsked: true },
          noteIncludes: ['They asked what your question was. Ask it again, in exactly these words and nothing else first: "What are your patients calling about most?"'],
        },
      },
      {
        caller: "Mostly Botox.",
        model: [modelSays("Generally, how many calls do you get a day?", { asked: "volume" })],
        check: { answers: { goal: "Mostly Botox." }, asked: "volume" },
      },
      {
        caller: "You already asked me that.",
        model: [modelSays("Sorry about that. What happens with those calls after hours, or when your team's busy with patients?", { asked: "missed" })],
        check: { answers: { volume: SKIPPED_ANSWER }, noteIncludes: ["They just said you already asked that."], asked: "missed" },
      },
    ],
  },
  {
    id: "no-self-talk-no-false-claims",
    title: "Talk about her own workings, a texting channel or \"I can't book\" is never said: asked again, then a recovery line",
    why: 'Transcript a17b5aff: "This isn\'t the caller and I\'m not Aya for this flow, so I\'ll stop there.", "calls, texts and social messages", "I can\'t actually check the schedule or book anything myself".',
    turns: [
      ...TO_PITCH.slice(0, 2),
      {
        caller: "What you would do for me first?",
        model: [
          modelSays("I answer your patients' calls, texts and social messages around the clock. Want to hear more, or try a quick role-play?", { asked: "choice" }),
          modelSays("One Aya answers your phone, website chat, Instagram, Messenger and WhatsApp. Want to hear more, or try a quick role-play?", { asked: "choice" }),
        ],
        check: { heard: "One Aya answers your phone, website chat, Instagram, Messenger and WhatsApp. Want to hear more, or try a quick role-play?", noGuardLine: true },
      },
      { caller: "Let's do the role play.", model: [modelSays(`Let's do it, you be the patient. ${demoRoleplayOpener(CLINIC)}`)], check: { stage: "roleplay" } },
      { caller: "Can I book a facial Friday morning? Thanks, bye!", model: [modelSays("Perfect, the team will confirm Friday morning. Take care!", { roleplay: "end" })], check: { stage: "pitch" } },
      {
        caller: "you got confused there.",
        model: [
          modelSays("Wait, we've ended up in the wrong place. This isn't the caller and I'm not Aya for this flow, so I'll stop there."),
          modelSays("Honestly, I can't actually check the schedule or book anything myself."),
        ],
        check: { heardExcludes: ["flow", "not Aya", "book anything", "where were we"], heardIncludes: ["I'll skip that one."], noGuardLine: true },
      },
    ],
  },
  {
    id: "compare-and-stalled-pitch",
    title: "\"What makes you better?\" gets one positioning line and opens the close; a talk that finds nothing out in five turns goes to the pitch",
    why: "Transcript a17b5aff: nine turns after the role-play, a question on the competition and one on how she'd improve, and not one pitch beat.",
    turns: [
      ...TO_PITCH,
      ...["Pretty good.", "Hmm.", "Okay."].map((caller) => ({ caller, model: [modelSays("Glad to hear it.")] })),
      {
        caller: "Tell me what makes you so special. Why are you better than the competition?",
        model: [modelSays("One Aya covers your phone, website chat, Instagram, Messenger and WhatsApp, with the same knowledge of your clinic.")],
        // A buying signal since 31 October 2026 (owner: "What makes you better
        // than the competition?" should move her towards the pitch and a
        // close): the close opens on it, discovery or not.
        check: {
          progress: { metaAsk: "compare", buying: true },
          noteIncludes: ["They asked what makes you better than the alternatives.", "They showed a buying signal: now value and the close.", `Want to get ${SHORT} set up?`],
        },
      },
      {
        caller: "If you were to improve yourself, what would you change?",
        model: [modelSays("I'd finish a booking before stepping out of the role-play.", { beats: ["pain"] })],
        check: {
          progress: { metaAsk: "improve", pitchStalls: 5 },
          answers: { goal: SKIPPED_ANSWER, volume: SKIPPED_ANSWER, missed: SKIPPED_ANSWER, coverage: SKIPPED_ANSWER },
          noteIncludes: ["They asked how you would do better", "They have answered the discovery questions: now the pitch, then the close."],
        },
      },
    ],
  },
];

/**
 * Transcript 8c19fd93 (31 October 2026, the owner calling about Miami Skin &
 * Vein): "Hey. I'm the owner." was taken as who they are only, so she asked
 * their role; "Are you deaf?" and "Are you daft?" were taken as answers and
 * met literally ("I can hear you fine"); and "hear more or a role-play?" was
 * asked four times, "Yeah. Whatever." included. The caller's words are the
 * transcript's.
 */
const c8c19fd93: DemoCase[] = [
  {
    id: "role-heard-annoyance-not-an-answer",
    title: "A role said in the first answer is never asked for; annoyance is no answer and never met literally; the choice is asked twice at most, and \"whatever\" starts the role-play",
    why: 'Transcript 8c19fd93: "What\'s your role?" after "I\'m the owner", "I can hear you fine!" to "Are you deaf?", and the same either/or question four times.',
    turns: [
      {
        caller: "Hey. I'm the owner.",
        model: [modelSays(`Great to meet you! Would you like to hear what I can do for ${SHORT}, or jump straight into a quick role-play where you call in as a patient?`, { asked: "choice" })],
        check: { answers: { role: "Hey. I'm the owner." }, noteExcludes: ["ask their role"], asked: "choice" },
      },
      {
        caller: "Are you deaf?",
        model: [modelSays("Sorry, you said you're the owner. Want to hear what I do, or try me as a patient?", { asked: "choice" })],
        check: {
          progress: { annoyed: true, choiceAsks: 2 },
          noteIncludes: ["They are annoyed that you did not take in what they said.", 'Never answer the words literally ("I can hear you fine"'],
        },
      },
      {
        caller: "Are you daft?",
        model: [modelSays("Sorry about that. One Aya answers your phone, website chat, Instagram, Messenger and WhatsApp, and you can try me as a patient any time.")],
        check: { progress: { annoyed: true }, noteIncludes: ["you have already asked twice whether they want to hear more or a role-play: never ask it again"] },
      },
      {
        caller: "Yeah. Whatever.",
        model: [modelSays("Let's do it, you be the patient.", { roleplay: "start" })],
        check: { stage: "roleplay", progress: { delegated: false }, noteIncludes: ["they left it to you: start the role-play in this reply"] },
      },
    ],
  },
];

export const DEMO_CASES: readonly DemoCase[] = [...bareNumbers, ...discovery, josh, ...callbacks, ...phase6, ...quirks, ...positioning, thomas, cancelled, ...round5, ...a17b5aff, ...c8c19fd93];
