/**
 * What a cold email may never say about the product.
 *
 * Every phrase here names something v1 does not do or must not claim
 * (docs/v1-product-spec.md → "Copy and pricing changes this scope requires"
 * and "What v1 cannot do"). The spec says these need changing "before the
 * first batch sends, not after the first sale", and a cold email is the
 * first thing a clinic reads about us.
 *
 * The earlier generator offered GLP-1 and laser clinics a way to bring
 * "lapsed patients back", told body-contouring clinics the deposit was
 * secured "before they ring off", and called a laser course "revenue you have
 * already banked". All three went into data/*.csv. This list is what stops a
 * fourth: tests/copy-guard.test.ts runs it over every combination the
 * generator can produce, and cli.ts refuses to write a CSV containing a match.
 *
 * Deliberately blunt, like the clinical-content guard. A false positive costs
 * a rewording; a false negative is a promise in four thousand inboxes.
 */
export const COPY_GUARD: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bwin[- ]?backs?\b/i, label: "win-backs (outbound)" },
  { pattern: /\blapsed\b/i, label: "lapsed patients (reactivation is outbound)" },
  { pattern: /reactivat/i, label: "reactivation (outbound)" },
  { pattern: /\bchecks?[- ]ins?\b|\bchecks? in\b/i, label: "check-ins (outbound)" },
  { pattern: /\bfollow(?:s|ed|ing)?[- ]?ups?\b/i, label: "follow-up (outbound)" },
  { pattern: /\bremind/i, label: "reminders (outbound)" },
  { pattern: /\breview (?:requests?|generation)\b|\baftercare\b/i, label: "aftercare or review requests (outbound)" },
  { pattern: /\bSMS\b/i, label: "SMS (cut from v1)" },
  { pattern: /\btext(?:s|ing|ed)?\b/i, label: "texting (cut from v1)" },
  { pattern: /revenue/i, label: "revenue (v1 claims booked value, never revenue)" },
  { pattern: /HIPAA[- ]compliant/i, label: "unqualified HIPAA compliant" },
  { pattern: /\blive in\b/i, label: "a 'live in N minutes' promise (set-up is per channel)" },
  {
    pattern:
      /deposit[^.]*\b(?:ring off|rings off|hang up|on the (?:phone|call)|over the phone|by phone|on a call)\b|\b(?:ring off|on the (?:phone|call)|over the phone|by phone|on a call)\b[^.]*deposit/i,
    label: "a deposit taken on a call (voice books and flags it for staff)",
  },
];

/** The labels of every phrase in `text` that the guard refuses. */
export function copyViolations(text: string): string[] {
  return COPY_GUARD.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/** The columns of a CSV row that a recipient reads. */
export const SENT_COLUMNS = ["hook", "top_offer", "closing_question", "subject_line", "scenario"] as const;

/**
 * Throw before a CSV is written if any row would send a refused phrase.
 *
 * Refusing the whole file rather than dropping the row is deliberate: a list
 * that silently loses rows looks cleaner than it is, and the fix is in the
 * generator, not the list.
 */
export function assertSendableCopy(file: string, rows: readonly Record<string, string>[]): void {
  const problems: string[] = [];
  for (const row of rows) {
    for (const column of SENT_COLUMNS) {
      const text = row[column] ?? "";
      for (const label of copyViolations(text)) {
        problems.push(`${row.email ?? row.clinic_id ?? "?"} ${column}: ${label}: "${text.slice(0, 80)}"`);
      }
    }
  }
  if (problems.length) {
    throw new Error(
      `Refusing to write ${file}: ${problems.length} sent phrase(s) v1 cannot claim. ` +
        `Fix the generator, not the list.\n  ${problems.slice(0, 10).join("\n  ")}`,
    );
  }
}
