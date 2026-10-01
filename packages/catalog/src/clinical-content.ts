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
 * at. apps/app also runs it over Meta replies, the fields and consent quote
 * of a booking request, and the service a caller names on a call.
 *
 * Never run it over the clinic's never-say list. Those entries are clinical on
 * purpose (the spec pre-seeds them with the clinical defaults), and screening
 * them would refuse the very phrases the list exists to block.
 *
 * It is deliberately blunt. A false positive costs a rewording; a false
 * negative is the agent telling a caller that a treatment is safe while
 * pregnant, which is the one claim the insurance excludes.
 */

const CLINICAL_PATTERNS: { pattern: RegExp; label: string; allowPriceUnits?: boolean }[] = [
  { pattern: /\b(safe|safely|safety)\b/i, label: "a safety claim" },
  { pattern: /\b(side[- ]?effects?|risks?|complications?|contraindicat\w*)\b/i, label: "side effects or risks" },
  { pattern: /\b(pregnan\w*|breastfeed\w*|nursing mothers?)\b/i, label: "pregnancy or breastfeeding" },
  { pattern: /\b(dos(e|age|ing)|units?|mg\b|milligrams?|ml\b)\b/i, label: "dosing", allowPriceUnits: true },
  { pattern: /\b(candidates?|candidacy|eligib\w*|suitable for|ideal for)\b/i, label: "candidacy" },
  { pattern: /\b(diagnos\w*|symptom\w*|triage)\b/i, label: "diagnosis, symptoms or triage" },
  { pattern: /\b(recover\w* (time|period)|downtime|healing|aftercare|post[- ]?op\w*)\b/i, label: "recovery or aftercare" },
  { pattern: /\b(interact\w* with|blood thinners?|medications?|prescri\w*)\b/i, label: "medication or interactions" },
  { pattern: /\b(condition|disease|disorder|infection|allerg\w*)\b/i, label: "a medical condition" },
  { pattern: /\b(results? (are|is) guaranteed|guaranteed results?|permanent(ly)? (removal|results?))\b/i, label: "a results guarantee" },
  { pattern: /\b(FDA[- ]approved|clinically proven|medically proven)\b/i, label: "an efficacy claim" },
];

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
 * Scan a set of named text fields. Returns every finding; an empty array
 * means the text may be stored. The excerpt is the twenty characters around
 * the match, enough to find it and short enough not to be the clinical copy
 * reproduced in a log.
 */
export function findClinicalContent(fields: Record<string, string | null | undefined>): ClinicalFinding[] {
  const findings: ClinicalFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const { pattern, label, allowPriceUnits } of CLINICAL_PATTERNS) {
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
