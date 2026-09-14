/**
 * The deterministic guard against clinical text in the agent's configuration.
 *
 * The agent's greeting, service list and price ranges are written by us and
 * approved by the clinic, and then said aloud on recorded calls. A clinic's
 * website is full of candidacy, dosing, recovery and safety copy, and the
 * temptation to paste it in is constant. A model instruction ("do not give
 * medical advice") is not a guardrail against text that is already in the
 * prompt, so this is: a denylist over the words that mark clinical content,
 * applied to every field before it is stored, with the offending phrase
 * named so the operator can rewrite rather than guess.
 *
 * It is deliberately blunt. A false positive costs a rewording; a false
 * negative is the agent telling a caller that a treatment is safe while
 * pregnant, which is the one claim the insurance excludes.
 */

const CLINICAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(safe|safely|safety)\b/i, label: "a safety claim" },
  { pattern: /\b(side[- ]?effects?|risks?|complications?|contraindicat\w*)\b/i, label: "side effects or risks" },
  { pattern: /\b(pregnan\w*|breastfeed\w*|nursing mothers?)\b/i, label: "pregnancy or breastfeeding" },
  { pattern: /\b(dos(e|age|ing)|units?|mg\b|milligrams?|ml\b)\b/i, label: "dosing" },
  { pattern: /\b(candidates?|candidacy|eligib\w*|suitable for|ideal for)\b/i, label: "candidacy" },
  { pattern: /\b(diagnos\w*|symptom\w*|triage)\b/i, label: "diagnosis, symptoms or triage" },
  { pattern: /\b(recover\w* (time|period)|downtime|healing|aftercare|post[- ]?op\w*)\b/i, label: "recovery or aftercare" },
  { pattern: /\b(interact\w* with|blood thinners?|medications?|prescri\w*)\b/i, label: "medication or interactions" },
  { pattern: /\b(condition|disease|disorder|infection|allerg\w*)\b/i, label: "a medical condition" },
  { pattern: /\b(results? (are|is) guaranteed|guaranteed results?|permanent(ly)? (removal|results?))\b/i, label: "a results guarantee" },
  { pattern: /\b(FDA[- ]approved|clinically proven|medically proven)\b/i, label: "an efficacy claim" },
];

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
    for (const { pattern, label } of CLINICAL_PATTERNS) {
      const match = pattern.exec(value);
      if (match) {
        const start = Math.max(0, match.index - 20);
        findings.push({ field, label, excerpt: value.slice(start, match.index + match[0].length + 20).trim() });
        break;
      }
    }
  }
  return findings;
}
