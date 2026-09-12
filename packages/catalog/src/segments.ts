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
 * ## Segments are not specialties, and the two lists differ on purpose
 *
 * There is a second vocabulary in this package, `SpecialtyId` in
 * specialties.ts, and it is deliberately NOT the same list. Segments are the
 * prospecting vocabulary: fine-grained, because a cold email to a laser clinic
 * must not talk about Botox, and a tally that lumps them together cannot pick
 * a niche. Specialties are the product vocabulary: coarse, because a med spa
 * that leads with laser and one that leads with filler share a caller, a
 * ticket, a front desk and a demo, and the buyer should not have to choose
 * between two descriptions of the same practice. Five segments therefore land
 * on the one `med-spa` specialty, and a segment we prospect but have no
 * product branch for yet (physio, audiology) maps to nothing at all.
 *
 * `SEGMENT_TO_SPECIALTY` below is the bridge, and it is the ONLY bridge: the
 * outreach link is built from it, so a prospect lands on the specialty page
 * that matches what we wrote to them. It runs one way — segment to specialty —
 * because the reverse is one-to-many and has no single answer. Note the
 * asymmetry the other way too: `fertility` is a specialty with no prospecting
 * segment yet, because the source list contained no fertility clinics to
 * classify. Add the segment when there is a list to run it on.
 *
 * ## Why classify at all
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

import type { SpecialtyId } from "./specialties";

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
  "massage-therapy",
  "physical-therapy",
  "acupuncture",
  "vision",
  "hearing",
  "mental-health",
  "veterinary",
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
  "massage-therapy": "Massage therapy and bodywork",
  "physical-therapy": "Physical and occupational therapy",
  acupuncture: "Acupuncture and TCM",
  vision: "Vision — LASIK and optometry",
  hearing: "Hearing and audiology",
  "mental-health": "Mental health and psychiatry",
  veterinary: "Veterinary and pet care",
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
 *
 * `chiropractic` and `massage-therapy` stay separate even though they sell
 * into the same product specialty. The classifier assigns ONE primary label,
 * and a massage-only studio is not a chiropractor: it has no doctor, bills no
 * insurance, and its patient rings for a slot rather than for a diagnosis, so
 * the outreach copy differs even where the landing page does not. A chiro
 * practice that also has a massage table leads with chiropractic and lands
 * there; the massage label is for studios where bodywork IS the business.
 *
 * `veterinary` is here because the product now has a veterinary specialty,
 * and a vet on the source list used to fall into `not-a-target` as "not a
 * clinic for people". The patient being a dog changes the paperwork (see
 * specialties.ts) but not the missed call.
 *
 * `unknown` has no rule because the classifier never picks it — the pipeline
 * assigns it when the crawl returned nothing worth classifying, and a model
 * told it may answer "unknown" reaches for it on every thin page.
 *
 * This is a Record over the enum rather than a prose block so that adding a
 * segment without telling the classifier what it means is a type error, not a
 * bucket that quietly stays empty.
 */
export const SEGMENT_DEFINITIONS: Record<Exclude<Segment, "unknown">, string> = {
  injectables:
    "Neurotoxins (Botox, Dysport, Xeomin, Jeuveau) and dermal fillers are the lead offering. The default for a general med spa whose homepage leads with injectables.",
  "laser-skin":
    "Laser hair removal, IPL, resurfacing, microneedling, chemical peels, facials as the lead offering.",
  "body-contouring":
    "CoolSculpting, Emsculpt, truSculpt, Morpheus8 body, cellulite and fat-reduction devices as the lead offering.",
  "weight-loss-glp1":
    "Medical weight loss, semaglutide/tirzepatide programmes, metabolic health. Choose this whenever a supervised weight-loss PROGRAMME is a headline offering, even alongside aesthetics — it is a distinct intake conversation.",
  "wellness-iv":
    "IV drips, vitamin injections, hormone/TRT, peptides, longevity, functional, naturopathic and regenerative medicine as the lead offering.",
  "hair-restoration": "PRP for hair, transplants, hair-loss programmes.",
  "plastic-surgery":
    "A board-certified plastic or cosmetic SURGEON performing surgical procedures. Surgical practice, not a med spa.",
  dermatology:
    "A medical dermatology practice — skin cancer, acne, eczema, Mohs — even where it also sells cosmetics.",
  dental: "Dentistry or orthodontics of any kind.",
  chiropractic:
    "A chiropractor (DC) is the lead practitioner: adjustments, spinal decompression, sports chiropractic. Choose this even where the practice also offers massage or physio — the doctor is what the patient rings for.",
  "massage-therapy":
    "Massage, bodywork or a massage studio is the business itself — deep tissue, sports, prenatal, lymphatic — with no chiropractor or physician on staff. A massage table inside a chiropractic practice is chiropractic, not this.",
  "physical-therapy":
    "Physical or occupational therapy led by a PT/OT: rehab, post-surgical, sports injury, pelvic floor.",
  acupuncture:
    "Acupuncture, cupping, herbal medicine or traditional Chinese medicine as the lead offering.",
  vision: "LASIK, refractive surgery, ophthalmology or optometry.",
  hearing: "Audiology, hearing aids, hearing tests.",
  "mental-health":
    "Psychiatry, therapy, counselling, TMS, ketamine clinics, addiction medicine.",
  veterinary:
    "A veterinary practice, animal hospital, pet grooming spa or mobile vet — the patient is an animal. Choose this over not-a-target: it is a clinic, just not one for people.",
  "other-medical":
    "A medical practice that is none of the above: OB-GYN, urology, gastroenterology, a specialist clinic that takes appointments by phone.",
  "not-a-target":
    "Not a clinic at all: a product brand, a device manufacturer, a distributor, a training academy, a non-medical salon, a marketing agency, a pharmacy, primary care, a personal trainer, a dead or parked domain.",
};

/**
 * Which product specialty a prospecting segment deep-links to. See the header.
 *
 * `null` means we prospect the segment but have no tuned branch to send it
 * to yet — the outreach link falls back to the generic page rather than to a
 * specialty that would be wrong. `not-a-target` and `unknown` never get a
 * link at all, but they are in the map because the Record type is the check
 * that every segment has been thought about.
 */
export const SEGMENT_TO_SPECIALTY: Record<Segment, SpecialtyId | null> = {
  injectables: "med-spa",
  "laser-skin": "med-spa",
  "body-contouring": "med-spa",
  "wellness-iv": "med-spa",
  dermatology: "med-spa",
  "weight-loss-glp1": "glp1",
  "hair-restoration": "hair-restoration",
  "plastic-surgery": "plastic-surgery",
  dental: "dental",
  chiropractic: "massage-chiro",
  "massage-therapy": "massage-chiro",
  veterinary: "veterinary",
  "physical-therapy": null,
  acupuncture: null,
  vision: null,
  hearing: null,
  "mental-health": null,
  "other-medical": null,
  "not-a-target": null,
  unknown: null,
};

export function specialtyForSegment(segment: Segment): SpecialtyId | null {
  return SEGMENT_TO_SPECIALTY[segment];
}
