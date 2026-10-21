import { leansSpanish } from "./message-language";
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
 * veterinary set (VETERINARY_FAMILIES) for a practice whose patients are
 * animals. The spec sells a veterinary practice only once that set and its
 * emergency referral number exist ("Veterinary practices are sold only once
 * the veterinary urgent set and an emergency referral number are in
 * place"), because an animal's emergency is not 911's: its fixed reply
 * (./urgent-replies.ts) gives the emergency vet the practice refers to. A
 * person's own emergency at a veterinary practice is still 911's: a crisis,
 * a named person ("my husband collapsed"), the person speaking ("I can't
 * breathe") or an ambulance asked for gets the reply for people
 * (personEmergency below), and every veterinary reply says to call 911 if a
 * person is hurt or in danger.
 *
 * Each family is written in English and in Spanish, the two languages the
 * assistant answers in (assistant-settings.ts, SCREENED_LANGUAGES), and both
 * are always read, whatever the clinic has switched on: a Spanish message to
 * an English-only practice is screened all the same. A message in any other
 * language is caught by messageLanguage (./message-language.ts) and never
 * reaches the model.
 *
 * Two things are read past before matching: the practice's own name ("is
 * Oakwood Animal Hospital open?" is not an emergency), and a question about
 * the practice's emergency service ("do you offer emergency appointments?",
 * "is it urgent to get my puppy vaccinated?"). Only those words go; anything
 * else in the message is still read, so "do you take emergency appointments?
 * he was hit by a car" is still urgent.
 *
 * It returns the family that matched, which emergency service the reply
 * points to and the language the reply is written in, never the words: the
 * text it reads is a patient's or a client's, and what it matched must not
 * reach a log, a row or a reply.
 */

/**
 * Which emergency service the fixed reply points to: 911 for a person, the
 * emergency vet for an animal.
 */
export type UrgentEmergency = "911" | "veterinary";

/** The language a finding's reply is written in: that of the words that matched. */
export type UrgentLanguage = "en" | "es";

export type UrgentFinding = {
  label: string;
  emergency: UrgentEmergency;
  language: UrgentLanguage;
  /**
   * Present, and true, only when the words that matched are a family's
   * fragments in a language the assistant does not answer in (French,
   * German, Italian, Portuguese). The caller still escalates; it may answer
   * with its line for another language (both of ours, with 911) rather than
   * the English one.
   */
  otherLanguage?: true;
};

/** Which set a practice is screened with. */
export type UrgentSet = "human" | "veterinary";

export type UrgentOptions = {
  /** The practice's own name, read past: a veterinary hospital's name is not an emergency. */
  clinicName?: string | null;
};

/**
 * One family, in each language it is written in. `other` is fragments of the
 * same family in French, German, Italian and Portuguese: languages the
 * assistant does not answer in, so a message in one never reaches the model
 * anyway (messageLanguage). Reading them here is only so that an urgent one
 * is escalated to the clinic like any other, rather than getting the
 * language line with no alert. Its reply is written in English.
 */
type UrgentFamily = { label: string; en: RegExp; es?: RegExp; other?: RegExp };

/**
 * A pattern for words that may carry accents: Unicode-aware edges, because
 * \b does not see "á" or "ñ" as part of a word.
 */
function es(body: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");
}

// -----------------------------------------------------------------------------
// The crisis family, one for both sets
// -----------------------------------------------------------------------------

/**
 * Someone who wants to end their life or hurt themselves. Always a person:
 * at a veterinary practice too, it gets 911. Recall first: a false positive
 * costs one fixed reply with the numbers, a miss lets the model answer.
 * What is not a crisis: an injury told as one ("I hurt myself skiing", "my
 * dog hurt himself jumping off the bed"), which is hurt without intent, and
 * the turns of phrase ("dying to", "to die for", "die of worry", "this
 * traffic is killing me").
 */
const SELF_HARM_EN = new RegExp(
  [
    "\\bsuicid\\w*",
    // Text speak: "kms" (kill myself), "unalive", "killmyself".
    // Not kilometres: "5 kms", "how many kms", "kms from the airport".
    "(?<!(\\d|\\bmany|\\bfew|\\bthe|\\bof)\\s?)\\bkms\\b(?!\\s+(from|away|to|of|drive|north|south|east|west)\\b)",
    "\\bunaliv\\w*",
    "\\bkill(ing)?my ?self\\b",
    "\\bkill(ing|ed)? (my|him|her|them)sel(f|ves)\\b",
    "\\bend(ing)? (my|his|her|their) (own )?life\\b",
    "\\bend(ing)? it all\\b",
    "\\b(want|wants|wanna|going|gonna|ready|plan(ning)?|need|thinking (of|about)) (to )?end(ing)? it\\b(?!\\s+(with|early|before|after|for|on|by|at|there|here|today|tomorrow|now with))",
    "\\b(want|wants) to die\\b(?! (of|from) (worry|embarrassment|laughing|laughter|boredom|shame|cringe|cuteness))",
    "\\bwanna die\\b(?! (of|from) (worry|embarrassment|laughing|laughter|boredom|shame|cringe|cuteness))",
    "\\bbetter off (dead|without me)\\b",
    "\\bwish (i|he|she) (was|were) dead\\b",
    "\\bwish (i|he|she) could (just )?die\\b",
    "\\b(don'?t|do not|doesn'?t|does not|no longer) want to (live|be alive|be here|exist|wake up)( any ?more)?\\b",
    "\\bself[- ]harm\\w*",
    "\\bcutting (my|him|her|them)sel(f|ves)\\b",
    "\\b(want(s|ed)?|wanna|going|gonna|plan(s|ning)?|thinking (of|about)|threaten(s|ed|ing)?|tr(y|ies|ied|ying)|keep(s)?|might|will|could|about) (to )?hurt(ing)? (my|him|her|them)sel(f|ves)\\b",
  ].join("|"),
  "i",
);
const SELF_HARM_ES = es(
  "suicid\\p{L}*|quitarme la vida|quiero morir(me)?|me quiero morir|me (quiero|voy a|pienso|quisiera) (matar|morir)|me mato|matarme|me voy a quitar la vida|(me )?(cort[ée]|cortarme|cort[áa]ndome) las (venas|mu[ñn]ecas)|me estoy cortando|(ya )?no quiero (seguir )?(vivir|estar aqu[íi]|existir)|hacerme da[ñn]o|lastimarme|acabar con (mi vida|todo)|terminar con (mi vida|todo)",
);

/** Medicines named in an overdose: the common over-the-counter and prescription ones. */
const DRUGS =
  "tylenol|advil|motrin|aleve|ibuprofen|acetaminophen|paracetamol|aspirin|excedrin|benadryl|nyquil|xanax|valium|klonopin|ativan|ambien|oxy|oxycodone|oxycontin|percocet|vicodin|hydrocodone|fentanyl|morphine|codeine|tramadol|adderall|lithium|seroquel|zoloft|prozac|lexapro|wellbutrin|trazodone|gabapentin|insulin|heroin|cocaine|meth";
const PILLS = `pills|tablets|caps|capsules|meds|medications?|medicines?|sleeping pills|painkillers|${DRUGS}`;

/**
 * Too many pills: a person's overdose, unless the message is about an
 * animal (personEmergency). By the generic words ("a bottle of pills"), by
 * a medicine's name with a quantity ("30 tylenol", "a bunch of xanax"), and
 * by someone named who took something.
 */
const OVERDOSE_EN = new RegExp(
  [
    "\\boverdos\\w*",
    `\\b(took|taken|take|swallowed|ate|downed|had) (too many|so many|a (whole )?(bottle|handful|bunch|lot|pack|box|fistful) of|a lot of|lots of|all (of )?(my|the|her|his|their)|([5-9]|[1-9]\\d{1,2})) (\\w+ )?(${PILLS})\\b`,
    "\\b(he|she|they|someone|somebody|my (son|daughter|husband|wife|partner|kid|child|boyfriend|girlfriend|friend|mom|mum|dad|mother|father|brother|sister|roommate)) (just )?(took|has taken|swallowed) something\\b",
  ].join("|"),
  "i",
);
const OVERDOSE_ES = es(
  `sobredosis|(me |se )?(tom[ée]|tom[óo]|tragu[ée]|trag[óo]) (demasiadas|muchas|todas (las|mis|sus)|un frasco( entero)? de|una caja de|un mont[óo]n de|([5-9]|[1-9]\\d{1,2})) (pastillas|p[íi]ldoras|medicinas|medicamentos|tabletas|${DRUGS})`,
);

/**
 * A poisoning, in the set for people. In the veterinary set it is the
 * animal's (POISONING below). Not a joke about coffee.
 */
const POISONED_EN =
  /\bpoison(ed|ing)\b(?! (myself|me|ourselves) with (coffee|caffeine|sugar|junk food|fast food|carbs|candy|soda|energy drinks|takeout|pizza))/i;
const POISONED_ES = es("envenen\\p{L}*|intoxicad[oa]|intoxicaci[óo]n");

function union(...patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map((p) => `(?:${p.source})`).join("|"), "iu");
}

/** The crisis family of the set for people; the veterinary set reuses its parts (personEmergency). */
const CRISIS: UrgentFamily = {
  label: "a crisis",
  en: union(SELF_HARM_EN, OVERDOSE_EN, POISONED_EN),
  es: union(SELF_HARM_ES, OVERDOSE_ES, POISONED_ES),
  other: es("suicid\\p{L}*|me tuer|je veux mourir|en finir avec (la|ma) vie|selbstmord|mich umbringen|ich will sterben|uccidermi|voglio morire|me matar|quero morrer"),
};

// -----------------------------------------------------------------------------
// The set for people
// -----------------------------------------------------------------------------

const EMERGENCY_WORDS: UrgentFamily = {
  // "Urgent", but not after "not" or "non": "nothing urgent, just a price"
  // is not. 911 on its own, never inside a run of digits or a dashed number.
  label: "an emergency",
  // A cry for help in text speak: "SOS", "help!", "someone help", "help me
  // please", "pls hlp". Not "can you help me with a booking?".
  en: /(?<!\b(vos|que|tu|tú|si|no|ya) )\b(sos|mayday|hlp)\b|\bhelp+\s*!|\b(somebody|someone|anybody|anyone) help\b|\bhelp me+\s*(!|(please|pls|plz|now|asap)\b(?!\s*,?\s*(to|with|book|schedule|make|find|get|choose|pick|understand|figure|decide|reschedule|cancel|change)\b))|\b(pls|plz|please) (help|hlp)\s*(!|me\s*!|$)|\b(emergenc(y|ies)|ambulance|paramedics?|urgent care)\b|\b(go(ing)? to|in|at|take (me|him|her|them|it) to|bring (him|her|them|it) (in )?to) (the |an |a )?((animal|pet|vet|veterinary|emergency) )?(hospital|ER|A&E|emergency room|emergency vet)\b|(?<!\b(not|non|isn't|nothing)[\s-]?)\burgent(ly)?\b|(?<![\d-])\b911\b(?![\d-])/i,
  es: es(
    "emergencias?|ambulancia|param[ée]dicos?|urgencias|(?<!(nada|no es|no) )urgente|(ir|voy|vamos|ll[ée]vame|llevarme|llevarlo|llevarla|lo llevo|la llevo) (al|a la|a) (hospital|sala de emergencias|urgencias)|(?<![\\d-])911(?![\\d-])",
  ),
  other: es(
    "urgence|au secours|(à|a) l'aide|aidez-moi|notfall|notarzt|krankenwagen|rettungswagen|hilfe|emergenza|ambulanza|aiuto|pronto soccorso|emerg[êe]ncia|socorro(?=\\s*!)|¡\\s*socorro|(pe[çc]o|pido|preciso de|necesito|pedir) socorro|ajuda|ambul[âa]ncia",
  ),
};

/**
 * "Breathe" as it is typed in a hurry: "breath", "breething", "brething",
 * "brethe", "breathin". Only ever read beside a word of trouble, so "bad
 * breath" or "breathing exercises" is not urgent.
 */
const BREATH = "br(?:ea|ee|e)th(?:e|ing|in|ng|eing)?";
const BREATHING = "br(?:ea|ee|e)th(?:ing|in|ng|eing)";
/** "Can't", and the other words of not being able to, with their text-speak spellings. */
const CANNOT =
  "can'?t|cannot|can not|couldn'?t|cnt|carn'?t|hard to|(having )?(a )?hard time|trouble|difficulty|difficulties|dificulty|struggling to|struggle to|unable to|problems?";

/** A part of the body where a filler's occlusion shows as a change of colour. */
const SKIN_SUBJECT = "(lips?|skin|area|spot|site|nose|cheeks?|chin|face|forehead|tissue|bump|filler|tip of (my|the) nose)";
/**
 * Colours a vascular occlusion shows and no one describes their skin tone
 * or a mark with: read after any verb.
 */
const SKIN_VASCULAR = "(blue|bluish|blueish|purple|purplish|dusky|mottled|cold)";
/**
 * Colours that are also how a person describes their skin type, tone or a
 * mark ("my skin is dark, is laser safe?", "a spot that is dark", "my skin
 * is blotchy"): read after a verb of change ("went white", "turning grey"),
 * or after a verb of state only where the message ties it to a treatment
 * ("pale where the filler went"). Never before a feature ("getting dark spots").
 */
const SKIN_TONE = "(white|whiter|pale|paler|grey|gray|greyish|grayish|black|dark|blotchy|patchy)";
const SKIN_CHANGE = "(went|gone|going|turned|turning|turns|getting|got|became|become|becoming)";
const SKIN_STATE = "(is|are|has|have|been|looks?|looking|seems|feels?)";
const SKIN_ADVERB = "(very |really |all |completely |kind of |kinda |a bit |so |super )?";
const SKIN_NOT_A_FEATURE = "(?!\\s+(spots?|patch(es)?|circles?|marks?|freckles?|hairs?|heads?|lines?|rings?|skin|complexion|tone)\\b)";
const SKIN_TREATMENT = "(filler|fillers|injections?|injected|botox|treatment|procedure|needle|jab|shot)";
const SKIN_AFTER_TREATMENT = `(?:(?=.*\\b(where|after|since|around|from|near|at)\\b(?:\\s+[\\w']+){0,3}?\\s+${SKIN_TREATMENT}\\b)|(?<=\\b(after|since|from)\\s+(the |my |her |his |a |an |that |this )?${SKIN_TREATMENT}\\b.*))`;
const SKIN_COLOUR =
  "(white|whiter|pale|paler|blue|bluish|blueish|grey|gray|greyish|grayish|purple|purplish|dusky|black|dark|mottled|blotchy|cold|patchy)";

const HUMAN_FAMILIES: UrgentFamily[] = [
  EMERGENCY_WORDS,
  {
    // Swallowing beside breathing: trouble swallowing after a toxin is the
    // spread of its effect that botulinum toxin's boxed warning names.
    // Breathing is read with its misspellings (BREATH) and in plain words
    // ("breathing problems", "can't catch my breath"); never alone, so
    // "do you do breathing or relaxation massage?" is not urgent.
    label: "breathing, the throat or the chest",
    en: new RegExp(
      [
        `\\b(${CANNOT}) (really |properly |hardly |barely |even )?${BREATH}\\b`,
        `\\b(isn'?t|is not|not|stopped|has stopped|quit|stops) ${BREATHING}\\b(?! easy| easily)`,
        `\\b${BREATHING} (is |feels |seems |has been |got |getting )?(really |very |so |a bit )?(problems?|difficult\\w*|issues?|trouble|hard|heavy|shallow|labou?red|tight|restricted|wheezy|raspy|weird|funny|strange)\\b`,
        `\\b(problems?|issues?|trouble|difficulty|difficulties) (with |when |while )?${BREATHING}\\b`,
        "\\bchok(e|es|ed|ing)\\b|\\bwheez\\w*|\\bgasping\\b|\\bcan'?t catch (my |her |his )?breath\\b|\\bshort(ness)? of breath\\b|\\bbreathless\\b",
        "\\b(throat|tongue) (is |feels |keeps |getting )?(closing|clos\\w*|tight\\w*|swell\\w*|swollen|swolen|thick|huge)\\b",
        "\\bchest (pains?|pian|tightness|pressure|ache|aches|aching)\\b|\\bchest (hurts|is hurting|feels (tight|heavy|crushed))\\b|\\bpain in (my|the|his|her) chest\\b",
        "\\b(heart attack|palpitations?|heart (is )?racing|racing heart)\\b",
        "\\b(can'?t|cannot|can not|couldn'?t|cnt|hard to|trouble|difficulty|struggling to|unable to|hurts? to|painful to) swallow(ing)?\\b|\\b(trouble|difficulty|problems?|pain) (with |when |on )?swallowing\\b|\\bdysphagia\\b",
      ].join("|"),
      "i",
    ),
    es: es(
      "no (puedo|puede|podía) respirar|no respira|dej[óo] de respirar|(dificultad|problemas?) para respirar|me cuesta respirar|me falta (el )?aire|falta de aire|(me|se) (est[áa] )?(ahogando|atragantando)|me ahogo|se atragant\\p{L}*|se me (est[áa] )?cerr(a|ando) la garganta|garganta (cerrada|hinchada|apretada)|dolor (en el|de) pecho|me duele (mucho |much[íi]simo )?el pecho|presi[óo]n en el pecho|ataque al coraz[óo]n|infarto|no (puedo|puede) tragar|(dificultad|problemas?|dolor) (para|al) tragar|me duele (al )?tragar",
    ),
    other: es(
      "(ne )?(peux|peut|arrive) (pas|plus) (à |a )?respirer|du mal (à|a) respirer|difficult[ée]s? (à|a) respirer|j'?[ée]touffe|[ée]touff\\p{L}*|douleurs? (dans la|à la|a la|de la) poitrine|douleur thoracique|mal (à|a) la poitrine|(kann|könnte|kriege|bekomme) (nicht|keine|kaum) (mehr )?(atmen|luft)|atemnot|atembeschwerden|schwer (zu )?atmen|ersticke\\p{L}*|brustschmerz\\p{L}*|schmerzen in der brust|non (riesco a|posso) respirare|non respiro|difficolt[àa] (a|nel) respirare|dolore al petto|n[ãa]o (consigo|posso) respirar|falta de ar|dificuldade (para|em|de) respirar|dor no peito",
    ),
  },
  {
    // "Reacton", "alergic": a dropped letter must not defeat the family.
    label: "an allergic reaction",
    en: /\b(al+er?gi?c|alergic) (re?a?ct(ion|ino|on|oin|in)|rxn|attack|response|shock)\b|\b(allergic reaction|anaphyla\w*|anafala\w*|anaphalax\w*|hives|allergy attack)\b|\b(used|use|using|need|needed|grab|grabbed|had to use) (my |an |the |her |his )?epi-?pen\b/i,
    es: es("reacci[óo]n al[ée]rgica|anafila\\p{L}*|urticaria|ronchas"),
    other: es(
      "r[ée]action allergique|choc anaphylactique|anaphyla\\p{L}*|urticaire|allergische reaktion|nesselsucht|reazione allergica|orticaria|rea[çc][ãa]o al[ée]rgica",
    ),
  },
  {
    // Any swelling, in any spelling: a pre-treatment question about swelling
    // gets the fixed line too, which is where it belongs (the header).
    label: "swelling",
    en: /\b(swell(ing|s|ed|in)|swell up|swollen|swolen|swollan|sweling|sweeling)\b|\b(face|lips?|tongue|throat|eyelids?|cheeks?) (is |are |looks? |feels? |got |went |getting |keeps getting )(so |really |very |all )?(puffy|puffed up|huge|enlarged|ballooning|blown up)\b/i,
    es: es("hinchad[oa]s?|hinchaz[óo]n|se (me )?(est[áa] )?hinch(a|ando|ó|o)|inflamad[oa]s?|inflamaci[óo]n"),
    other: es("gonfl[ée]\\p{L}*|enfl[ée]\\p{L}*|geschwollen\\p{L}*|schwellung|schwillt|gonfi[oae]\\p{L}*|gonfiore|inchad[oa]s?|incha[çc][ãa]o|inchando|inchou"),
  },
  {
    label: "bleeding",
    en: /\b(bleed(ing|s|in)?|bled|bleding|bleading|bleedin|ha?emorrhag\w*)\b|\bblood (everywhere|won'?t stop|wont stop|keeps (coming|pouring)|pouring|gushing|all over)\b/i,
    es: es("sangrando|sangra|sangr[óo]|sangrado|hemorragia|no (para|deja) de sangrar|mucha sangre"),
    other: es("saign\\p{L}*|h[ée]morragie|blut(e|et|en|ung)\\p{L}*|sanguin(a|ando|amento)|emorragia|sangramento|hemorragia"),
  },
  {
    // "Infection" only as something someone has: "is there a risk of
    // infection?" is a question for the clinical screen.
    label: "an infection or a burn",
    en: /\b(pus|oozing|abscess(es)?|f(e|ee|ea)v[ea]r(ish)?|infected|sepsis|blister(s|ed|ing)?|burns|burned|burnt)\b|\bburning (sensation|pain|feeling)\b|\b(got|have|has|having|developed|developing|signs of|looks like|think (i|it|she|he) (has|have|got)) (an |a )?infection\b|\b(hot|warm) to (the )?touch\b|\bred streaks?\b/i,
    es: es("pus|supura\\p{L}*|absceso|fiebre|infectad[oa]|ampollas?|quemad[oa]|quemaduras?|me quem[ée]"),
    other: es("fi[èe]vre|fieber|eiter|febbre|febre|infect[ée]e?|infiziert|infett[oa]|infeccionad[oa]"),
  },
  {
    // What a vascular occlusion after filler looks like, and sight: the skin
    // over it gone white, blue or mottled, in plain words ("my lip went
    // white"), and vision blurred, dimmed or lost. Not "a dusky pink lip
    // blush" or hair going grey: the colour must follow a part of the skin
    // and a verb.
    label: "a change in the skin or in sight",
    en: new RegExp(
      [
        "\\b(blanch\\w*|mottl\\w*|necro\\w*|turn(ed|ing|s)? (white|blue|purple|black)|(lost|losing|loss of|blurr(y|ed)|double) (my |his |her )?(vision|sight)|vision loss)\\b",
        `\\b${SKIN_SUBJECT}\\b(?:\\s+[\\w']+){0,3}?\\s+(${SKIN_STATE} )*${SKIN_CHANGE} ${SKIN_ADVERB}${SKIN_COLOUR}\\b${SKIN_NOT_A_FEATURE}`,
        `\\b${SKIN_SUBJECT}\\b(?:\\s+[\\w']+){0,3}?\\s+(${SKIN_STATE} )+${SKIN_ADVERB}${SKIN_VASCULAR}\\b${SKIN_NOT_A_FEATURE}`,
        `\\b${SKIN_SUBJECT}\\b(?:\\s+[\\w']+){0,3}?\\s+(${SKIN_STATE} )+${SKIN_ADVERB}${SKIN_TONE}\\b${SKIN_NOT_A_FEATURE}${SKIN_AFTER_TREATMENT}`,
        "\\b(white|blue|bluish|purple|purplish|grey|gray|dusky) (patch|spot|area|mark|blotch)(es|s)? (appeared |showed up |came up |came out )?(after|since|where|around the (filler|injection))\\b",
        "\\bdiscolou?r(ed|ation) (after|since|where|around)\\b|\\b(lacy|net-?like) (pattern|rash|marks?|discolou?ration)\\b",
        "\\b(vision|eyesight|sight)\\b(?: (in|on|of) (my|the|one|her|his) (left |right )?eye)?\\s+((is|went|has gone|gone|going|getting|became|turned|seems|feels|looks) )*(really |very |a bit |kind of |kinda |all |so )?(blur\\w*|dim\\w*|dark|black|grey|gray|fuzzy|cloudy|hazy|weird|funny|strange|wrong|worse|double|spotty|patchy)\\b",
        "\\b(blur+e?y|blurr?ed|fuzzy|cloudy|hazy|dim|double|patchy|spotty) (vision|sight|eyesight)\\b|\\bvision (problems?|changes?|issues?|disturbances?) (after|since|from)\\b|\\b(having|have|had|got|getting|noticed|noticing) (some |a )?vision (problems?|changes?|issues?|disturbances?)\\b",
        "\\b(seeing|see|saw) (double|spots|flashes|stars|black spots|floaters)\\b|\\b(went|going|gone) blind\\b|\\bblind(ness)? in (my|one|the|her|his)\\b",
        "\\b(can'?t|cannot|cnt|cant) see (properly|clearly|anything|out of|well|straight|right)\\b",
        "\\beye (pain|is (really |so )?(hurting|painful)|hurts)\\b|\\b(my|her|his) eyes? (hurts?|is hurting|are hurting)\\b",
      ].join("|"),
      "i",
    ),
    es: es(
      "(se (me )?(est[áa] )?(poniendo|puso|ha puesto)|est[áa]) (blanc[oa]|azul|morad[oa]|negr[oa])|necros\\p{L}*|visi[óo]n borrosa|(perd[íi]|perdiendo|p[ée]rdida de) (la )?(visi[óo]n|vista)|no (puedo|veo) ver( bien)?|veo doble",
    ),
    other: es(
      "vision (floue|trouble)|je (ne )?vois (plus rien|plus|rien|flou|double)|(devenu|devenue|est) (toute? )?(blanc|blanche|bleu|bleue|violet|violette)|verschwommen\\p{L}*|sehe (nichts|nicht mehr|doppelt|schlecht)|(wei[ßs]|blau|lila) geworden|vista (offuscata|annebbiata)|non vedo (niente|nulla|bene)|vedo (doppio|sfocato)|(diventat[oa]|diventa) (bianc[oa]|blu|viola)|vis[ãa]o (emba[çc]ada|turva)|n[ãa]o (consigo ver|enxergo)|(ficou|est[áa] ficando) (branc[oa]|azul|rox[oa])",
    ),
  },
  {
    label: "severe pain",
    en: /\b(severe|sever|sevre|extreme|excruciating|unbearable|unbareable|intense|terrible|horrible|awful|worst|agoni[sz]ing|really bad|very bad|crazy|insane) (pain|pains|pian|headache|cramps?|cramping)\b|\bin (a lot of|alot of|so much|lots of|terrible|severe|extreme) pain\b|\bin agony\b|\bpain (is |keeps )?(getting )?(worse|unbearable)\b|\b(it|this|that|my \w+|the \w+) (really |still )?(hurts|is hurting) (so |really |soo+ )?(bad|badly|a lot|alot|so much)\b/i,
    es: es("dolor (muy )?(fuerte|intenso|insoportable|terrible|horrible)|mucho dolor|me duele (much[íi]simo|mucho)"),
    other: es(
      "douleur (atroce|insupportable|intense|tr[èe]s forte)|starke schmerzen|unertr[äa]gliche schmerzen|dolore (forte|insopportabile|atroce)|dor (forte|insuport[áa]vel|intensa)",
    ),
  },
  {
    label: "consciousness or the nerves",
    en: /\b(faint(ed|ing)?|f(ia|ei|a)nt(ed|ing)|feel(ing)? (so |really |very )?faint|about to faint|(going to|gonna) (faint|pass out)|pass(ed|ing) out|pased out|past out|black(ed)? out|unconscious|(lost|loss of|losing) consciousness|unresponsive|collaps(e|ed|ing)|seizures?|convuls\w*|(having|had|a) stroke|slurr(ed|ing)|numbness|can'?t feel (my|his|her|the|anything)|paraly[sz]\w*|dizz(y|iness)|light-?headed|vomit(ing|ed)?|throwing up)\b|\bwon'?t wake( up)?\b|\b(can'?t|cannot) wake (him|her|them|my \w+) up\b|\bnot waking up\b|\b(arm|face|leg|side|lips?|hand|tongue) (is |are |feels |went |has gone |going |keeps going )?numb\b/i,
    es: es(
      "desmay\\p{L}*|perd[íi] el conocimiento|inconsciente|no responde|no (despierta|reacciona)|no (puedo|logro|consigo) despertar(lo|la)?|convulsi\\p{L}*|derrame cerebral|mare(o|ada|ado|ando)s?|entumecid[oa]|no siento (el|la|los|las|mi|mis|nada)|paralizad[oa]|par[áa]lisis|vomit\\p{L}*|v[óo]mitos?",
    ),
    other: es(
      "[ée]vanoui\\p{L}*|perdu connaissance|ohnm[äa]cht\\p{L}*|bewusstlos|svenut[oa]|svenimento|desmai\\p{L}*|perdi a consci[êe]ncia",
    ),
  },
  {
    label: "a wound or an injury",
    en: /\b(wound|incision|stitch(es)?|sutures?) (has |have |is |are )?(opened|open|opening|split|burst|came out|come out|coming out|leak\w*|ooz\w*|bleed\w*)\b|\b(knocked[- ]out|broke(n)?|cracked|chipped) (a |my |his |her |their )?(front )?(tooth|teeth|jaw)\b|\b(tooth|teeth) (got )?(knocked out|broke|broken|cracked)\b/i,
    es: es(
      "(la herida|la incisi[óo]n|los puntos|las suturas) (se )?(abri[óo]|abrieron|est[áa] abierta|soltaron|sangra)|se me (rompi[óo]|cay[óo]|parti[óo]) (un|el|la) (diente|muela)|diente (roto|partido)",
    ),
  },
  CRISIS,
  {
    // Someone with a reaction or a complication, in any tense ("I have a
    // reaction", "she has a complication", "I've had", "I get"); one called
    // bad with no verb at all ("bad reaction to the filler"); a body reacting
    // to something. Complications asked about in general ("are there any
    // complications?") are the clinical screen's, which hands off without 911.
    label: "a reaction or a complication",
    // Misspelt too ("reacton", "sever reaction", "complicaton").
    en: /\b(have|has|having|had|get|gets|getting|got|develop(s|ed|ing)?) (an? |some )?((really|very) )?(bad |severe |sever |serious |allergic |alergic |strange |weird |nasty |terrible |awful |horrible )?(re?a?ct(ion|ino|on|oin)|complicat(ion|on)|complecation)s?\b|\b(bad|severe|sever|serious|strange|weird|nasty|terrible|awful|horrible) (re?a?ct(ion|ino|on|oin)|complicat(ion|on)|complecation)s?\b|\breact(ed|ing) (badly|terribly|really badly|to (the|my|it|this|that))\b/i,
    es: es(
      "(tengo|tiene|tuve|tuvo|estoy teniendo|me dio|le dio) una (mala |fuerte |grave |seria )?(reacci[óo]n|complicaci[óo]n)|(mala|fuerte|grave) reacci[óo]n",
    ),
    other: es("(mauvaise|grave) r[ée]action|complication grave|(schlimme|starke|schwere) reaktion|komplikation|(brutta|grave) reazione|complicazione|(rea[çc][ãa]o|complica[çc][ãa]o) (grave|forte|ruim)"),
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
 * cob"); or something unknown eaten ("ate something and is now shaking").
 * Only the forms that report it happening: "can dogs eat grapes?" is a
 * question for the desk, and "loves eating bones" is not one bone
 * swallowed.
 */
const ATE_TOXIN =
  "(ate|eaten|eats|eating|swallowed|swallowing|ingested|chewed|licked|drank|drunk|got into|gotten into)";
const TOXIN =
  "(chocolate|cocoa|grapes?|raisins?|sultanas?|currants?|xylitol|(chewing )?gum|onions?|garlic|lil(y|ies)|pills?|tablets?|medications?|medicines?|meds|ibuprofen|advil|motrin|aleve|naproxen|tylenol|paracetamol|acetaminophen|aspirin|anti-?freeze|(rat|mouse) (poison|bait)|poison|bleach|detergent|(laundry |dishwasher )?pods?|weed|marijuana|cannabis|edibles?|mushrooms?|macadamias?|avocados?|coffee|caffeine|cigarettes?|nicotine|vapes?|alcohol|insecticide|pesticide|fertili[sz]er|slug (pellets|bait)|snail bait|something (toxic|poisonous))";
const ATE_OBJECT = "(ate|eaten|swallowed|swallowing|ingested)";
const OBJECT =
  "(batter(y|ies)|socks?|string|thread|ribbon|tinsel|hair ties?|toy|ball|bone|(chicken|cooked) bones|corn ?cobs?|fish(ing)? ?hooks?|needles?|coins?|magnets?|part of (a|the|his|her|its|their|my))";

const POISONING: UrgentFamily = {
  label: "a poisoning or something swallowed",
  en: new RegExp(
    `\\b(poison(ed|ing|ous)?|(?<!\\bnon[\\s-]?)toxic|toxins?|toxicity|anti-?freeze|rat bait|rodenticide|overdos\\w*)\\b` +
      `|\\b${ATE_TOXIN}\\b(?:[\\s,]+[\\w'-]+){0,5}?[\\s,]+${TOXIN}\\b` +
      `|\\b${ATE_OBJECT}\\b(?:\\s+[\\w'-]+){0,4}?\\s+${OBJECT}\\b` +
      `|\\b(ate|eaten|swallowed|got into|licked|drank) something\\b` +
      // "My dog took my pills": an animal does not take medicine as a person does.
      `|\\b(took|has taken|got hold of|got into) (my|our|the|some|all (of )?(my|the|our)|a bunch of|a bottle of|[2-9]|\\d{2,3}) (\\w+ )?(${PILLS})\\b`,
    "i",
  ),
  es: es(
    "envenen\\p{L}*|intoxica\\p{L}*|veneno|anticongelante|raticida|t[óo]xic[oa]|sobredosis|(se )?tom[óo] (mis|las|unas|todas las|sus|[2-9]|\\d{2,3}) (pastillas|p[íi]ldoras|medicinas|medicamentos|tabletas)|(comi[óo]|se comi[óo]|trag[óo]|se trag[óo]|lami[óo]|bebi[óo]|ingiri[óo])( [\\p{L}]+){0,4}? (chocolate|uvas?|pasas|xilitol|chicle|cebollas?|ajo|lirios?|pastillas|p[íi]ldoras|medicamentos?|medicinas?|ibuprofeno|paracetamol|aspirina|anticongelante|veneno|raticida|marihuana|calcetines|calcet[íi]n|juguete|hueso|pila|bater[íi]a|algo)",
  ),
};

/** The veterinary families, after the crisis and the person (personEmergency). In this order. */
const VETERINARY_FAMILIES: UrgentFamily[] = [
  {
    // The emergency words, and an animal taken to hospital ("should I take
    // him to the animal hospital?"). Not a hospital's name: "is Oakwood
    // Animal Hospital open?" asks about hours.
    ...EMERGENCY_WORDS,
  },
  POISONING,
  {
    label: "bloat",
    en: /\b(bloat(ed|ing)?|gdv|twisted (stomach|gut)|stomach (has )?twist\w*|(belly|stomach|abdomen|tummy) (is |looks |feels |seems |has gone |got )?(swollen|distended|hard|tight|bloated|huge|enlarged)|(swollen|distended|hard|bloated) (belly|stomach|abdomen|tummy)|retching|dry[- ]?heav\w*|trying to (vomit|throw up|be sick)|unproductive (vomiting|retching))\b/i,
    es: es(
      "(barriga|est[óo]mago|abdomen|panza|panzita) (muy )?(hinchad[oa]|inflamad[oa]|dur[oa]|distendid[oa])|torsi[óo]n (g[áa]strica|de est[óo]mago)|arcadas|intenta vomitar",
    ),
  },
  {
    // Not "not breathing easy about the cost".
    label: "breathing",
    en: /\b(can'?t|cannot|can not|couldn'?t|hard to|trouble|difficulty|struggling to|unable to|not|isn'?t|stopped) breath(e|ing)\b(?! easy| easily)|\b(can'?t|cannot) (get|make) (my|the|our|his|her|this) [\w-]+ (to )?breathe\b|\bbreathing (hard|heavily|fast|funny|strange(ly)?|weird(ly)?|badly|noisily)\b|\bshort(ness)? of breath\b|\b(gasping|wheezing|choking|choked)\b|\bpanting (heavily|hard|a lot|non-?stop|constantly)\b|\b(blue|white|grey|gray|pale|purple) (gums|tongue)\b|\b(gums|tongue) (is |are |looks? |have gone |has gone |turned )?(blue|white|grey|gray|pale|purple)\b/i,
    es: es(
      "no (puede|puedo) respirar|(le cuesta|dificultad para) respirar|no respira|se (est[áa] )?ahogando|enc[íi]as (azules|blancas|p[áa]lidas|moradas)",
    ),
  },
  {
    label: "a collapse or a seizure",
    en: /\b(collaps(e|ed|es|ing)|unconscious|unresponsive|passed out|fainted|fainting|seizures?|seizing|convuls\w*|(having|had|has|having another) (a )?fits?|(is|was|keeps|started) fitting|paraly[sz]\w*|dying|(isn'?t|is not|not|stopped|won'?t|can'?t) (moving|move)|won'?t (wake|wake up)|(can'?t|cannot) wake (him|her|it|them|(my|the|our|this) [\w-]+) up|(can'?t|cannot) (get|make) (my|the|our|his|her|this) [\w-]+ (to )?(wake( up)?|respond|move)|can'?t (stand|stand up|get up|walk|move (his|her|its|their) (back |hind )?legs)|(won'?t|will not|unable to) (stand|get up|walk)|dragging (his|her|its|their) (back |hind )?legs|(back|hind) legs (have )?(gone|given out|stopped working|collapsed)|(shaking|trembling|twitching) (uncontrollably|all over|badly)|tremors)\b/i,
    es: es(
      "(se )?desplom\\p{L}*|colaps\\p{L}*|convulsi\\p{L}*|inconsciente|no se mueve|no (despierta|reacciona)|no (puedo|logro|consigo) despertar(lo|la)?|no se puede (levantar|parar|mover)|arrastra las patas|paralizad[oa]|par[áa]lisis|se (est[áa] )?muriendo|temblando (mucho|sin parar)",
    ),
  },
  {
    label: "bleeding",
    en: /\b(bleed(ing|s)?|bled|ha?emorrhag\w*)\b|\bblood (in|from) (his|her|its|their|the) (urine|pee|wee|stool|poo|poop|vomit|mouth|nose|ears?|eyes?|bottom)\b|\b(bloody|blood in) (urine|pee|wee|stool|poo|poop|vomit|diarrh\w*|nose)\b|\b(vomiting|throwing up|coughing( up)?|peeing|pooping) blood\b/i,
    es: es("sangrando|sangra mucho|sangrado|hemorragia|sangre en (la orina|las heces|el v[óo]mito|la popo)|vomitando sangre"),
  },
  {
    label: "an accident or an injury",
    en: /\b(hit by a (car|truck|vehicle|bike|bus|van)|(was |got |been )?run over|struck by a (car|vehicle)|(car|road) accident|fell (off|from|out of) (a |the )?(balcony|window|roof|deck|stairs|bed|table|car)|(attacked|mauled|savaged) by|bitten by (a |an |another |the |two |some )?[\w-]+|dog ?fight|snake ?bite|broken (leg|bone|tail|jaw|paw|hip|pelvis)|(leg|bone|tail|jaw|paw|hip) (is |looks )?broken|(deep|open|big|bad|gaping) (wound|cut|gash)|impaled|electrocuted|(chewed|bit) (through )?(an |the |a )?(electric(al)? |power )?(cord|wire|cable)|scalded|burned|burnt)\b/i,
    es: es(
      "atropell\\p{L}*|(lo|la|le) (mordi[óo]|atac[óo]) (otro|un|una)|atacad[oa] por|pata rota|(se )?cay[óo] (del|de la|desde el|desde la) (balc[óo]n|ventana|techo|terraza)|herida (profunda|abierta|grande)",
    ),
  },
  {
    // A male cat that cannot pass urine dies of it within days.
    label: "not passing urine",
    en: /\b(can'?t|cannot|unable to|isn'?t able to|not able to|trying to|straining to|struggling to|keeps trying to) (pee|urinate|wee|pass urine)\b|\b(not|hasn'?t|has not|hasn'?t been|isn'?t) (peeing|urinating|weeing|peed|urinated)\b|\bno (urine|pee)\b|\b(urinary|urethral|bladder) (blockage|obstruction)\b|\b(blocked|obstructed) (bladder|urethra|cat|tom)\b|\bstraining (in|to use) the (litter ?box|litter ?tray|tray)\b/i,
    es: es(
      "no (puede|logra) (orinar|hacer pis|hacer pip[íi])|no (ha )?orinado|no orina|intenta orinar|(bloqueo|obstrucci[óo]n) urinari[ao]",
    ),
  },
  {
    label: "heatstroke",
    en: /\b(heat ?stroke|heat exhaustion|over-?heat(ed|ing)|(left|locked|stuck) in (a|the) (hot )?car)\b/i,
    es: es("golpe de calor|insolaci[óo]n|sobrecalentad[oa]|(dejad[oa]|encerrad[oa]) en el (auto|carro|coche)"),
  },
  {
    label: "an eye injury",
    en: /\b(eye injur\w*|injur(ed|y to) (his|her|its|their|the) eye|eye (is |has )?(popped|popping|bulging|out of (its|the) socket|hanging out|bleeding|punctured|swollen shut)|proptos\w*|scratch(ed)? (on )?(his|her|its|their|the) eye|something (stuck )?in (his|her|its|their) eye)\b/i,
    es: es("(el )?ojo (se le sali[óo]|salido|sangra|herido|lastimado)|lesi[óo]n en el ojo"),
  },
  {
    label: "a difficult birth",
    en: /\b(dystocia|(puppy|puppies|kitten|kittens|foal) (is |are |seems |looks )?stuck|(trouble|difficulty|problems?|struggling|straining|pushing) (with |to |for )?(give birth|giving birth|whelp\w*|deliver\w*|birthing|queening|labou?r)|(been )?in labou?r for|labou?r (is |has )?(not progressing|stalled|stopped)|retained (placenta|puppy|kitten))\b/i,
    es: es("parto dif[íi]cil|(cachorro|gatito) atorado|lleva (horas )?(en trabajo de parto|pariendo)|no puede parir"),
  },
  {
    label: "an allergic reaction",
    en: /\b(allergic reaction|anaphyla\w*|hives|(face|muzzle|snout|lips?|throat|tongue|neck|head) (is |are |has |looks |started )?(swell\w*|swollen|puffy|puffed up)|swollen (face|muzzle|snout|lips?|throat|tongue|neck|head)|stung by|(bee|wasp|hornet|scorpion) sting|(spider|insect) bite)\b/i,
    es: es("reacci[óo]n al[ée]rgica|(cara|hocico|garganta|lengua) hinchad[oa]|picadura de (abeja|avispa|alacr[áa]n)"),
  },
  {
    label: "vomiting that will not stop",
    en: /\b((can'?t|won'?t) stop|keeps|keep|constantly|non-?stop) (vomiting|throwing up|being sick|having diarrh\w*)\b|\b(vomiting|throwing up|being sick) (all|for) (day|night|hours|\d+ hours)\b|\b(vomited|threw up|been sick) (\d+|several|many|multiple|five|six|lots of) times\b/i,
    es: es("no (para|deja) de vomitar|vomitando (todo el d[íi]a|toda la noche|sin parar)"),
  },
  {
    label: "severe pain",
    en: /\b(screaming|crying|yelping|howling|whimpering|shaking) (in|with|from) pain\b|\bin (a lot of|so much|severe|terrible|extreme|agonising|agonizing) pain\b|\b(severe|extreme|excruciating|terrible) pain\b/i,
    es: es("(llorando|chillando|aullando|gritando) de dolor|mucho dolor"),
  },
];

// -----------------------------------------------------------------------------
// A person, or an animal, at a veterinary practice
// -----------------------------------------------------------------------------

/**
 * A person named by their relation to the one writing: "my husband", "mi
 * hijo". Not the owner of an animal: "my daughter's dog", "our kids' puppy",
 * "el perro de mi hija" name the animal, whose emergency it is.
 */
const RELATION_EN =
  /\b(my|our) (son|daughter|husband|wife|child|children|kid|kids|baby|toddler|mother|mom|mum|father|dad|partner|boyfriend|girlfriend|fianc[eé]e?|brother|sister|grandmother|grandma|grandfather|grandpa|friend|neighbou?r|roommate|coworker|colleague)\b(?!['’])/i;
const RELATION_ES = es(
  "(?<!(perr[oa]s?|perrit[oa]s?|gat[oa]s?|gatit[oa]s?|cachorr[oa]s?|mascotas?|conejos?|caballos?|loro|p[áa]jaro) de )mi (hij[oa]|espos[oa]|marido|mujer|beb[ée]|ni[ñn][oa]|madre|mam[áa]|padre|pap[áa]|novi[oa]|herman[oa]|abuel[oa]|amig[oa]|vecin[oa]|pareja)",
);

/** Someone who is plainly a person: "someone collapsed", "a man", "the receptionist fainted". */
const HUMAN_NOUN_EN =
  /\b(someone|somebody|a (man|woman|person|guy|lady|child|kid|baby|toddler|customer|client|stranger|worker)|an (employee|old (man|lady)|elderly (man|woman|person))|the (receptionist|front desk|vet tech|tech|technician|groomer|driver|mailman|delivery (man|guy|driver))|one of (your|the) (staff|employees|techs))\b/i;
const HUMAN_NOUN_ES = es("alguien|una (persona|señora|mujer|niña)|un (señor|hombre|niño|beb[ée]|cliente)|la recepcionista");

/**
 * The person speaking, about an emergency in their own body: "I can't
 * breathe", "I got bitten", "I'm having a heart attack", "my chest hurts",
 * "my arm is numb". Not the words of someone upset about their animal: "my
 * heart is pounding", "I can't stop shaking", "I'm in so much pain watching
 * this".
 */
const FIRST_PERSON_EN = new RegExp(
  [
    "\\bI (can'?t|cannot|can not) (breathe|swallow|feel my (face|lips?|arm|legs?|hands?)|stop (bleeding|throwing up|vomiting))\\b",
    "\\bI('m| am) (bleeding|choking|passing out|fainting|going to (pass out|faint)|not breathing|having (a |an )?(heart attack|stroke|seizure|allergic reaction|reaction|panic attack|asthma attack|chest pains?|trouble breathing|difficulty breathing|contractions))\\b",
    "\\bI (just )?(swallowed|overdosed|fainted|collapsed|passed out)\\b",
    "\\bI took (too many|an overdose|a (whole )?(bottle|handful|bunch) of|all (of )?my|([5-9]|[1-9]\\d{1,2}))\\b",
    "\\bI (was|got|just got|have been|'ve been|just been) (bitten|stung|attacked|stabbed|shot|burned|hit)\\b",
    "\\bmy (chest|heart) (hurts|is hurting|pains?|feels (tight|heavy))\\b",
    "\\bmy (arm|face|lips?|tongue|throat|mouth|leg|hand|eye|eyes) (is |are |feels |went |has gone |keeps )?(numb|swelling|swollen|closing|tight|bleeding|burning)\\b",
  ].join("|"),
  "i",
);
const FIRST_PERSON_ES = es(
  "no puedo (respirar|tragar)|me (estoy )?(ahogando|desmayando)|estoy sangrando|me desmay[ée]|tengo (una reacci[óo]n|dolor (en el|de) pecho)|me duele (mucho |much[íi]simo )?el pecho|me (tom[ée]|tragu[ée]) (demasiadas|muchas|todas|un frasco|[5-9]|[1-9]\\d{1,2})|me (mordi[óo]|pic[óo]|atac[óo])|no siento (los|las|el|la|mis|mi) (labios|cara|brazo|brazos|piernas?|manos?)",
);

/** Someone asking for 911 or an ambulance: a person, unless the message is about an animal. */
const EMERGENCY_SERVICE = /(?<![\d-])\b911\b(?![\d-])|\b(ambulance|ambulancia|paramedics?|param[eé]dicos?)\b/i;

/**
 * Someone, unnamed, whose life is at risk: "he's not breathing", "she won't
 * wake up". At a veterinary practice with no animal named it may be a
 * person, so 911 leads; the veterinary reply carries the emergency vet too.
 */
const PRONOUN_LIFE =
  /\b(he|she|they)('s| is| has| was| are|'re| have|'ve)? (just )?(not breathing|stopped breathing|isn'?t breathing|unconscious|unresponsive|not responding|passed out|won'?t wake( up)?|not waking up)\b/i;

/** An animal named: the species and the commonest breeds, in both languages. */
const ANIMAL_EN =
  /\b(dogs?|doggy|doggie|doggo|pup|pups|puppy|puppies|cats?|kitty|kitten|kittens|pets?|rabbits?|bunny|bunnies|hamsters?|guinea pigs?|ferrets?|birds?|parrots?|budgies?|horses?|pony|ponies|tortoises?|turtles?|lizards?|chinchillas?|lab|labrador|retriever|terrier|poodle|beagle|bulldog|chihuahua|husky|shepherd|spaniel|collie|pug|dachshund|boxer|corgi|doodle|pit ?bull|tabby|tom ?cat|pooch)\b/i;
const ANIMAL_ES = es("perr[oa]s?|perrit[oa]s?|gat[oa]s?|gatit[oa]s?|cachorr[oa]s?|mascotas?|conejos?|h[áa]mster|caballos?|loro|p[áa]jaro");
/** What only an animal is poisoned by at home: a named pet with one of these is the animal ("Max ate antifreeze"). */
const ANIMAL_TOXIN =
  /\b(anti-?freeze|chocolate|xylitol|rat poison|rat bait|grapes?|raisins?|lil(y|ies)|anticongelante|xilitol|raticida|uvas|pasas|lirios?)\b/i;
/** The person speaking or someone plainly a person, for an overdose with no animal named. */
const PERSON_WORD = /\b(i|i'm|i've|me|he|she|they|someone|somebody)\b/i;

/**
 * Whether an urgent message at a veterinary practice is a person's own
 * emergency, and so led by 911. Either way the reply at a veterinary
 * practice carries both 911 and the emergency vet (./urgent-replies.ts), so
 * this decides only which leads.
 *
 * A person's: a crisis; a person named by relation, not as an animal's
 * owner ("my husband collapsed", never "my daughter's dog"); someone plainly
 * a person ("someone collapsed in the waiting room", "the receptionist
 * fainted"); the person speaking about an emergency in their own body ("I
 * got bitten", "my chest hurts"). These hold even when an animal is named.
 *
 * Otherwise an animal named, or a poison only an animal meets at home,
 * makes it the animal's. With neither: too many pills taken by "I", "he",
 * "she" or someone is a person's, by a name ("Bella swallowed a bottle of
 * pills") the animal's; 911 or an ambulance asked for is a person's; and
 * someone unnamed not breathing or not waking ("he stopped breathing") is
 * led by 911. Anything else at a veterinary practice is the animal's.
 */
function personEmergency(text: string): boolean {
  if (SELF_HARM_EN.test(text) || SELF_HARM_ES.test(text)) return true;
  if (RELATION_EN.test(text) || RELATION_ES.test(text)) return true;
  if (HUMAN_NOUN_EN.test(text) || HUMAN_NOUN_ES.test(text)) return true;
  if (FIRST_PERSON_EN.test(text) || FIRST_PERSON_ES.test(text)) return true;
  if (ANIMAL_EN.test(text) || ANIMAL_ES.test(text) || ANIMAL_TOXIN.test(text)) return false;
  if (OVERDOSE_EN.test(text) || OVERDOSE_ES.test(text)) return PERSON_WORD.test(text);
  return EMERGENCY_SERVICE.test(text) || PRONOUN_LIFE.test(text);
}

// -----------------------------------------------------------------------------
// What is read past
// -----------------------------------------------------------------------------

/** A question about the practice's emergency service, not a report of one. */
const SERVICE_PHRASES: RegExp[] = [
  /\b(emergency|urgent)\s+(appointments?|visits?|hours|slots?|services?|cases?|exams?|consult\w*|fees?|line|number|availability)\b/gi,
  // "Do you see emergencies on weekends?", "Do you handle emergencies?"
  /\b(do|does|can|could|will|would)( you| y'?all| they| the (clinic|practice|vet|hospital|office))? (see|take|handle|treat|accept|do|cover|offer) (any |after-?hours )?(emergenc(y|ies)|urgent (cases|care|visits)|walk-?ins)\b/gi,
  // "Are you an emergency vet?", "Is this a 24/7 hospital?". Never "is this an emergency?".
  /\b(are) (you|y'?all) (an? )?(emergency|urgent care|24[/ ]?7|after-?hours)( (vet|veterinarian|clinic|hospital|practice|center|centre|service))?\b/gi,
  /\b(is) (this|it|the (clinic|practice|hospital|office)) (an? )?(emergency|urgent care|24[/ ]?7|after-?hours) (vet|veterinarian|clinic|hospital|practice|center|centre|service)\b/gi,
  /\b(is it|how) urgent (is it )?to (get|book|have|do|schedule|bring|vaccinate|see)\b/gi,
  new RegExp(
    "(?<![\\p{L}\\p{N}])(?:(citas?|consultas?|horarios?|servicios?|atenci[óo]n|n[úu]mero) de (urgencias?|emergencias?)|(es|qu[ée] tan) urgente (vacunar|poner|llevar|traer|hacer|sacar))(?![\\p{L}\\p{N}])",
    "giu",
  ),
];

/** A cue that the person needs help now, which keeps even a service question urgent. */
const DISTRESS =
  /\b(help|hurry|asap|right now|immediately|(it'?s|it is|this is|we have|we'?ve got|I have|there'?s) an? (emergency|urgent))\b|(?<![\p{L}])(ayuda|r[áa]pido|ahora mismo|es una emergencia|es urgente)(?![\p{L}])/iu;

function isQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || /^[¿]/.test(t) || /^(do|does|can|could|will|would|are|is|what|when|how|which|where|hi|hello|hey|hola)\b/i.test(t);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The message as the families read it: curly apostrophes made straight (how
 * a phone keyboard writes "can't"), the practice's own name read past, and a
 * question about its emergency service read past when nothing in the
 * message says someone needs help now.
 */
/**
 * The practice's name as a client shortens it: the whole name, a run of two
 * or more of its words from its first ("Oakwood Emergency" for "Oakwood
 * Emergency Animal Hospital"), and any run of three or more ("Urgent Pet
 * Care" for "24/7 Urgent Pet Care"). Not two words from the middle, which
 * are the words of an emergency as often as of a name ("take him to the
 * animal hospital").
 */
function nameRuns(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const runs: string[] = [name];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 2; end <= words.length; end += 1) {
      if (start === 0 || end - start >= 3) runs.push(words.slice(start, end).join(" "));
    }
  }
  return [...new Set(runs)].sort((a, b) => b.length - a.length);
}

/**
 * A name of the practice's kind the client gives in a question about hours
 * or a visit ("is Oakwood Emergency Animal Hospital open Sunday?"): a run of
 * capitalised words carrying an emergency word.
 */
const PLACE_NAME =
  /\b(?:[A-Z0-9][\w'&/.-]*\s+){0,4}(?:Emergency|Urgent|ER|24\/7)(?:\s+[A-Z][\w'&.-]*){0,4}(?=\s+(?:open|opens|closed|hours|located|on|in|at|near|today|tonight|tomorrow|now|this)\b|\s*\?)/g;
const VISIT_QUESTION = /\b(open|opens|closed|close|hours|located|location|address|phone|number|website|parking|book|appointment)\b/i;

/**
 * The message as the families read it: curly apostrophes made straight (how
 * a phone keyboard writes "can't"), the practice's own name read past, and a
 * question about its emergency service, or about a place's hours, read past
 * when nothing in the message says someone needs help now.
 */
function prepare(text: string, options: UrgentOptions): string {
  let plain = text.replace(/[‘’ʼ]/g, "'");
  const name = options.clinicName?.trim();
  if (name && name.length >= 3) {
    for (const run of nameRuns(name)) plain = plain.replace(new RegExp(escapeRegExp(run), "gi"), " ");
  }
  if (isQuestion(plain) && !DISTRESS.test(plain)) {
    for (const phrase of SERVICE_PHRASES) plain = plain.replace(phrase, " ");
    if (VISIT_QUESTION.test(plain)) plain = plain.replace(PLACE_NAME, " ");
  }
  return plain;
}

/**
 * The first family that matches, and the language its reply is written in:
 * Spanish when the Spanish words matched, or when the message leans Spanish
 * ("Quiero suicidarme" matches the English root), English otherwise.
 */
function firstFamily(
  families: readonly UrgentFamily[],
  text: string,
): { label: string; language: UrgentLanguage; otherLanguage?: true } | null {
  for (const family of families) {
    if (family.en.test(text)) return { label: family.label, language: leansSpanish(text) ? "es" : "en" };
    if (family.es?.test(text)) return { label: family.label, language: "es" };
  }
  // Only once no family matched in English or Spanish: a fragment in another language.
  for (const family of families) {
    if (family.other?.test(text)) return { label: family.label, language: "en", otherLanguage: true };
  }
  return null;
}

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
  human: HUMAN_FAMILIES.length,
  veterinary: VETERINARY_FAMILIES.length,
};

/**
 * Whether a message reports a complication or an urgent symptom, screened
 * with the practice's own set (urgentSetFor), in English and in Spanish.
 * Null means it does not, and the message may go on to the clinical screen
 * and the model. Called without a specialty it screens with the set for
 * people.
 *
 * At a veterinary practice a person's own emergency (personEmergency) is
 * screened with the set for people as well, and gets 911; an animal's gets
 * the emergency vet.
 */
export function findUrgentContent(
  text: string | null | undefined,
  specialty?: string | null,
  options: UrgentOptions = {},
): UrgentFinding | null {
  if (!text) return null;
  const plain = prepare(text, options);
  if (urgentSetFor(specialty) === "veterinary") {
    if (personEmergency(plain)) {
      const found = firstFamily(HUMAN_FAMILIES, plain) ?? firstFamily(VETERINARY_FAMILIES, plain);
      return found ? { ...found, emergency: "911" } : null;
    }
    const found = firstFamily(VETERINARY_FAMILIES, plain);
    return found ? { ...found, emergency: "veterinary" } : null;
  }
  const found = firstFamily(HUMAN_FAMILIES, plain);
  return found ? { ...found, emergency: "911" } : null;
}
