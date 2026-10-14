import { isSpecialtyId, regimeFor } from "./specialties";

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
 * them now (they cannot breathe or swallow, they have a reaction, it will not
 * stop bleeding, the skin has gone white over the filler, they want to hurt
 * themselves), and it gets the urgent reply instead: 911 first, then the
 * clinic's number. A message that matches both is urgent, so callers screen
 * with this one first.
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
 * There are two sets, chosen by the practice's specialty (urgentSetFor):
 * the set for people, below, for every practice HIPAA can reach, and the
 * veterinary set (VETERINARY_PATTERNS) for a practice whose patients are
 * animals. The spec sells a veterinary practice only once that set and its
 * emergency referral number exist ("Veterinary practices are sold only once
 * the veterinary urgent set and an emergency referral number are in
 * place"), because an animal's emergency is not 911's: its fixed reply
 * (./urgent-replies.ts) gives the emergency vet the practice refers to.
 *
 * It returns the family that matched and which emergency service the reply
 * points to, never the words: the text it reads is a patient's or a
 * client's, and what it matched must not reach a log, a row or a reply.
 */

/**
 * Which emergency service the fixed reply points to: 911 for a person, the
 * emergency vet for an animal. A veterinary practice's client in crisis
 * themselves is a person, so that family keeps 911 in the veterinary set.
 */
export type UrgentEmergency = "911" | "veterinary";

export type UrgentFinding = { label: string; emergency: UrgentEmergency };

/** Which set a practice is screened with. */
export type UrgentSet = "human" | "veterinary";

type UrgentPattern = { pattern: RegExp; label: string };

const URGENT_PATTERNS: UrgentPattern[] = [
  {
    // "Urgent", but not after "not" or "non": "nothing urgent, just a price"
    // is not. 911 on its own, never inside a run of digits or a dashed number.
    pattern:
      /\b(emergenc(y|ies)|ambulance|paramedics?|urgent care)\b|\b(go(ing)? to|in|at|take (me|him|her|them) to) (the )?(hospital|ER|A&E)\b|(?<!\b(not|non|isn't|nothing)[\s-]?)\burgent(ly)?\b|(?<![\d-])\b911\b(?![\d-])/i,
    label: "an emergency",
  },
  {
    // Swallowing beside breathing: trouble swallowing after a toxin is the
    // spread of its effect that botulinum toxin's boxed warning names.
    pattern:
      /\b(can'?t|cannot|can not|couldn'?t|hard to|trouble|difficulty|struggling to|unable to) breath(e|ing)?\b|\bshort(ness)? of breath\b|\bbreathless\b|\bthroat (is |feels )?(closing|tight\w*|swell\w*|swollen)\b|\bchest (pains?|tightness|pressure)\b|\b(heart attack|palpitations?|heart (is )?racing|racing heart)\b|\b(can'?t|cannot|can not|couldn'?t|hard to|trouble|difficulty|struggling to|unable to|hurts? to|painful to) swallow(ing)?\b|\b(trouble|difficulty|problems?|pain) (with |when |on )?swallowing\b|\bdysphagia\b/i,
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
    // Someone with a reaction or a complication, in any tense ("I have a
    // reaction", "she has a complication", "I've had", "I get"); one called
    // bad with no verb at all ("bad reaction to the filler"); a body reacting
    // to something. Complications asked about in general ("are there any
    // complications?") are the clinical screen's, which hands off without 911.
    pattern:
      /\b(have|has|having|had|get|gets|getting|got|develop(s|ed|ing)?) (an? |some )?((really|very) )?(bad |severe |serious |allergic |strange |weird |nasty |terrible |awful |horrible )?(reaction|complication)s?\b|\b(bad|severe|serious|strange|weird|nasty|terrible|awful|horrible) (reaction|complication)s?\b|\breact(ed|ing) (badly|terribly|really badly|to (the|my|it|this|that))\b/i,
    label: "a reaction or a complication",
  },
];

// -----------------------------------------------------------------------------
// The veterinary set
// -----------------------------------------------------------------------------

/**
 * Something an animal ate or swallowed. A verb of eating, then within a few
 * words one of the things a vet treats as a poisoning ("ate a whole bar of
 * chocolate", "got into my ibuprofen", "licked antifreeze") or, after
 * swallowing alone, as an obstruction ("swallowed a sock", "ate a corn
 * cob"). Only the forms that report it happening: "can dogs eat grapes?" is
 * a question for the desk, and "loves eating bones" is not one bone
 * swallowed.
 */
const ATE_TOXIN =
  "(ate|eaten|eats|eating|swallowed|swallowing|ingested|chewed|licked|drank|drunk|got into|gotten into)";
const TOXIN =
  "(chocolate|cocoa|grapes?|raisins?|sultanas?|currants?|xylitol|(chewing )?gum|onions?|garlic|lil(y|ies)|pills?|tablets?|medications?|medicines?|meds|ibuprofen|advil|motrin|aleve|naproxen|tylenol|paracetamol|acetaminophen|aspirin|anti-?freeze|(rat|mouse) (poison|bait)|poison|bleach|detergent|(laundry |dishwasher )?pods?|weed|marijuana|cannabis|edibles?|mushrooms?|macadamias?|avocados?|coffee|caffeine|cigarettes?|nicotine|vapes?|alcohol|insecticide|pesticide|fertili[sz]er|slug (pellets|bait)|snail bait|something (toxic|poisonous))";
const ATE_OBJECT = "(ate|eaten|swallowed|swallowing|ingested)";
const OBJECT =
  "(batter(y|ies)|socks?|string|thread|ribbon|tinsel|hair ties?|toy|ball|bone|(chicken|cooked) bones|corn ?cobs?|fish(ing)? ?hooks?|needles?|coins?|magnets?|part of (a|the|his|her|its|their|my))";

/**
 * The veterinary set (the v1 spec, "HIPAA and BAA position": a veterinary
 * practice is sold only once it exists). What a client writes or says when
 * their animal needs emergency care now: a poisoning or something swallowed,
 * bloat (gastric dilatation and volvulus), trouble breathing, a collapse or
 * a seizure, heavy bleeding, being hit by a car or attacked, a cat that
 * cannot pass urine, heatstroke, an eye injury, a difficult birth, a severe
 * allergic reaction, vomiting that will not stop, and severe pain.
 *
 * A closed list, and as blunt as the set for people: a false positive gives
 * a client the emergency vet's number and the practice's own, which is where
 * a question about a poisoning belongs anyway. What it will not do is fire
 * on the business of a veterinary front desk: vaccinations, a spay or a
 * neuter, a dental cleaning, nail trims, grooming, boarding, a microchip, a
 * puppy's first shots or a litter due in the spring. The tests
 * (./urgent-content.test.ts) hold both sides.
 *
 * The client's own crisis comes first and keeps 911: someone who writes that
 * they want to end their life is a person, whatever the practice treats.
 */
const VETERINARY_PATTERNS: (UrgentPattern & { emergency?: UrgentEmergency })[] = [
  {
    pattern:
      /\b(suicid\w*|kill (my|him|her|them)sel(f|ves)|end (my|his|her) life|(i|I) (just )?want to die|self[- ]harm\w*|hurt(ing)? (my|them)sel(f|ves))\b/i,
    label: "a crisis",
    emergency: "911",
  },
  {
    // The emergency words of the set for people, and an animal hospital.
    pattern:
      /\b(emergenc(y|ies)|(animal|pet|vet|veterinary) (hospital|ER)|ambulance|urgent care)\b|\b(go(ing)? to|in|at|take (him|her|them|it) to) (the )?(hospital|ER|emergency room)\b|(?<!\b(not|non|isn't|nothing)[\s-]?)\burgent(ly)?\b|(?<![\d-])\b911\b(?![\d-])/i,
    label: "an emergency",
  },
  {
    pattern: new RegExp(
      `\\b(poison(ed|ing|ous)?|(?<!\\bnon[\\s-]?)toxic|toxins?|toxicity|anti-?freeze|rat bait|rodenticide)\\b` +
        `|\\b${ATE_TOXIN}\\b(?:[\\s,]+[\\w'-]+){0,5}?[\\s,]+${TOXIN}\\b` +
        `|\\b${ATE_OBJECT}\\b(?:\\s+[\\w'-]+){0,4}?\\s+${OBJECT}\\b`,
      "i",
    ),
    label: "a poisoning or something swallowed",
  },
  {
    pattern:
      /\b(bloat(ed|ing)?|gdv|twisted (stomach|gut)|stomach (has )?twist\w*|(belly|stomach|abdomen|tummy) (is |looks |feels |seems |has gone |got )?(swollen|distended|hard|tight|bloated|huge|enlarged)|(swollen|distended|hard|bloated) (belly|stomach|abdomen|tummy)|retching|dry[- ]?heav\w*|trying to (vomit|throw up|be sick)|unproductive (vomiting|retching))\b/i,
    label: "bloat",
  },
  {
    pattern:
      /\b(can'?t|cannot|can not|couldn'?t|hard to|trouble|difficulty|struggling to|unable to|not|isn'?t|stopped) breath(e|ing)\b|\bbreathing (hard|heavily|fast|funny|strange(ly)?|weird(ly)?|badly|noisily)\b|\bshort(ness)? of breath\b|\b(gasping|wheezing|choking|choked)\b|\bpanting (heavily|hard|a lot|non-?stop|constantly)\b|\b(blue|white|grey|gray|pale|purple) (gums|tongue)\b|\b(gums|tongue) (is |are |looks? |have gone |has gone |turned )?(blue|white|grey|gray|pale|purple)\b/i,
    label: "breathing",
  },
  {
    pattern:
      /\b(collaps(e|ed|es|ing)|unconscious|unresponsive|passed out|fainted|fainting|seizures?|seizing|convuls\w*|(having|had|has|having another) (a )?fits?|(is|was|keeps|started) fitting|paraly[sz]\w*|dying|can'?t (stand|stand up|get up|walk|move (his|her|its|their) (back |hind )?legs)|(won'?t|will not|unable to) (stand|get up|walk)|dragging (his|her|its|their) (back |hind )?legs|(back|hind) legs (have )?(gone|given out|stopped working|collapsed))\b/i,
    label: "a collapse or a seizure",
  },
  {
    pattern:
      /\b(bleed(ing|s)?|bled|ha?emorrhag\w*)\b|\bblood (in|from) (his|her|its|their|the) (urine|pee|wee|stool|poo|poop|vomit|mouth|nose|ears?|eyes?|bottom)\b|\b(bloody|blood in) (urine|pee|wee|stool|poo|poop|vomit|diarrh\w*|nose)\b|\b(vomiting|throwing up|coughing( up)?|peeing|pooping) blood\b/i,
    label: "bleeding",
  },
  {
    pattern:
      /\b(hit by a (car|truck|vehicle|bike|bus|van)|(was |got |been )?run over|struck by a (car|vehicle)|(car|road) accident|fell (off|from|out of) (a |the )?(balcony|window|roof|deck|stairs|bed|table|car)|(attacked|mauled|bitten) by (a |an |another |the |two )?(dog|dogs|coyote|cat|snake|animal)|dog ?fight|snake ?bite|broken (leg|bone|tail|jaw|paw|hip|pelvis)|(leg|bone|tail|jaw|paw|hip) (is |looks )?broken|(deep|open|big|bad|gaping) (wound|cut|gash)|impaled|electrocuted|(chewed|bit) (through )?(an |the |a )?(electric(al)? |power )?(cord|wire|cable)|scalded|burned|burnt)\b/i,
    label: "an accident or an injury",
  },
  {
    // A male cat that cannot pass urine dies of it within days.
    pattern:
      /\b(can'?t|cannot|unable to|isn'?t able to|not able to|trying to|straining to|struggling to|keeps trying to) (pee|urinate|wee|pass urine)\b|\b(not|hasn'?t|has not|hasn'?t been|isn'?t) (peeing|urinating|weeing|peed|urinated)\b|\bno (urine|pee)\b|\b(urinary|urethral|bladder) (blockage|obstruction)\b|\b(blocked|obstructed) (bladder|urethra|cat|tom)\b|\bstraining (in|to use) the (litter ?box|litter ?tray|tray)\b/i,
    label: "not passing urine",
  },
  {
    pattern: /\b(heat ?stroke|heat exhaustion|over-?heat(ed|ing)|(left|locked|stuck) in (a|the) (hot )?car)\b/i,
    label: "heatstroke",
  },
  {
    pattern:
      /\b(eye injur\w*|injur(ed|y to) (his|her|its|their|the) eye|eye (is |has )?(popped|popping|bulging|out of (its|the) socket|hanging out|bleeding|punctured|swollen shut)|proptos\w*|scratch(ed)? (on )?(his|her|its|their|the) eye|something (stuck )?in (his|her|its|their) eye)\b/i,
    label: "an eye injury",
  },
  {
    pattern:
      /\b(dystocia|(puppy|puppies|kitten|kittens|foal) (is |are |seems |looks )?stuck|(trouble|difficulty|problems?|struggling|straining|pushing) (with |to |for )?(give birth|giving birth|whelp\w*|deliver\w*|birthing|queening|labou?r)|(been )?in labou?r for|labou?r (is |has )?(not progressing|stalled|stopped)|retained (placenta|puppy|kitten))\b/i,
    label: "a difficult birth",
  },
  {
    pattern:
      /\b(allergic reaction|anaphyla\w*|hives|(face|muzzle|snout|lips?|throat|tongue|neck|head) (is |are |has |looks |started )?(swell\w*|swollen|puffy|puffed up)|swollen (face|muzzle|snout|lips?|throat|tongue|neck|head)|stung by|(bee|wasp|hornet|scorpion) sting|(spider|insect) bite)\b/i,
    label: "an allergic reaction",
  },
  {
    pattern:
      /\b((can'?t|won'?t) stop|keeps|keep|constantly|non-?stop) (vomiting|throwing up|being sick|having diarrh\w*)\b|\b(vomiting|throwing up|being sick) (all|for) (day|night|hours|\d+ hours)\b|\b(vomited|threw up|been sick) (\d+|several|many|multiple|five|six|lots of) times\b/i,
    label: "vomiting that will not stop",
  },
  {
    pattern:
      /\b(screaming|crying|yelping|howling|whimpering|shaking) (in|with|from) pain\b|\bin (a lot of|so much|severe|terrible|extreme|agonising|agonizing) pain\b|\b(severe|extreme|excruciating|terrible) pain\b/i,
    label: "severe pain",
  },
];

/**
 * The set a practice is screened with: the veterinary set where its patients
 * are animals (the specialty's regime is `non-hipaa`), the set for people
 * everywhere else, an unknown or missing specialty included.
 */
export function urgentSetFor(specialty: string | null | undefined): UrgentSet {
  return isSpecialtyId(specialty) && regimeFor(specialty) === "non-hipaa" ? "veterinary" : "human";
}

/** How many families each set has: the readiness check (agreement-kind.ts) reads it. */
export const URGENT_FAMILY_COUNT: Readonly<Record<UrgentSet, number>> = {
  human: URGENT_PATTERNS.length,
  veterinary: VETERINARY_PATTERNS.length,
};

/**
 * Whether a message reports a complication or an urgent symptom, screened
 * with the practice's own set (urgentSetFor). Null means it does not, and the
 * message may go on to the clinical screen and the model. Curly apostrophes
 * are read as straight ones first, because that is how a phone keyboard
 * writes "can't". Called without a specialty it screens with the set for
 * people, as it always has.
 */
export function findUrgentContent(
  text: string | null | undefined,
  specialty?: string | null,
): UrgentFinding | null {
  if (!text) return null;
  const plain = text.replace(/[‘’ʼ]/g, "'");
  if (urgentSetFor(specialty) === "veterinary") {
    for (const { pattern, label, emergency } of VETERINARY_PATTERNS) {
      if (pattern.test(plain)) return { label, emergency: emergency ?? "veterinary" };
    }
    return null;
  }
  for (const { pattern, label } of URGENT_PATTERNS) {
    if (pattern.test(plain)) return { label, emergency: "911" };
  }
  return null;
}
