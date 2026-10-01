import { ENTERPRISE_SUITES } from "./booking-detection.ts";
import type { AdSignal } from "./signals/ads.ts";
import type { HiringSignal } from "./signals/hiring.ts";
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
  signals: { ads?: AdSignal; hiring?: HiringSignal } = {},
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
  };

  // Signal 3 — paid traffic. The strongest single indicator, because a clinic
  // buying ads has already decided a new patient is worth money; the only
  // question left is whether they catch the ones who phone instead of clicking.
  const ads = signals.ads;
  if (ads?.hasConversionTracking) {
    add(
      25,
      `running conversion-tracked ads (${ads.platforms.join(", ")}) — paying for calls they may not answer`,
    );
  } else if (ads?.platforms.length) {
    add(10, `${ads.platforms.join(", ")} tracking present — likely advertising`);
  }
  if (ads?.funnelTools.length) {
    add(10, `paid funnel on ${ads.funnelTools.join(", ")}`);
  }

  // Trigger — actively hiring a front desk. Time-sensitive: a filled role is
  // worse than no signal, because leading with it says we haven't looked recently.
  const hiring = signals.hiring;
  if (hiring?.postings.length && !hiring.isStale) {
    add(
      20,
      `hiring a front desk right now (${hiring.postings[0]!.title}) — budget approved, decision live`,
    );
  } else if (hiring?.postings.length && hiring.isStale) {
    add(0, "front-desk posting found but likely filled — do not lead with it");
  }

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
  } else if (detection.provider === "mindbody" || detection.provider === "booker") {
    // Mindbody syncs one way, Mindbody to Google, so a booking the assistant
    // writes into Google does not block the slot there. v1 runs manual
    // booking mode or staff mirroring for these clinics, which is a weaker
    // offer than live booking, so no bonus.
    add(0, `on ${detection.provider} — one-way calendar sync, v1 runs manual booking mode or staff mirroring here`);
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
 * Phase two: how well we could actually MEASURE this clinic's revenue.
 *
 * Attribution, POS read-back and "what we earned them" are phase two
 * (docs/v1-product-spec.md → "Commercial position" → "What v1 can prove, and
 * what it cannot"). v1 writes into Google Calendar, which knows nothing about
 * attendance or money. The code is kept for when read-back ships, but this
 * score must not feed a v1 pitch, email or sales call. It is exported as
 * `phase2_integration_score` and `phase2_integration_notes` for that reason,
 * and every note starts "Phase two:".
 *
 * Deliberately a second, independent score. The outbound score above answers
 * "how easy is this clinic to sell to"; this one answers "if they buy, can we
 * prove what we earned them". They are different questions, and they disagree:
 * Zenoti and Boulevard clinics are the hardest sell (both bundle their own AI)
 * and the cleanest integrations by a distance.
 *
 * Collapsing the two into one number, as this file used to, loses whichever
 * half matters at the moment you look.
 */
export function scoreIntegration(detection: BookingDetection): {
  score: number;
  notes: string[];
} {
  const notes: string[] = [];
  const provider = detection.provider;
  const result = (score: number) => ({ score, notes: notes.map((n) => `Phase two: ${n}`) });

  if (!provider) {
    notes.push(
      "No booking platform detected — revenue would be estimated from their average treatment value unless they connect a card processor.",
    );
    return result(30);
  }

  switch (provider) {
    case "boulevard":
    case "zenoti":
      notes.push(
        `${provider} exposes both check-in and settled sales — verified attribution is fully possible.`,
      );
      return result(95);

    case "patientnow":
      notes.push(
        "PatientNow exposes check-in and orders with line items. Rate limit is 1,000 requests/day, so delta sync is mandatory.",
      );
      return result(85);

    case "gohighlevel":
      notes.push(
        "GoHighLevel only sees payments it processed itself, so revenue must come from the clinic's card processor. Appointments are readable.",
      );
      return result(60);

    case "vagaro":
      notes.push(
        "Vagaro has no transactions read endpoint — revenue is webhook-forward-only, with no history before the connection date.",
      );
      return result(40);

    case "acuity":
      notes.push(
        "Acuity has no concept of arrival, so attendance can only be inferred from payment timing.",
      );
      return result(45);

    case "mindbody":
      notes.push(
        "⚠️ Mindbody's API terms prohibit the product. Serve via a read-only account and their card processor, never the API. See docs/launch-plan.md.",
      );
      return result(35);

    default:
      notes.push(`${provider} is not yet assessed for integration feasibility.`);
      return result(50);
  }
}

/**
 * Signals this pipeline does NOT cover, and where they'd come from.
 * Called out so the score isn't mistaken for a complete picture.
 */
export const UNCOVERED_SIGNALS = [
  "Signal 1 — owner-operator who is also the provider (state license lookups, Instagram, About page)",
  "Signal 2 — domain age (WHOIS) and formation date (Secretary of State)",
  "Trigger — Google review mining for 'no one answered' / 'never called back'",
  "Trigger — GLP-1 launch detection (sitemap diff, Wayback, Meta Ad Library first-seen)",
  "Exclusion — whether the clinic already runs a live AI receptionist",
] as const;
