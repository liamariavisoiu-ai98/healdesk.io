/** Shapes shared across the pipeline stages. */

/** A place as returned by the Apify Google Maps scraper (fields we use). */
export type MapsPlace = {
  placeId?: string;
  title?: string;
  website?: string | null;
  phone?: string | null;
  categoryName?: string | null;
  totalScore?: number | null;
  reviewsCount?: number | null;
  city?: string | null;
  state?: string | null;
  /** Populated only when the clinic wired into Reserve-with-Google. */
  bookingLinks?: { name?: string; url?: string }[] | null;
  tableReservationLinks?: { name?: string; url?: string }[] | null;
};

export type BookingMethod = "widget" | "phone_only" | "contact_form" | "none";

export type BookingDetection = {
  hasOnlineBooking: boolean;
  method: BookingMethod;
  /** Scheduler vendor if identified, e.g. "mindbody". */
  provider: string | null;
  /** How the call was made — useful when auditing false negatives. */
  source: "reserve_with_google" | "footprint" | "llm" | "no_website";
  matchedSignatures: string[];
};

export type Prospect = {
  placeId: string;
  name: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  reviewsCount: number | null;
  rating: number | null;

  detection: BookingDetection;
  ads: import("./signals/ads").AdSignal;
  hiring: import("./signals/hiring").HiringSignal;

  /**
   * 0-100, how closely this clinic matches the fast-close signature.
   *
   * Deliberately separate from `integrationScore` below. The two answer
   * different questions and were previously one number: a Zenoti clinic is a
   * harder sell AND the easiest integration, and collapsing that into a single
   * figure loses the part that matters at each stage.
   */
  score: number;
  scoreReasons: string[];

  /**
   * Phase two: 0-100, how well we could measure this clinic's revenue once
   * POS read-back ships. Not a v1 signal: it must not steer a v1 pitch, email
   * or sales call (see scoreIntegration in score.ts).
   */
  integrationScore: number;
  integrationNotes: string[];

  /** What to lead the first email with, and the evidence for it. */
  angle: import("./angle").OutreachAngle;
};
