/**
 * The pre-model urgent screen: a complication or an urgent symptom, caught
 * before any model sees the message.
 *
 * The spec's guardrail (docs/v1-product-spec.md, "Guardrails"): "Messages
 * matching complication or urgent-symptom patterns short-circuit the model
 * entirely: fixed response, immediate escalation to the clinic's address.
 * The fixed response tells the person to call 911 in an emergency and gives
 * the clinic's urgent-help number. The matching happens before the model sees
 * the message, not after." A model told "do not triage" is not a guardrail
 * against a person describing a reaction: by the time it has read the
 * message, it has been asked to triage. So this runs first, over the person's
 * own words, and a hit means the model is never called.
 *
 * It is the other half of findClinicalContent (./clinical-content.ts), not a
 * second copy of it. That one is the vocabulary of clinical claims and
 * questions (safety, dosing, candidacy, a condition), and it moves a person
 * to a call. This one is what someone writes when something is happening to
 * them now (they cannot breathe, it will not stop bleeding, the skin has
 * gone white over the filler, they want to hurt themselves), and it gets the
 * urgent reply instead: 911 first, then the clinic's number. A message that
 * matches both is urgent, so callers screen with this one first.
 *
 * Like findClinicalContent it is deliberately blunt. A false positive costs
 * the person a fixed reply that says "if this is an emergency" and gives
 * them the clinic's number, which is where a question about swelling or
 * bleeding belongs anyway. A false negative is a person describing an
 * allergic reaction getting a chatty answer from a model on a channel that
 * cannot carry it. What it will not do is fire on the ordinary business of a
 * front desk: hours, prices, parking, a booking, numbing cream, back pain as
 * a reason to book. tests (./urgent-content.test.ts) hold both sides.
 *
 * This is the set for people. A veterinary practice's urgent set and its
 * emergency referral number are a launch item of their own (the v1 spec,
 * "Veterinary practices are sold only once..."): until they exist, nothing
 * here knows that an animal's emergency is not 911's.
 *
 * It returns the family that matched, never the words: the text it reads is
 * a patient's, and what it matched must not reach a log, a row or a reply.
 */

export type UrgentFinding = { label: string };

const URGENT_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    // "Urgent", but not after "not" or "non": "nothing urgent, just a price"
    // is not. 911 on its own, never inside a run of digits or a dashed number.
    pattern:
      /\b(emergenc(y|ies)|ambulance|paramedics?|urgent care)\b|\b(go(ing)? to|in|at|take (me|him|her|them) to) (the )?(hospital|ER|A&E)\b|(?<!\b(not|non|isn't|nothing)[\s-]?)\burgent(ly)?\b|(?<![\d-])\b911\b(?![\d-])/i,
    label: "an emergency",
  },
  {
    pattern:
      /\b(can'?t|cannot|can not|couldn'?t|hard to|trouble|difficulty|struggling to|unable to) breath(e|ing)?\b|\bshort(ness)? of breath\b|\bbreathless\b|\bthroat (is |feels )?(closing|tight\w*|swell\w*|swollen)\b|\bchest (pains?|tightness|pressure)\b|\b(heart attack|palpitations?|heart (is )?racing|racing heart)\b/i,
    label: "breathing, the throat or the chest",
  },
  { pattern: /\b(allergic reaction|anaphyla\w*|hives)\b/i, label: "an allergic reaction" },
  { pattern: /\b(swell(ing|s|ed)|swell up|swollen)\b/i, label: "swelling" },
  { pattern: /\b(bleed(ing|s)?|bled|ha?emorrhag\w*)\b/i, label: "bleeding" },
  {
    pattern:
      /\b(pus|oozing|abscess(es)?|fever(ish)?|infected|sepsis|blister(s|ed|ing)?|burns|burned|burnt)\b|\bburning (sensation|pain|feeling)\b/i,
    label: "an infection or a burn",
  },
  {
    // What a vascular occlusion after filler looks like, and sight.
    pattern:
      /\b(blanch\w*|mottl\w*|necro\w*|turn(ed|ing|s)? (white|blue|purple|black)|(lost|losing|loss of|blurr(y|ed)|double) (my |his |her )?(vision|sight)|vision loss|can'?t see (properly|clearly|anything|out of))\b/i,
    label: "a change in the skin or in sight",
  },
  {
    pattern:
      /\b(severe|extreme|excruciating|unbearable|intense|terrible|horrible|awful|worst|agoni[sz]ing) (pain|headache|cramps?|cramping)\b|\bin (a lot of|so much|lots of) pain\b|\bpain (is |keeps )?(getting )?(worse|unbearable)\b/i,
    label: "severe pain",
  },
  {
    pattern:
      /\b(faint(ed|ing)?|pass(ed|ing) out|black(ed)? out|unconscious|(lost|loss of|losing) consciousness|unresponsive|collaps(e|ed|ing)|seizures?|convuls\w*|(having|had|a) stroke|slurr(ed|ing)|numbness|can'?t feel (my|his|her|the|anything)|paraly[sz]\w*|dizz(y|iness)|light-?headed|vomit(ing|ed)?|throwing up)\b/i,
    label: "consciousness or the nerves",
  },
  {
    pattern:
      /\b(wound|incision|stitch(es)?|sutures?) (has |have |is |are )?(opened|open|opening|split|burst|came out|come out|coming out|leak\w*|ooz\w*|bleed\w*)\b|\b(knocked[- ]out|broke(n)?|cracked|chipped) (a |my |his |her |their )?(front )?(tooth|teeth|jaw)\b|\b(tooth|teeth) (got )?(knocked out|broke|broken|cracked)\b/i,
    label: "a wound or an injury",
  },
  {
    pattern:
      /\b(suicid\w*|kill (my|him|her|them)sel(f|ves)|end (my|his|her) life|wants? to die|self[- ]harm\w*|hurt(ing)? (my|him|her|them)sel(f|ves)|overdos\w*|poison(ed|ing))\b/i,
    label: "a crisis",
  },
  {
    pattern:
      /\b(having|had|getting|got) (an? )?(bad |severe |allergic |strange |weird )?(reaction|complication)s?\b/i,
    label: "a reaction or a complication",
  },
];

/**
 * Whether a message reports a complication or an urgent symptom. Null means
 * it does not, and the message may go on to the clinical screen and the
 * model. Curly apostrophes are read as straight ones first, because that is
 * how a phone keyboard writes "can't".
 */
export function findUrgentContent(text: string | null | undefined): UrgentFinding | null {
  if (!text) return null;
  const plain = text.replace(/[‘’ʼ]/g, "'");
  for (const { pattern, label } of URGENT_PATTERNS) {
    if (pattern.test(plain)) return { label };
  }
  return null;
}
