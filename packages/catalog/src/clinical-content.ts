import { isSpecialtyId, regimeFor, type SpecialtyId } from "./specialties";

/**
 * The deterministic guard against clinical text in the agent's configuration.
 *
 * The agent's greeting, service list and prices are spoken on transcribed
 * calls (no call audio is kept) and sent in chat. Today an operator edits them
 * with the clinic on the onboarding call. In v1 they start from a scrape of the
 * clinic's own site, which the clinic corrects in the onboarding wizard and
 * edits in the portal, along with its promotions and quick answers
 * (docs/v1-product-spec.md). A clinic's website is full of candidacy, dosing,
 * recovery and safety copy, and the temptation to paste it in is constant. A
 * model instruction ("do not give medical advice") is not a guardrail against
 * text that is already in the prompt, so this is: a denylist over the words
 * that mark clinical content, applied to each field before it is stored, with
 * the offending phrase named so the text can be rewritten rather than guessed
 * at. apps/app also runs it over each message a person sends on a Meta
 * channel, over Meta replies, over a booking request's name, windows and
 * collected fields, and over the service a caller names on a call. The Meta
 * channels also count the everyday skin and hair conditions
 * (`EVERYDAY_CONDITIONS` below); nothing else does.
 *
 * Never run it over the clinic's never-say list. Those entries are clinical on
 * purpose (the spec pre-seeds them with the clinical defaults), and screening
 * them would refuse the very phrases the list exists to block.
 *
 * It is deliberately blunt. A false positive costs a rewording; a false
 * negative is the agent telling a caller that a treatment is safe while
 * pregnant, which is the one claim the insurance excludes.
 */

type ClinicalPattern = { pattern: RegExp; label: string; allowPriceUnits?: boolean; claim?: true };

/**
 * `claim` marks the three patterns that are promises rather than clinical
 * vocabulary: that a treatment is safe, that its results are guaranteed, that
 * it is proven. They hold for every practice. The rest is the vocabulary of
 * human medicine. See `ClinicalScreen`.
 */
const CLINICAL_PATTERNS: ClinicalPattern[] = [
  { pattern: /\b(safe|safely|safety)\b/i, label: "a safety claim", claim: true },
  { pattern: /\b(side[- ]?effects?|risks?|complications?|contraindicat\w*)\b/i, label: "side effects or risks" },
  { pattern: /\b(pregnan\w*|breastfeed\w*|nursing mothers?)\b/i, label: "pregnancy or breastfeeding" },
  { pattern: /\b(dos(e|age|ing)|units?|mg\b|milligrams?|ml\b)\b/i, label: "dosing", allowPriceUnits: true },
  { pattern: /\b(candidates?|candidacy|eligib\w*|suitable for|ideal for)\b/i, label: "candidacy" },
  { pattern: /\b(diagnos\w*|symptom\w*|triage)\b/i, label: "diagnosis, symptoms or triage" },
  { pattern: /\b(recover\w* (time|period)|downtime|healing|aftercare|post[- ]?op\w*)\b/i, label: "recovery or aftercare" },
  { pattern: /\b(interact\w* with|blood thinners?|medications?|prescri\w*)\b/i, label: "medication or interactions" },
  { pattern: /\b(condition|disease|disorder|infection|allerg\w*)\b/i, label: "a medical condition" },
  { pattern: /\b(results? (are|is) guaranteed|guaranteed results?|permanent(ly)? (removal|results?))\b/i, label: "a results guarantee", claim: true },
  { pattern: /\b(FDA[- ]approved|clinically proven|medically proven)\b/i, label: "an efficacy claim", claim: true },
];

/**
 * The everyday skin and hair conditions, by the names a person gives their
 * own (owner, 7 October 2026: "the clinical-content check should recognise
 * everyday skin conditions such as acne or rosacea"). The patterns above
 * catch the word "condition"; these catch the condition named: "my acne",
 * "acne scars", "breakouts", "a rosacea flare", "my hair is falling out".
 *
 * Conditions, not looks and not treatments: acne and its everyday words,
 * rosacea, eczema and dermatitis, psoriasis, keratosis, folliculitis and a
 * flare-up of any of them; melasma, pigmentation and vitiligo; scars and
 * keloids; hair loss and its everyday words, hirsutism and dandruff; and the
 * few others a med spa is asked about (hyperhidrosis, cold sores and herpes,
 * warts, ingrown hairs, fungal nails). Not the cosmetic concerns a price
 * question is made of (wrinkles, fine lines, sun spots, cellulite, stretch
 * marks, pores, unwanted hair), not the lesions a menu removes (moles, skin
 * tags), and not a symptom (redness, a rash), which is the urgent screen's
 * business or the model's.
 *
 * Only the Meta channels count them (`conditions` in `ClinicalOptions`). Meta
 * signs no BAA, so a message there that names one gets the hand-off line and
 * is kept nowhere, and no reply or booking window there may name one.
 * Everywhere else a clinic's own words are made of them, as a vet's menu is
 * made of the patterns above: a med spa sells an "Acne Facial" and a "Rosacea
 * Laser", names them in its greeting, answers "Do you treat acne?" on its
 * site, and books the facial by its name for a caller on a call the BAA
 * covers. Counted there, they would drop the menu from the scraped profile,
 * lose the service on the call and refuse the greeting.
 *
 * Whole words, so "scared", "Oscar", "scarless", "Stewart" and
 * "micropigmentation" are none of them. "Whiteheads" only in the plural:
 * Whitehead is a surname, and a provider may have it. The three names a
 * message most often misspells are read as well: "rosacia", "excema" or
 * "exzema", and "psorasis".
 */
const A_CONDITION = "a skin or hair condition";
const EVERYDAY_CONDITIONS: ClinicalPattern[] = [
  { pattern: /\b(acne|pimpl(e|es|y)|zits?|blackheads?|whiteheads|break-?outs?|break outs?|(breaks|breaking|broke|broken) out)\b/i, label: A_CONDITION },
  { pattern: /\b(rosac[ei]a|eczema|ex[cz]ema|dermatitis|psoria\w*|psorasis|keratos[ie]s|folliculitis|flare[- ]?ups?|(flares|flared|flaring) up)\b/i, label: A_CONDITION },
  { pattern: /\b(melasma|chloasma|(hyper|hypo)pigment\w*|pigmentations?|vitiligo)\b/i, label: A_CONDITION },
  { pattern: /\b(scar(s|red|ring)?|keloids?|pock[- ]?mark(s|ed)?)\b/i, label: A_CONDITION },
  {
    pattern:
      /\b(hair[- ]?loss|alopecia|bald(ing|ness)?|thinning hair|hair (is |has been )?thinning|hair[- ]?fall|hair (is )?falling out|losing (my |his |her )?hair|receding hair[- ]?line|hirsutism|dandruff)\b/i,
    label: A_CONDITION,
  },
  { pattern: /\b(hyperhidrosis|excessive(ly)? sweat\w*|cold sores?|herpes|warts?|verruca(s|e)?|ingrown|fung(us|al))\b/i, label: A_CONDITION },
];

/**
 * Which patterns a field is screened against: `clinical`, the default, is all
 * of them; `claims` is only the three claims. Neither counts the everyday
 * conditions unless `ClinicalOptions` asks.
 *
 * `claims` exists for one field, a veterinary practice's service names. The
 * vocabulary above is written for human medicine, and a vet's menu is made of
 * it ("Allergy testing", "Senior diagnostics", "Post-op check", "Heartworm
 * medication"), so screening those names in full would refuse the menu
 * itself. Everything else a vet writes, its policies, its answers and its
 * greeting, is still screened in full: advice about an animal's dose or
 * recovery is still advice the assistant must not give.
 */
export type ClinicalScreen = "clinical" | "claims";

/**
 * How a practice's service names are screened, by its specialty's regime:
 * `claims` where HIPAA cannot apply because the patient is an animal, the full
 * screen everywhere else, and the full screen when the specialty is unknown.
 */
export function serviceNameScreen(specialty: SpecialtyId | null | undefined): ClinicalScreen {
  return isSpecialtyId(specialty) && regimeFor(specialty) === "non-hipaa" ? "claims" : "clinical";
}

/**
 * How a menu quotes a price by the unit: "$14 per unit", "$650/ml".
 *
 * The dosing pattern above reads "unit" and "ml" as dosing, which made a
 * per-unit price impossible to store, and the spec wants a menu price quoted
 * exactly. So these phrases are blanked before any pattern marked
 * `allowPriceUnits` runs (only dosing), and for no other. Only the "per" and
 * "/" forms are exempt, because they are unambiguous price notation. "20 units
 * per area" is still caught on "units", and "typical dose" still on "dose".
 * The blanking keeps the length, so the excerpt below still points at the
 * original text.
 */
const PRICE_UNIT = /(?:\bper\s+|\/\s*)(?:units?|ml)\b/gi;

export type ClinicalFinding = { field: string; label: string; excerpt: string };

/**
 * The long form of findClinicalContent's second argument. `screen` is as
 * above. `conditions` counts the everyday skin and hair conditions
 * (`EVERYDAY_CONDITIONS`) as well, whatever the screen. Only the Meta
 * channels turn it on, in apps/app's lib/meta: the inbound screen, the reply
 * guard, and a Meta request's name and windows. Off, the default, they are
 * not read.
 */
export type ClinicalOptions = { screen?: ClinicalScreen; conditions?: boolean };

/**
 * Scan a set of named text fields. Returns every finding; an empty array
 * means the text may be stored. The excerpt is the twenty characters around
 * the match, enough to find it and short enough not to be the clinical copy
 * reproduced in a log. A field gets one finding, for the first pattern it
 * trips, and the everyday conditions come last, so a field they share with a
 * pattern above keeps that pattern's label.
 */
export function findClinicalContent(
  fields: Record<string, string | null | undefined>,
  options: ClinicalScreen | ClinicalOptions = "clinical",
): ClinicalFinding[] {
  const { screen = "clinical", conditions = false }: ClinicalOptions =
    typeof options === "string" ? { screen: options } : options;
  const patterns = [
    ...(screen === "claims" ? CLINICAL_PATTERNS.filter((p) => p.claim) : CLINICAL_PATTERNS),
    ...(conditions ? EVERYDAY_CONDITIONS : []),
  ];
  const findings: ClinicalFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const { pattern, label, allowPriceUnits } of patterns) {
      const text = allowPriceUnits ? value.replace(PRICE_UNIT, (unit) => " ".repeat(unit.length)) : value;
      const match = pattern.exec(text);
      if (match) {
        const start = Math.max(0, match.index - 20);
        findings.push({ field, label, excerpt: value.slice(start, match.index + match[0].length + 20).trim() });
        break;
      }
    }
  }
  return findings;
}
