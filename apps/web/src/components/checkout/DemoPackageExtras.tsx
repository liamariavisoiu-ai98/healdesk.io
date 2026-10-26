import type { Audience } from "@healdesk/catalog";

import type { RoiInputs } from "@/lib/demo/roi";

/**
 * What the purchase knows from the personalised demo a buyer came from, in
 * one object, so the checkout takes a single optional prop and a visitor
 * without a demo sees none of it: the clinic's name and logo, for the
 * header's "Activate {clinic}'s AYA" and the package recommended for it, and
 * the inputs the demo page's estimates start from (lib/demo/roi.ts).
 *
 * Checkout no longer shows those estimates (26 October 2026): what the
 * assistant could book is the demo page's to say (components/demo/
 * ValueTiles.tsx), and checkout only completes the purchase. The demo's setup
 * offer is not here either: it is one of the setup offers the flow takes as
 * `setupOffer` (lib/checkout/review.ts) and shows in SetupOfferBanner.
 */
export type DemoCheckout = {
  clinicName: string;
  /** Who the demo's clinic serves (demoAudience): a vet's new people are clients. */
  audience: Audience;
  /** The clinic's logo, as the demo shows it; null for its initial. */
  logoUrl: string | null;
  roi: {
    priceUsd: number;
    priceSource: string;
    bookingRate: number;
    repeat: RoiInputs["repeat"];
  };
};
