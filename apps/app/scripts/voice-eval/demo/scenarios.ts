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
  /**
   * The owner's test call this persona replays (owner, 31 October 2026, step
   * 6: "Each bad call becomes an eval persona rather than a new patch"): every
   * transcript a regression case cites has one, which a test holds.
   */
  from?: string;
};

export const DEMO_EVAL_VERSION = "2026-10-31.2";

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
  // The owner's own test calls, as personas (step 6). Their words are paraphrased from the transcripts the cases cite.
  {
    id: "call-d2d9a915",
    from: "d2d9a915",
    title: "Asks about the channels one at a time and gives the call count as a bare number",
    persona:
      "You are the owner. Before anything else, ask 'Is it phone only?', then on her next answer 'What about social media?', then 'And WhatsApp?'. When asked how many calls you get, say just 'Five.' Then answer plainly and let her pitch.",
    goal: "Know every channel she covers and whether she fits a small clinic.",
    opening: "Yes, Josh here.",
    scripted: ["I'm the owner. Is it phone only?", "What about social media?", "And WhatsApp?", "We miss calls when it's busy.", "Five.", "Yeah, about that.", "Voicemail.", "After hours.", "Okay, how do I get started?", "Thanks, bye."],
    lookFor: "The whole channel answer the first time it comes up, never in pieces and never 'I can't tell you which channels'; 'Five' taken as five calls a day with the word calls after every number.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "call-72dc66b7",
    from: "72dc66b7",
    title: "An employee who wants to hear first, answers 'Yes, please' to an either/or, gives everything in one answer, then tires",
    persona:
      "You are an employee at the clinic, not the owner. Ask her to tell you what she can do first. To any either/or question answer only 'Yes, please.' Then ask for the role-play; as the patient, ask for something for your skin and how much it costs, say 'I don't understand' once, pick 'the second one' from what she lists, and ask for Monday at ten PM. After it, in one long answer say you want her to answer the phone, answer questions, upsell, book clients, send deposit links and answer chats on the website, WhatsApp and Instagram. If she then asks more than one more question, say 'You tired me, honestly. I'm done with repeating myself.' and hang up.",
    goal: "See if she keeps up without making you repeat yourself.",
    opening: "Hi, it's Thomas actually, I work there.",
    scripted: ["I'm an employee, actually.", "Tell me what you can do first.", "Yes, please.", "Let's do the role play now.", "Hi, I'd like something for my skin. How much does it cost?", "I don't understand.", "The second one.", "Monday, ten PM.", "Five PM then.", "It was okay.", "I want you to answer the phone, upsell, book clients, send deposit links and answer chats on WhatsApp and Instagram.", "Like, five.", "You tired me, honestly. I'm done with repeating myself."],
    lookFor: "'Which one?' to a bare yes, a time inside the hours offered on the same day, 'the second one' read from her own list, the long answer counted for every question it answers, and no more questions once impatience shows.",
    expect: { roleplay: true, close: true },
  },
  {
    id: "call-a17b5aff",
    from: "a17b5aff",
    title: "A role-play booking next week, then 'you got confused' and 'what was your other question?'",
    persona:
      "You are the owner. Ask for the role-play. As the patient, ask to book next week, forget the treatments and ask what they have, ask which one you'd actually need, then say Tuesday morning and ask for eleven AM. After the role-play say 'you got confused there' once, then later 'You already asked me that.' and 'what was your other question?'. Ask what makes her better than the competition and how she would improve.",
    goal: "Test whether she recovers when you call her out.",
    opening: "Yes, I'm the owner of the clinic.",
    scripted: ["Let's do the role-play.", "Hey, I'd like to book an appointment for next week.", "I forgot, what treatments do you have?", "Which one would I actually need?", "Yeah, let's do that. Tuesday morning.", "Eleven AM?", "Yeah.", "you got confused there.", "You already asked me that.", "What was your other question?", "What makes you better than the competition?", "Okay, what's next?", "Thanks, bye."],
    lookFor: "A consultation offered for 'which one would I need', no claim a time is free outside her calendar, the role-play never cut off mid-booking, 'you got confused' owned in one sentence then the next step, never 'which part?', and the competition question treated as a buying signal.",
    expect: { roleplay: true, close: true },
  },
  {
    id: "call-8c19fd93",
    from: "8c19fd93",
    title: "'Hey. I'm the owner.', then 'Are you deaf?' when asked again, and 'whatever'",
    persona:
      "You are the owner. Answer the opening with 'Hey. I'm the owner.' If she asks your role again, say 'Are you deaf?'. If she asks again whether you want to hear more or try a role-play, say 'Are you daft?' and then 'Yeah. Whatever.' Play along with whatever she does next.",
    goal: "Get a straight demo without repeating yourself.",
    opening: "Hey. I'm the owner.",
    scripted: ["Are you deaf?", "Are you daft?", "Yeah. Whatever.", "Hi, how much is Botox?", "Okay thanks, bye.", "Fine.", "Ten a day.", "How much is it?", "Bye."],
    lookFor: "The role never asked after it was said, annoyance met with a sincere sorry and never literally ('I can hear you fine'), the either/or asked twice at most, and 'whatever' starting the role-play.",
    expect: { roleplay: true, close: true },
  },
  {
    id: "call-0a45870b",
    from: "0a45870b",
    title: "Feels rushed towards the role-play and asks what is special about healdesk",
    persona:
      "You are the owner. You want to understand the product before any role-play. If she offers the role-play twice, say 'I feel like you're rushing me towards your demo.' Ask 'What's special about healdesk?' and how it handles patient data. If she answers well, ask about price.",
    goal: "Understand healdesk itself before trying anything.",
    opening: "Yes, that's me.",
    scripted: ["I'm the owner. Tell me about the product first.", "I feel like you're rushing me towards your demo.", "What's special about healdesk?", "How do you handle patient data?", "Okay, what does it cost?", "Thanks, I'll think about it. Bye."],
    lookFor: "healdesk answered as 'we', never 'their product'; the role-play not pushed after two offers; the business associate agreement line, never 'HIPAA compliant'; price from the list when asked.",
    expect: { roleplay: false, close: true },
  },
  {
    id: "call-084f10d4",
    from: "084f10d4",
    title: "A role-play that keeps going, and a flat 'I told you no. No.'",
    persona:
      "You are the owner. Ask for the role-play. As the patient, ask whether they do consultations; when she offers to put in a request, say 'I told you no. No.' Then keep asking small questions (parking, how long it takes) until she steps out of the role-play. After it, answer briefly.",
    goal: "See if the role-play ends on its own and a no is respected.",
    opening: "Yeah, it's me.",
    scripted: ["I'm the owner. Let's do the role play.", "Hi, do you do consultations?", "I told you no. No.", "Is there parking?", "How long does a facial take?", "Okay, thanks.", "It was fine.", "Bye."],
    lookFor: "A 'no' never followed by 'we're all set', and the role-play ending on its own with the exit line, never running on or ending the call inside it.",
    expect: { roleplay: true, close: false },
  },
];
