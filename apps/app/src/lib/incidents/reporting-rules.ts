import {
  agreementKindOfVersion,
  DPA_1_1_0_RELEASED,
  DPA_1_2_0_RELEASED,
  DPA_VERSION_PREFIX,
  type AgreementKind,
} from "@healdesk/catalog";

/**
 * What each agreement promises a practice about incidents and
 * subcontractors, by the version it signed: the two clocks the operator's
 * notices run against (WP7). The words are the agreements' (packages/catalog
 * baa.ts and dpa.ts); this file is the version-to-rule map, kept the way
 * DESTRUCTION_RULES is (lib/offboarding/offboarding.ts): every released
 * version has a rule, a test holds the map to the catalog, and a version
 * the map does not know gets the strictest rule.
 *
 * ## Reporting (the "Reporting breaches and security incidents" clause)
 *
 *   - `ten_calendar_days`: BAA 1.7.0 and dpa/1.2.0, "without unreasonable
 *     delay and in no case later than 10 calendar days" after discovery, the
 *     one deadline for all three (owner, 30 October 2026);
 *   - `sixty_calendar_days`: BAA 1.2.2 to 1.6.0, dpa/1.0.0 and dpa/1.1.0, "without unreasonable
 *     delay and in no case later than 60 calendar days" after discovery, one
 *     deadline for a breach, a security incident and an improper use or
 *     disclosure alike (owner, 9 October 2026; the spec's wording);
 *   - `five_days`: 1.2.1 and before, five calendar days after discovery for
 *     a breach, and five business days for the other two.
 *
 * healdesk's own target is stricter than either: 24 hours from discovery
 * for all three, at every practice (lib/incidents/incidents.ts). It is an
 * operating target the agreements do not state, never a promise, and no
 * page, email or agreement may present it as one (owner, 12 October 2026).
 *
 * ## Notice of a new subcontractor (the "Subcontractors" clause)
 *
 *   - `twenty_four_hours`: BAA 1.3.0 to 1.6.0, dpa/1.0.0 and dpa/1.1.0
 *     (subprocessor-notice.ts);
 *   - `fifteen_days`: BAA 1.7.0 and dpa/1.2.0, "at least 15 days' notice by
 *     email" (owner, 30 October 2026); 1.2.1 and 1.2.2, "at least fifteen
 *     days' notice by email"; 1.0.0 to 1.2.0 promised notice "before adding one" with no
 *     period, and get the fifteen days, the strictest any version states.
 */

export type ReportingRule = "ten_calendar_days" | "sixty_calendar_days" | "five_days";
export type SubcontractorNoticeRule = "twenty_four_hours" | "fifteen_days";

/** Where a rule came from: the agreement's version, no agreement at all, or a version the map does not know. */
export type RuleBasis = "agreement" | "no_agreement" | "unknown_version";

export const REPORTING_RULES: Readonly<
  Record<AgreementKind, Readonly<Record<string, ReportingRule>>>
> = {
  baa: {
    // 1.7.0 (owner, 30 October 2026): ten calendar days at most.
    "1.7.0": "ten_calendar_days",
    // 1.6.0, released 29 October 2026 (drizzle/0136): its Reporting clause is 1.5.1's own.
    "1.6.0": "sixty_calendar_days",
    "1.5.1": "sixty_calendar_days",
    "1.5.0": "sixty_calendar_days",
    "1.4.0": "sixty_calendar_days",
    "1.3.0": "sixty_calendar_days",
    "1.2.2": "sixty_calendar_days",
    "1.2.1": "five_days",
    "1.2.0": "five_days",
    "1.1.0-draft": "five_days",
    "1.0.0": "five_days",
    "0.1.0-draft": "five_days",
  },
  dpa: {
    // DPA 1.2.0, the owner's release of 30 October 2026, reconciled 1 November
    // 2026: its Incidents clause reports in no case later than 10 calendar
    // days after discovery, as BAA 1.7.0's (dpa.ts, INCIDENTS_1_2). Listed
    // only while its release stands (DPA_1_2_0_RELEASED), as 1.1.0 is.
    ...(DPA_1_2_0_RELEASED ? { "1.2.0": "ten_calendar_days" as const } : {}),
    // DPA 1.1.0, released by the owner on 30 October 2026: its Incidents
    // clause is 1.0.0's own object. Listed only while the release stands
    // (DPA_1_1_0_RELEASED in dpa.ts), since the map names nothing the catalog
    // does not register.
    ...(DPA_1_1_0_RELEASED ? { "1.1.0": "sixty_calendar_days" as const } : {}),
    "1.0.0": "sixty_calendar_days",
  },
};

export const SUBCONTRACTOR_NOTICE_RULES: Readonly<
  Record<AgreementKind, Readonly<Record<string, SubcontractorNoticeRule>>>
> = {
  baa: {
    // 1.7.0 (owner, 30 October 2026): at least 15 days' notice.
    "1.7.0": "fifteen_days",
    // 1.6.0, released 29 October 2026: its Subcontractors notice paragraph is 1.5.1's.
    "1.6.0": "twenty_four_hours",
    "1.5.1": "twenty_four_hours",
    "1.5.0": "twenty_four_hours",
    "1.4.0": "twenty_four_hours",
    "1.3.0": "twenty_four_hours",
    "1.2.2": "fifteen_days",
    "1.2.1": "fifteen_days",
    "1.2.0": "fifteen_days",
    "1.1.0-draft": "fifteen_days",
    "1.0.0": "fifteen_days",
    "0.1.0-draft": "fifteen_days",
  },
  dpa: {
    // DPA 1.2.0, reconciled 1 November 2026: at least 15 days' notice by email
    // (subprocessorNoticeClauseBody15Days), as BAA 1.7.0; listed only while
    // released, as above.
    ...(DPA_1_2_0_RELEASED ? { "1.2.0": "fifteen_days" as const } : {}),
    // DPA 1.1.0, released 30 October 2026: its Subcontractors clause is
    // 1.0.0's own object; listed only while released, as above.
    ...(DPA_1_1_0_RELEASED ? { "1.1.0": "twenty_four_hours" as const } : {}),
    "1.0.0": "twenty_four_hours",
  },
};

function ruleFor<R>(
  rules: Readonly<Record<AgreementKind, Readonly<Record<string, R>>>>,
  version: string | null,
  strictest: R,
): { rule: R; basis: RuleBasis } {
  if (version === null) return { rule: strictest, basis: "no_agreement" };
  const kind = agreementKindOfVersion(version);
  const bare = kind === "dpa" ? version.slice(DPA_VERSION_PREFIX.length) : version;
  const table = rules[kind];
  const rule = Object.hasOwn(table, bare) ? table[bare] : undefined;
  return rule === undefined
    ? { rule: strictest, basis: "unknown_version" }
    : { rule, basis: "agreement" };
}

/** The reporting rule an agreement version states; the strictest for none, and for one the map does not know. */
export function reportingRuleFor(version: string | null): {
  rule: ReportingRule;
  basis: RuleBasis;
} {
  return ruleFor(REPORTING_RULES, version, "five_days");
}

/** The subcontractor notice an agreement version promises; the longest for none, and for one the map does not know. */
export function subcontractorNoticeRuleFor(version: string | null): {
  rule: SubcontractorNoticeRule;
  basis: RuleBasis;
} {
  return ruleFor(SUBCONTRACTOR_NOTICE_RULES, version, "fifteen_days");
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long before a subcontractor starts a practice on this rule must have been told. */
export function subcontractorNoticeMs(rule: SubcontractorNoticeRule): number {
  return rule === "twenty_four_hours" ? 24 * HOUR_MS : 15 * DAY_MS;
}

/** Business days, skipping Saturday and Sunday in UTC. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

/** The incident classes an agreement's reporting clause covers: (a), (b) and (c). */
export type ReportableClass = "breach" | "security_incident" | "improper_use_or_disclosure";

export function isReportableClass(cls: string): cls is ReportableClass {
  return cls === "breach" || cls === "security_incident" || cls === "improper_use_or_disclosure";
}

/**
 * The deadline the agreement promises for telling the practice, from
 * discovery: 10 calendar days under BAA 1.7.0 and dpa/1.2.0; 60 under BAA
 * 1.2.2 to 1.6.0, dpa/1.0.0 and dpa/1.1.0; under the
 * five-day rule, five calendar days for a breach and five business days for
 * a security incident or an improper use or disclosure. Null for a service
 * complaint, which no agreement clocks.
 */
export function agreementReportDeadline(
  cls: string,
  discoveredAt: Date,
  version: string | null,
): { notifyBy: Date | null; rule: ReportingRule; basis: RuleBasis } {
  const { rule, basis } = reportingRuleFor(version);
  if (!isReportableClass(cls)) return { notifyBy: null, rule, basis };
  if (rule === "ten_calendar_days") {
    return { notifyBy: new Date(discoveredAt.getTime() + 10 * DAY_MS), rule, basis };
  }
  if (rule === "sixty_calendar_days") {
    return { notifyBy: new Date(discoveredAt.getTime() + 60 * DAY_MS), rule, basis };
  }
  return {
    notifyBy:
      cls === "breach"
        ? new Date(discoveredAt.getTime() + 5 * DAY_MS)
        : addBusinessDays(discoveredAt, 5),
    rule,
    basis,
  };
}
