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

  /** 0-100. Higher = closer to the fast-close signature. */
  score: number;
  scoreReasons: string[];
};
