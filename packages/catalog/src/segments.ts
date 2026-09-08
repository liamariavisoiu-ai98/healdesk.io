/**
 * The segment enum, and why it is a fixed closed list.
 *
 * Lives in the shared catalog because it is a CONTRACT between two things that
 * must agree: the prospecting pipeline classifies a clinic into one of these,
 * and the marketing site's chat agent branches its knowledge tree on the same
 * string. When a cold email targeted `weight-loss-glp1`, the visitor who clicks
 * through selects the `weight-loss-glp1` branch. One vocabulary, end to end —
 * two enums that drifted would silently send GLP-1 traffic to a generic bot.
 *
 * The source list's own `category` column is 24% populated, and 426 of those
 * 1,171 values are literally "Unresolved (opaque name, needs enrichment)". So
 * roughly 85% of the list has no usable label. Counting that column to choose a
 * launch niche would be choosing on a 15% sample selected by whatever heuristic
 * produced it — which is exactly the "the count measures the scraper" failure.
 *
 * Hence: crawl the site, classify from what the clinic says about itself, and
 * force a SINGLE primary label. Multi-label tags cannot be counted, because a
 * clinic that is simultaneously "botox", "laser" and "weight loss" appears in
 * three buckets and inflates all of them.
 *
 * The list is closed on purpose. An open-ended "what is this clinic?" produces
 * a long tail of near-synonyms that cannot be tallied, and the whole point of
 * this exercise is a tally you can act on.
 */

export const SEGMENTS = [
  "injectables",
  "laser-skin",
  "body-contouring",
  "weight-loss-glp1",
  "wellness-iv",
  "hair-restoration",
  "plastic-surgery",
  "dermatology",
  "dental",
  "chiropractic",
  "physical-therapy",
  "acupuncture",
  "vision",
  "hearing",
  "mental-health",
  "other-medical",
  "not-a-target",
  "unknown",
] as const;

export type Segment = (typeof SEGMENTS)[number];

export const SEGMENT_LABELS: Record<Segment, string> = {
  injectables: "Injectables — neurotoxins and fillers",
  "laser-skin": "Laser and skin resurfacing",
  "body-contouring": "Body contouring",
  "weight-loss-glp1": "Medical weight loss / GLP-1",
  "wellness-iv": "IV therapy, wellness and longevity",
  "hair-restoration": "Hair restoration",
  "plastic-surgery": "Plastic and cosmetic surgery",
  dermatology: "Dermatology",
  dental: "Dental and orthodontics",
  chiropractic: "Chiropractic",
  "physical-therapy": "Physical and occupational therapy",
  acupuncture: "Acupuncture and TCM",
  vision: "Vision — LASIK and optometry",
  hearing: "Hearing and audiology",
  "mental-health": "Mental health and psychiatry",
  "other-medical": "Other medical practice",
  "not-a-target": "Not a target",
  unknown: "Could not read the site",
};

/**
 * What the classifier is told each label means.
 *
 * Written as decision rules rather than descriptions, because the hard cases
 * are all clinics that offer several things. A med spa that does Botox, laser
 * and a bit of CoolSculpting has to land somewhere, and it needs to land in the
 * same place every time or the tally is noise.
 *
 * The tie-break — "what does the homepage lead with" — is deliberate. It is the
 * clinic's own statement of what it sells, it is stable across crawls, and it
 * correlates with where the marketing spend and therefore the inbound call
 * volume goes.
 */
