import { ENTERPRISE_SUITES } from "./booking-detection.ts";
import type { BookingDetection, MapsPlace } from "./types.ts";

/**
 * Scores a prospect against the fast-close signature from
 * docs/leadgen-playbook.md.
 *
 * Deliberately a score, not a filter. The playbook is explicit that no single
 * signal should gate inclusion — booking platform especially is a scoring
 * attribute, since the real disqualifier is a clinic already running a live AI
 * receptionist, which none of these signals can see.
 */
export function scoreProspect(
  place: MapsPlace,
  detection: BookingDetection,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
  };

  // Signal 0 — no online booking at all. The most primitive front desk, the
  // most leakage, and invisible to any whitelist approach.
  if (!detection.hasOnlineBooking) {
    if (detection.method === "phone_only") {
      add(35, "phone-only front desk");
    } else if (detection.method === "contact_form") {
      add(30, "contact form only — collecting interest they must chase by phone");
    } else {
      add(25, "no self-serve booking path found");
    }
  } else {
    add(5, "already bookable online");
  }

  // No website at all — hottest bucket for a voice agent.
  if (!place.website) {
    add(15, "no website — phone is the entire front desk");
  }

  // Signal 4 — booking stack. Enterprise suites bundle native AI, so they're a
  // harder sell, but not an exclusion.
  if (detection.provider && ENTERPRISE_SUITES.has(detection.provider)) {
    add(-25, `on ${detection.provider} — likely has native AI bundled`);
  } else if (detection.provider) {
    add(10, `on ${detection.provider} — no native AI receptionist`);
  }

  // Signal 2 — review velocity as a proxy for scaling. Absolute count is a weak
  // stand-in for velocity; the real signal needs review timestamps, which the
  // default Maps payload doesn't carry.
  const reviews = place.reviewsCount ?? 0;
  if (reviews >= 40 && reviews <= 400) {
    add(15, `${reviews} reviews — established but not enterprise`);
  } else if (reviews > 400) {
    add(-10, `${reviews} reviews — likely multi-location`);
  } else if (reviews > 0) {
    add(5, `${reviews} reviews — early, may not have budget`);
  }

  // Call volume proxy: a well-rated clinic gets more inbound to leak.
  const rating = place.totalScore ?? 0;
  if (rating >= 4.5) add(10, `${rating.toFixed(1)}★ — strong demand to leak`);

  if (place.phone) add(5, "phone number on file for outreach");

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * Signals this pipeline does NOT cover, and where they'd come from.
 * Called out so the score isn't mistaken for a complete picture.
 */
export const UNCOVERED_SIGNALS = [
  "Signal 1 — owner-operator who is also the provider (state license lookups, Instagram, About page)",
  "Signal 2 — domain age (WHOIS) and formation date (Secretary of State)",
  "Signal 3 — ad spend (Meta Ad Library, Google Ads Transparency Center, pixel detection)",
  "Trigger — front-desk job postings",
  "Trigger — Google review mining for 'no one answered' / 'never called back'",
  "Trigger — GLP-1 launch detection (sitemap diff, Wayback, Meta Ad Library first-seen)",
  "Exclusion — whether the clinic already runs a live AI receptionist",
] as const;
