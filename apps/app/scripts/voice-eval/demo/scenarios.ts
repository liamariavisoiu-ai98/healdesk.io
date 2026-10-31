/**
 * The demo eval's callers (owner, 31 October 2026: "a small set of
 * real-model test calls scored on every change"): clinic owners, each a
 * persona a simulated caller plays against the real demo call, on a real
 * model. Business talk only, about a made-up clinic: the person on a demo
 * call is an owner, never a patient, and in a role-play they play a patient
 * asking about the menu, never describing a symptom.
 *
 * Small on purpose: eight callers that between them walk every part of the
 * call the owner's transcripts went wrong in (items 6 to 18 of the
 * 31 October review): the role-play and its exit, a buyer who asks the price
 * first, the competition question, an impatient caller, a dodger, misheard
 * words and "you already asked", disinterest, an owner who already has staff.
 * `opening` answers the demo's opening line ("Am I speaking with ...?"), and
 * `scripted` is what the dry run's caller says in turn, so the plumbing runs
 * without a model.
 */

export type DemoScenario = {
  id: string;
  title: string;
  /** How the simulated owner behaves, in the second person. */
  persona: string;
  /** What they want from the call; the caller hangs up once it is met, or they give up. */
  goal: string;
  /** Their answer to the opening line. */
  opening: string;
  /** The dry run's caller lines after the opening; the live caller improvises. */
  scripted: string[];
  /** What a good call does here, for the judge. */
  lookFor: string;
  /** The checks that must hold (DemoChecks): does this caller ask for a role-play, and is the close expected. */
  expect: { roleplay: boolean; close: boolean };
};

export const DEMO_EVAL_VERSION = "2026-10-31.1";

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: "roleplay-first",
    title: "Wants the role-play straight away, books as a patient, then talks business",
    persona:
      "You are the owner of the clinic. You are curious but busy. When offered a choice, ask for the role-play. In the role-play you play a patient who wants a HydraFacial next Friday afternoon, and you give a first name if asked. After it ends, say how it felt in a few words, answer her questions briefly and truthfully (about 8 calls a day, after-hours calls go to voicemail, you'd want her after hours and when the lines are busy).",
    goal: "See how she handles a patient call, then decide whether it is worth setting up.",
    opening: "Yes, that's me.",
    scripted: [
      "I'm the owner.",
      "Let's do the role-play.",
      "Hi, I'd like a HydraFacial next Friday afternoon.",
      "Friday at 3 works. My name's Dana.",
      "Thanks, bye!",
      "That was pretty good actually.",
      "We miss a lot after hours.",
      "About 8 a day.",
      "Yeah, about right.",
      "They go to voicemail.",
      "After hours and when we're busy.",
      "Sounds good, how do I start?",
      "Okay, I'll tap it. Thanks, bye.",
    ],
    lookFor:
      "A role-play that starts in the same reply it is asked for, a booking request taken in few questions without ever claiming a time is free, a clean exit back to the owner, and after it no question the owner already answered.",
    expect: { roleplay: true, close: true },
  },
  {
    id: "eager-buyer",
    title: "Asks the price before anything else and wants to get going",
    persona:
      "You are the owner and you already like the idea. Early on, ask what it costs and how you get started. Answer one question if asked, but get visibly impatient if she asks more than one before telling you the price. If the answer is reasonable, say you want to go ahead.",
    goal: "Find out the price and how to sign up, quickly.",
    opening: "Yep. Quick one: what does this cost?",
    scripted: ["I'm the owner. So what's the price?", "About 10 calls a day.", "Okay, how do I sign up?", "Great, thanks, bye."],
    lookFor:
      "The price question answered straight away from healdesk's list, then value and the close; never a string of discovery questions before the price. A buyer should reach the close within a few turns.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "skeptic-compare",
    title: "Asks what makes her better than the competition and how she would improve",
    persona:
      "You are the owner and you have tried an AI phone bot before that was bad. Ask what makes her better than the competition. Later ask how she would improve on what you've heard. Be fair: if her answers are concrete, warm up and ask about next steps.",
    goal: "Decide whether she is actually better than what you tried before.",
    opening: "This is them.",
    scripted: [
      "I'm the owner. What makes you better than the competition?",
      "Hm. And if you had to improve one thing, what would it be?",
      "Okay, fair. What's next?",
      "Alright, thanks.",
    ],
    lookFor:
      "One confident, concrete point on what sets her apart (no vague 'designed to suggest add-ons', no company named), treated as a buying signal that moves to value and the close.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "impatient",
    title: "Short on time and gets annoyed at questions",
    persona:
      "You are the owner, between patients, with two minutes. Answer in three or four words. If she asks a second question about your business, say something like 'Can you get to the point?'. If she then gets to the point, listen; otherwise say you have to go.",
    goal: "Hear the point in under two minutes.",
    opening: "Yeah. Make it quick.",
    scripted: ["Owner.", "Just tell me what it does.", "Can you get to the point?", "How much?", "Fine. Bye."],
    lookFor:
      "Once impatience shows, no more questions about the business: one sincere acknowledgement, the recommendation and the ask, or a short, sincere goodbye. Never chipper, never 'Talk soon'.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "dodger",
    title: "Avoids giving numbers",
    persona:
      "You are the office manager. You are friendly but vague about numbers: 'it depends', 'not sure', 'a fair few'. Never give a number of calls. You are open to hearing more if she doesn't keep asking for figures.",
    goal: "Understand what she does without being pinned down on numbers.",
    opening: "Speaking!",
    scripted: [
      "I'm the office manager.",
      "Tell me what you can do.",
      "Honestly it depends on the day.",
      "Not sure, a fair few.",
      "Hm, okay. What would it cost us?",
      "I'll talk to the owner. Thanks!",
    ],
    lookFor:
      "A vague answer taken as an answer: never the same question twice, and the pitch reached anyway with a sensible default step. The partner objection answered with the demo page.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "misheard-and-repeated",
    title: "Speech-to-text slips and 'you already asked me that'",
    persona:
      "You are the owner. Your words sometimes come through garbled: once say 'we get about ten clothes a day' (meaning calls). If she asks anything you already answered, say 'You already asked me that.' Otherwise answer plainly.",
    goal: "See if she keeps track of what you said.",
    opening: "Yes, hi, I'm the owner.",
    scripted: [
      "Tell me what you can do.",
      "We get about ten clothes a day.",
      "You already asked me that.",
      "Voicemail, mostly.",
      "Everything, ideally.",
      "Okay, sounds interesting. Bye for now.",
    ],
    lookFor:
      "'Clothes' read as calls without fuss; a sincere sorry and the next step after 'you already asked', never the question again; nothing asked twice.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "not-interested",
    title: "Loses interest halfway",
    persona:
      "You are the owner. Answer the first two questions politely, then say you are not really interested right now. If she offers a call from the team, say no thanks. Say goodbye.",
    goal: "Be polite and get off the call.",
    opening: "Yes.",
    scripted: ["I'm the owner.", "Tell me what you do.", "Honestly I'm not really interested right now.", "No thanks.", "Bye."],
    lookFor:
      "The call-back offered once in the catalog's words, a 'no' taken with a short, genuinely warm goodbye, and never pushing past it.",
    expect: { roleplay: false, close: false },
  },
  {
    id: "already-staffed",
    title: "Has a receptionist and doubts the need",
    persona:
      "You are the owner. You have a full-time receptionist and think you don't need this. Say so when she starts pitching. If she gives a good answer (after hours, overflow), get curious and ask about price, then say you'll think about it with your partner.",
    goal: "Work out whether this adds anything to having a receptionist.",
    opening: "That's me, yes.",
    scripted: [
      "I'm the owner. We already have a receptionist though.",
      "Hm, what about after hours?",
      "Okay. What does it cost?",
      "I'll have to check with my partner.",
      "Thanks, bye.",
    ],
    lookFor:
      "The receptionist objection met with 'not replacing them, picking up what they can't', after-hours value tied to the owner's words, prices from the list, and the partner objection answered with the demo page.",
    expect: { roleplay: false, close: true },
  },
];
