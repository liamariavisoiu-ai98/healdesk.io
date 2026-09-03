import { detectBooking } from "./booking.ts";
import type { CrawlResult } from "./crawl.ts";
import type { Clinic } from "./dedupe.ts";
import type { Label } from "./label.ts";
import {
  LAUNCH_AVOID,
  LAUNCH_PRIORITY,
  SEGMENT_LABELS,
  type Segment,
} from "./segments.ts";

/**
 * The tally, and the honesty checks that stop it being misread.
 *
 * A bare count per segment is the thing that started this: the biggest bucket
 * looks like the answer, and it usually is not. So the report deliberately
 * shows the count NEXT TO the things that decide whether the count means
 * anything — how much of it is low-confidence, how much is chains, how much is
 * phone-dependent, and whether the ranking survives dropping the weak rows.
 */

export type SegmentStats = {
  segment: Segment;
  clinics: number;
  /** Clinics with at least one contact we could actually email. */
  contactable: number;
  highConfidence: number;
  /**
   * Clinics with no self-serve online booking.
   *
   * No longer a proxy — read from the clinic's own links. This is the closest
   * thing in the data to a direct measure of the product's value, because a
   * clinic whose patients cannot book online has no route to an appointment
   * except the phone.
   */
  phoneDependent: number;
  /** On a platform healdesk connects to — can be offered verified attribution. */
  onSupportedPlatform: number;
  chains: number;
  mentionsWeightLoss: number;
  /** Distinct states, as a spread check — a segment in one metro is an artefact. */
  states: number;
};

export type EnrichmentReport = {
  inputRows: number;
  clinics: number;
  crawled: number;
  crawlFailed: number;
  labelled: number;
  segments: SegmentStats[];
  /** Ranking with low-confidence rows dropped. If it differs, say so loudly. */
  highConfidenceOrder: Segment[];
  warnings: string[];
};

/** Deliverable volume floor for a campaign that can be read at all. */
const FLOOR = 600;

export function buildReport(
  clinics: Clinic[],
  labels: Label[],
  inputRows: number,
  crawlFailed: number,
  crawls: CrawlResult[] = [],
): EnrichmentReport {
  const byId = new Map(clinics.map((c) => [c.id, c]));
  // Keyed only on crawls that actually produced links.
  //
  // A crawl returning zero links is an absence of evidence, and detectBooking
  // faithfully reports hasOnlineBooking:false for it — which downstream then
  // read as "this clinic has no online booking". That is the strongest claim in
  // the dataset being derived from a failed fetch. Excluding them lets the
  // model's own guess serve as the fallback it was always described as.
  const booking = new Map(
    crawls
      .filter((c) => (c.links?.length ?? 0) > 0)
      .map((c) => [c.clinicId, detectBooking(c.links!)]),
  );
  const bySegment = new Map<Segment, Label[]>();

  for (const label of labels) {
    const bucket = bySegment.get(label.segment) ?? [];
    bucket.push(label);
    bySegment.set(label.segment, bucket);
  }

  const segments: SegmentStats[] = [...bySegment.entries()]
    .map(([segment, group]) => {
      const states = new Set<string>();
      let contactable = 0;
      let phoneDependent = 0;
      let onSupportedPlatform = 0;

      for (const label of group) {
        const clinic = byId.get(label.clinicId);
        if (clinic) {
          if (clinic.state) states.add(clinic.state.toLowerCase());
          if (clinic.contacts.some((c) => c.email)) contactable += 1;
        }

        // A detected link beats the model's guess every time: one is evidence
        // from the clinic's own site, the other is inference from page copy.
        // The guess is consulted only where the crawl found no links at all.
        const detected = booking.get(label.clinicId);
        if (detected) {
          if (!detected.hasOnlineBooking) phoneDependent += 1;
          if (detected.supported) onSupportedPlatform += 1;
        } else if (!label.offersOnlineBooking) {
          phoneDependent += 1;
        }
      }

      return {
        segment,
        clinics: group.length,
        contactable,
        highConfidence: group.filter((l) => l.confidence === "high").length,
        phoneDependent,
        onSupportedPlatform,
        chains: group.filter((l) => l.isChainOrFranchise).length,
        mentionsWeightLoss: group.filter((l) => l.mentionsWeightLoss).length,
        states: states.size,
      };
    })
    .sort((a, b) => b.clinics - a.clinics);

  const targetable = segments.filter(
    (s) =>
      s.segment !== "not-a-target" &&
      s.segment !== "other-medical" &&
      s.segment !== "unknown",
  );

  const highConfidenceOrder = [...targetable]
    .sort((a, b) => b.highConfidence - a.highConfidence)
    .map((s) => s.segment);

  const warnings: string[] = [];

  // Unreadable sites are recoverable work, not a conclusion. Saying so keeps
  // them from being quietly written off as rejected prospects.
  const unknown = segments.find((s) => s.segment === "unknown");
  if (unknown && unknown.clinics > 0) {
    warnings.push(
      `${unknown.clinics} clinics could not be read at all — that is "we do not ` +
        `know", not "not a target". Re-crawl them before treating the segment ` +
        `shares as complete; a timeout says nothing about the business.`,
    );
  }

  // The check that matters most: does the ranking survive its own evidence?
  const naiveOrder = targetable.map((s) => s.segment);
  if (naiveOrder[0] && highConfidenceOrder[0] !== naiveOrder[0]) {
    warnings.push(
      `The largest segment (${naiveOrder[0]}) is NOT the largest once ` +
        `low-confidence labels are dropped (${highConfidenceOrder[0]}). The raw ` +
        `count is being carried by clinics we could barely read — rank on the ` +
        `high-confidence column, not the total.`,
    );
  }

  for (const stat of targetable) {
    if (stat.clinics >= FLOOR && stat.contactable < FLOOR) {
      warnings.push(
        `${stat.segment} has ${stat.clinics} clinics but only ${stat.contactable} ` +
          `with a usable email — it clears the volume floor on paper and not in ` +
          `practice.`,
      );
    }
    if (stat.clinics >= 100 && stat.chains / stat.clinics > 0.25) {
      warnings.push(
        `${Math.round((100 * stat.chains) / stat.clinics)}% of ${stat.segment} ` +
          `looks chain- or franchise-owned. Those rows collapse to a handful of ` +
          `central buyers, so the count overstates the number of deciders.`,
      );
    }
    if (stat.clinics >= 100 && stat.states < 8) {
      warnings.push(
        `${stat.segment} spans only ${stat.states} states — that concentration ` +
          `is more likely an artefact of how the list was built than a real ` +
          `market shape.`,
      );
    }
    if (stat.clinics >= 100 && stat.phoneDependent / stat.clinics < 0.4) {
      warnings.push(
        `Only ${Math.round((100 * stat.phoneDependent) / stat.clinics)}% of ` +
          `${stat.segment} lacks self-serve online booking. A voice agent is ` +
          `worth least where booking has already moved off the phone.`,
      );
    }
  }

  return {
    inputRows,
    clinics: clinics.length,
    crawled: labels.length,
    crawlFailed,
    labelled: labels.filter((l) => l.confidence !== "low").length,
    segments,
    highConfidenceOrder,
    warnings,
  };
}

export function formatReport(report: EnrichmentReport): string {
  const lines: string[] = [];

  lines.push("healdesk — lead enrichment");
  lines.push("=".repeat(78));
  lines.push(`  ${report.inputRows} contact rows  →  ${report.clinics} clinics`);
  lines.push(
    `  crawled ${report.crawled}, ${report.crawlFailed} unreadable, ` +
      `${report.labelled} labelled above low confidence`,
  );
  lines.push("");

  const w = 22;
  lines.push(
    "  " +
      "segment".padEnd(w) +
      "clinics".padStart(8) +
      "emailable".padStart(11) +
      "high-conf".padStart(11) +
      "phone-dep".padStart(11) +
      "chains".padStart(8) +
      "connect".padStart(9) +
      "states".padStart(8),
  );
  lines.push("  " + "-".repeat(85));

  for (const s of report.segments) {
    lines.push(
      "  " +
        (SEGMENT_LABELS[s.segment] ?? s.segment).slice(0, w - 1).padEnd(w) +
        String(s.clinics).padStart(8) +
        String(s.contactable).padStart(11) +
        String(s.highConfidence).padStart(11) +
        String(s.phoneDependent).padStart(11) +
        String(s.chains).padStart(8) +
        String(s.onSupportedPlatform).padStart(9) +
        String(s.states).padStart(8),
    );
  }

  if (report.warnings.length) {
    lines.push("");
    lines.push("  READ THESE BEFORE CHOOSING");
    for (const warning of report.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  lines.push("");
  lines.push("  Launch guidance, from docs/state-of-play.md Part 3:");
  for (const [segment, why] of Object.entries(LAUNCH_PRIORITY)) {
    const stat = report.segments.find((s) => s.segment === segment);
    lines.push(`  ✓ ${SEGMENT_LABELS[segment as Segment]} — ${stat?.clinics ?? 0} clinics`);
    lines.push(`      ${why}`);
  }
  for (const [segment, why] of Object.entries(LAUNCH_AVOID)) {
    if (segment === "not-a-target") continue;
    const stat = report.segments.find((s) => s.segment === segment);
    lines.push(`  ✗ ${SEGMENT_LABELS[segment as Segment]} — ${stat?.clinics ?? 0} clinics`);
    lines.push(`      ${why}`);
  }

  return lines.join("\n");
}
