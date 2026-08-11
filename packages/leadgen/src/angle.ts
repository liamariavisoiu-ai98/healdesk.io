import { adLibraryUrl, googleAdsTransparencyUrl, type AdSignal } from "./signals/ads";
import type { HiringSignal } from "./signals/hiring";
import type { BookingDetection, MapsPlace } from "./types";

/**
 * Which pitch to lead with.
 *
 * A scored list is only half the job. Two clinics can score identically and
 * need completely different first sentences — one is burning ad budget on calls
 * that ring out, the other is about to sign a $50k employment contract. Sending
 * both the same email wastes the signal we paid to collect.
 *
 * Every angle here is built from something we can SHOW them. The evidence
 * field is not decoration: an opener that says "I noticed you're running ads
 * for CoolSculpting" lands, and "clinics like yours often struggle with call
 * volume" is the email everyone deletes.
 *
 * Ordered by how specific the proof is. Specificity, not cleverness, is what
 * gets a reply.
 */

export type AngleId =
  | "paid-traffic-leak"
  | "hiring-front-desk"
  | "no-booking-path"
  | "high-demand-no-capture"
  | "generic-leakage";

export type OutreachAngle = {
  id: AngleId;
  /** Higher wins when several apply. */
  priority: number;
  /** One line, the actual opener. */
  headline: string;
  /** What we observed, in a form we could show them. */
  evidence: string[];
  /** Where a human can verify before sending. */
  proofLinks: string[];
};

export type AngleInputs = {
  place: MapsPlace;
  detection: BookingDetection;
  ads: AdSignal;
  hiring: HiringSignal;
};

export function selectAngle(inputs: AngleInputs): OutreachAngle {
  const angles = [
    paidTrafficLeak(inputs),
    hiringFrontDesk(inputs),
    noBookingPath(inputs),
    highDemandNoCapture(inputs),
  ].filter((a): a is OutreachAngle => a !== null);

  angles.sort((a, b) => b.priority - a.priority);
  return angles[0] ?? genericLeakage(inputs);
}

/** Every angle that applies, for a sequence rather than a single email. */
export function allAngles(inputs: AngleInputs): OutreachAngle[] {
  const angles = [
    paidTrafficLeak(inputs),
    hiringFrontDesk(inputs),
    noBookingPath(inputs),
    highDemandNoCapture(inputs),
  ].filter((a): a is OutreachAngle => a !== null);

  return angles.length ? angles.sort((a, b) => b.priority - a.priority) : [genericLeakage(inputs)];
}

/**
 * The strongest angle we have: they are buying traffic and can't catch it.
 *
 * A clinic running conversion-tracked ads has already decided that a new
 * patient is worth paying for — the hard sell is done. The gap is that paid
 * traffic arrives on two channels and they only instrumented one. The website
 * has a pixel, a funnel and a conversion event; the phone has whoever happens
 * to be free. Every ad dollar that produces a call instead of a form fill is
 * spent on an outcome nobody is measuring.
 *
 * Position the agent as the capture layer for traffic they already pay for,
 * not as a receptionist. It reframes the cost from headcount to media
 * efficiency, which is a budget that already exists and is already being spent.
 */
function paidTrafficLeak(inputs: AngleInputs): OutreachAngle | null {
  const { ads, detection, place } = inputs;
  if (ads.platforms.length === 0) return null;

  const evidence: string[] = [];
  const proofLinks: string[] = [];

  if (ads.hasConversionTracking) {
    evidence.push(
      `Conversion tracking installed for ${ads.platforms.join(" and ")} — they are optimising campaigns, not just measuring traffic.`,
    );
  } else {
    evidence.push(
      `${ads.platforms.join(" and ")} tracking present on the site.`,
    );
  }

  if (ads.funnelTools.length) {
    evidence.push(
      `Running landing pages on ${ads.funnelTools.join(", ")} — a paid funnel, not just a website.`,
    );
  }

  if (!detection.hasOnlineBooking) {
    evidence.push(
      "No self-serve booking, so every ad click that wants to book has to phone.",
    );
  }

  if (place.title) proofLinks.push(adLibraryUrl(place.title));
  if (place.website) {
    try {
      proofLinks.push(googleAdsTransparencyUrl(new URL(place.website).hostname));
    } catch {
      // A malformed website field shouldn't cost us the whole angle.
    }
  }

  // Both conditions together is the sharpest version of the pitch, so it
  // outranks either alone.
  const priority = ads.hasConversionTracking && !detection.hasOnlineBooking ? 100 : 80;

  return {
    id: "paid-traffic-leak",
    priority,
    headline: detection.hasOnlineBooking
      ? "You're paying for clicks that arrive by phone, and nobody's measuring that half."
      : "You're buying traffic that has no way to book except calling you.",
    evidence,
    proofLinks,
  };
}

/**
 * They are about to spend $47k–58k on the problem we solve for a fraction.
 *
 * Timed rather than firmographic: budget is approved, a decision is live, and
 * the alternative is concrete and expensive. Only usable while the posting is
 * fresh — leading with a filled role tells them we haven't looked recently.
 */
function hiringFrontDesk(inputs: AngleInputs): OutreachAngle | null {
  const { hiring } = inputs;
  if (hiring.postings.length === 0 || hiring.isStale) return null;

  const newest = hiring.postings[0]!;

  return {
    id: "hiring-front-desk",
    priority: 90,
    headline:
      "You're hiring a front desk — worth seeing what the same money buys in coverage.",
    evidence: [
      `Open role: ${newest.title}${newest.location ? ` (${newest.location})` : ""}.`,
      hiring.mostRecent
        ? `Posted ${hiring.mostRecent.toISOString().slice(0, 10)}.`
        : "Posting date unknown.",
      "A front-desk hire is roughly $47,000–58,000 a year loaded, for 40 hours a week.",
    ],
    proofLinks: newest.url ? [newest.url] : [],
  };
}

/** No self-serve booking at all — the most primitive front desk, most leakage. */
function noBookingPath(inputs: AngleInputs): OutreachAngle | null {
  const { detection, place } = inputs;
  if (detection.hasOnlineBooking) return null;

  const evidence: string[] = [];

  if (!place.website) {
    evidence.push(
      "No website found — the phone is the entire front desk.",
    );
  } else if (detection.method === "contact_form") {
    evidence.push(
      "The site collects enquiries through a form that someone then has to chase by phone.",
    );
  } else {
    evidence.push("No self-serve booking on the site; calling is the only path.");
  }

  if (place.reviewsCount) {
    evidence.push(`${place.reviewsCount} Google reviews — there is demand arriving.`);
  }

  return {
    id: "no-booking-path",
    priority: 60,
    headline: "Every new patient has to get through on the phone.",
    evidence,
    proofLinks: place.website ? [place.website] : [],
  };
}

/** Busy and well-rated, so there is real volume to be missing. */
function highDemandNoCapture(inputs: AngleInputs): OutreachAngle | null {
  const { place } = inputs;
  const reviews = place.reviewsCount ?? 0;
  const rating = place.totalScore ?? 0;
  if (reviews < 40 || rating < 4.5) return null;

  return {
    id: "high-demand-no-capture",
    priority: 40,
    headline: "Demand isn't the constraint — answering it is.",
    evidence: [
      `${rating.toFixed(1)}★ across ${reviews} reviews.`,
      "Volume at that level means missed calls are a daily occurrence, not an edge case.",
    ],
    proofLinks: [],
  };
}

/** Fallback. Deliberately the weakest, and labelled as such. */
function genericLeakage(inputs: AngleInputs): OutreachAngle {
  return {
    id: "generic-leakage",
    priority: 0,
    headline: "What happens to the calls you don't get to?",
    evidence: [
      "No specific signal found for this clinic — treat as a low-confidence lead.",
    ],
    proofLinks: inputs.place.website ? [inputs.place.website] : [],
  };
}
