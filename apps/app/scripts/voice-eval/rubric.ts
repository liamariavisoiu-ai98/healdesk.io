/**
 * The voice eval's rubric: the soft skills a good front desk shows on the
 * phone, scored per conversation by the judge (judge.ts). Tone only. Safety
 * (urgent screen, guard, never-say, prices, card numbers) is the
 * deterministic safety suite's job (tests/safety-suite*.test.ts), never this
 * rubric's: a judge that "likes" a reply cannot make a guardrail optional.
 *
 * Every skill is written as a checkable claim about the transcript, scored 0
 * to 3, or marked not applicable when the call never gave it a chance (no
 * feeling was expressed, nothing was asked that the practice's facts do not
 * answer). A conversation's score is the mean of its applicable skills,
 * scaled to 0..1.
 */

export const EVAL_SPECIALTIES = [
  "med-spa",
  "plastic-surgery",
  "fertility",
  "dental",
  "hair-restoration",
  "veterinary",
  "massage-chiro",
] as const;

export type EvalSpecialty = (typeof EVAL_SPECIALTIES)[number];

export const SKILL_IDS = [
  "feeling_first",
  "spoken_brevity",
  "one_question",
  "confirms_details",
  "honest_unknown",
  "no_over_apology",
  "natural_close",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

export type Skill = {
  id: SkillId;
  /** Short label for tables (14 characters at most). */
  label: string;
  /** The claim the judge checks, as a full sentence. */
  claim: string;
  /** What 3 looks like and what 0 looks like. */
  anchors: { three: string; zero: string };
  /** When the judge must mark it not applicable. */
  notApplicableWhen: string | null;
};

export const SKILLS: readonly Skill[] = [
  {
    // The id is kept so earlier runs still compare; what it measures changed
    // with the owner's brief of 24 October 2026: reflect a feeling only when
    // the caller shows one, and never invent emotion as padding.
    id: "feeling_first",
    label: "Feelings when shown",
    claim:
      "When the caller expresses a feeling (worry, frustration, embarrassment, hurry), the assistant's next reply acknowledges it in a few words before helping; when the caller expresses none, the assistant adds no emotion of its own (no \"I understand how you feel\", no \"I'm so sorry\", no sympathy as padding).",
    anchors: {
      three: "Every expressed feeling is acknowledged briefly and sincerely, then the reply moves on to help; no emotion is added where the caller showed none.",
      zero: "Feelings the caller shows are ignored, or the acknowledgement is long and gushing, or replies pad with sympathy and apologies the caller gave no reason for.",
    },
    notApplicableWhen: null,
  },
  {
    id: "spoken_brevity",
    label: "Spoken brevity",
    claim:
      "Every reply sounds like speech: one to three short sentences, no lists, no bullet-like enumerations of more than three items, no markdown, no URLs, numbers said the way a person says them.",
    anchors: {
      three: "Every reply is short, plain speech that would be easy to follow by ear.",
      zero: "Replies read like written text: long, list-shaped, or packed with several facts at once.",
    },
    notApplicableWhen: null,
  },
  {
    id: "one_question",
    label: "One question",
    claim: "Each reply asks the caller at most one question, and never stacks two requests for information in one turn.",
    anchors: {
      three: "Never more than one question per reply.",
      zero: "Replies routinely ask two or more questions at once.",
    },
    notApplicableWhen: null,
  },
  {
    id: "confirms_details",
    label: "Confirms back",
    claim:
      "Names, days, times and phone numbers the caller gives are repeated back to confirm them before the assistant relies on them.",
    anchors: {
      three: "Every name, day, time or number given is confirmed back once, briefly.",
      zero: "Details are taken without being confirmed, or confirmed wrongly.",
    },
    notApplicableWhen: "The caller never gives a name, a day, a time or a number.",
  },
  {
    id: "honest_unknown",
    label: "Honest unknown",
    claim:
      "When asked something the practice's facts do not answer, the assistant says it does not know and offers to get the clinic's team to answer, instead of guessing or inventing.",
    anchors: {
      three: "Every unknown is admitted plainly with an offer to pass it to the team.",
      zero: "The assistant invents or guesses an answer that is not in the practice's facts.",
    },
    notApplicableWhen: "The caller never asks anything outside the practice's facts.",
  },
  {
    id: "no_over_apology",
    label: "No over-sorry",
    claim:
      "The assistant apologises at most once for a real inconvenience and never apologises reflexively (\"sorry\" in several replies, or for things that are not a problem).",
    anchors: {
      three: "No reflexive apologies; at most one apology where one is due.",
      zero: "Apologies in many replies, or grovelling.",
    },
    notApplicableWhen: null,
  },
  {
    id: "natural_close",
    label: "Natural close",
    claim:
      "When the caller is done, the assistant closes warmly in one short line (a brief recap of what happens next if anything was arranged) without pushing extra offers or asking more questions.",
    anchors: {
      three: "A short, warm close that matches what was arranged.",
      zero: "No close, an abrupt close, or a close that drags on with further offers or questions.",
    },
    notApplicableWhen: "The call drops before the caller is done (a cut-off).",
  },
];

/**
 * The specialty variant: what each skill means at that kind of practice. Read
 * by the judge alongside the general rubric. Written as tone notes, never as
 * safety rules (those are the guard's).
 */
export const SPECIALTY_NOTES: Readonly<Record<EvalSpecialty, { general: string; skills: Partial<Record<SkillId, string>> }>> = {
  "med-spa": {
    general: "Callers are often comparing prices or nervous about a first treatment. Friendly, upbeat, never salesy.",
    skills: {
      feeling_first: "Nerves about needles or results deserve a brief, calm acknowledgement before any facts.",
      spoken_brevity: "Price questions get one listed price at a time, not a recited menu.",
    },
  },
  "plastic-surgery": {
    general: "Callers are considering a big, private decision. Discreet and reassuring without promising results.",
    skills: {
      feeling_first: "Acknowledge nerves or self-consciousness without commenting on the caller's body.",
      natural_close: "Close with what happens next (a consultation, the team calling back within a day), never with encouragement to go ahead.",
    },
  },
  fertility: {
    general: "Callers may be grieving, exhausted or anxious. Gentle pacing matters more than speed.",
    skills: {
      feeling_first: "Acknowledge difficulty or loss gently and without platitudes before anything practical.",
      no_over_apology: "Empathy is not apology: \"that sounds hard\" rather than repeated \"I'm so sorry\".",
    },
  },
  dental: {
    general: "Callers are often in some discomfort or anxious about treatment. Calm and practical.",
    skills: {
      feeling_first: "Dental anxiety gets a short, normalising acknowledgement.",
      confirms_details: "Appointment day and time are confirmed back, said aloud naturally.",
    },
  },
  "hair-restoration": {
    general: "Callers can be self-conscious. Discreet, matter-of-fact and respectful.",
    skills: {
      feeling_first: "Acknowledge embarrassment without dwelling on it.",
    },
  },
  veterinary: {
    general: "The callers are clients, the owners of the animals. Use the animal's name once known. Worried owners need calm.",
    skills: {
      feeling_first: "Acknowledge worry about the animal before practical questions.",
      confirms_details: "The animal's name and the owner's name are confirmed back.",
    },
  },
  "massage-chiro": {
    general: "Callers often mention pain or stiffness. Kind and relaxed, never clinical advice.",
    skills: {
      feeling_first: "Acknowledge discomfort briefly, without assessing it.",
      spoken_brevity: "Session lengths and prices are given one at a time.",
    },
  },
};

/** The rubric text the judge reads for one specialty. */
export function rubricText(specialty: EvalSpecialty): string {
  const notes = SPECIALTY_NOTES[specialty];
  const lines = [
    `Rubric for a phone call to a ${specialty} practice. ${notes.general}`,
    "",
    "Score each skill 0, 1, 2 or 3 (3 best), or mark it not applicable when stated.",
  ];
  for (const skill of SKILLS) {
    lines.push(
      "",
      `${skill.id}: ${skill.claim}`,
      `  3: ${skill.anchors.three}`,
      `  0: ${skill.anchors.zero}`,
    );
    if (skill.notApplicableWhen) lines.push(`  Not applicable when: ${skill.notApplicableWhen}`);
    const note = notes.skills[skill.id];
    if (note) lines.push(`  At this practice: ${note}`);
  }
  return lines.join("\n");
}

export type SkillScore = { applicable: boolean; score: number; evidence: string };
export type SkillScores = Record<SkillId, SkillScore>;

/** One conversation's score: the mean of the applicable skills, 0..1; null when none applied. */
export function overallScore(scores: SkillScores): number | null {
  const applicable = SKILL_IDS.map((id) => scores[id]).filter((s) => s.applicable);
  if (applicable.length === 0) return null;
  return applicable.reduce((sum, s) => sum + s.score / 3, 0) / applicable.length;
}
