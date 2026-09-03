import type { Segment } from "@healdesk/catalog";

export { SEGMENTS, SEGMENT_LABELS, type Segment } from "@healdesk/catalog";

/**
 * Classification rules and launch guidance.
 *
 * The enum itself lives in @healdesk/catalog — it is shared with the marketing
 * site's chat agent, so a segment the pipeline targets is a branch the bot can
 * actually take. What stays here is the prospecting-side knowledge: how to
 * DECIDE a label from a website, and which segments are worth launching into.
 */

export const SEGMENT_RULES = `
injectables       Neurotoxins (Botox, Dysport, Xeomin, Jeuveau) and dermal
                  fillers are the lead offering. The default for a general med
                  spa whose homepage leads with injectables.
laser-skin        Laser hair removal, IPL, resurfacing, microneedling, chemical
                  peels, facials as the lead offering.
body-contouring   CoolSculpting, Emsculpt, truSculpt, Morpheus8 body, cellulite
                  and fat-reduction devices as the lead offering.
weight-loss-glp1  Medical weight loss, semaglutide/tirzepatide programmes,
                  metabolic health. Choose this whenever a supervised weight-loss
                  PROGRAMME is a headline offering, even alongside aesthetics —
                  it is a distinct intake conversation.
wellness-iv       IV drips, vitamin injections, hormone/TRT, peptides, longevity
                  and functional medicine as the lead offering.
hair-restoration  PRP for hair, transplants, hair-loss programmes.
plastic-surgery   A board-certified plastic or cosmetic SURGEON performing
                  surgical procedures. Surgical practice, not a med spa.
dermatology       A medical dermatology practice — skin cancer, acne, eczema,
                  Mohs — even where it also sells cosmetics.
dental            Dentistry or orthodontics of any kind.
other-medical     A medical practice that is none of the above: primary care,
                  OB-GYN, urology, ophthalmology, physio, chiropractic.
not-a-target      Not a clinic at all: a product brand, a device manufacturer, a
                  distributor, a training academy, a non-medical salon or spa, a
                  marketing agency, a dead or parked domain.
`.trim();

/**
 * Segments worth a tuned agent, and why.
 *
 * Ordered by the criteria that actually drive value for this product — see
 * docs/state-of-play.md, Part 3. Ticket size is deliberately NOT here: at $249
 * a month, break-even is under one recovered appointment for every one of
 * these, so it screens nothing.
 */
export const LAUNCH_PRIORITY: Partial<Record<Segment, string>> = {
  injectables:
    "Only segment with transaction-level evidence of phone dependence (78% of ~20,000 appointments booked by phone, not online). Largest procedure volume, >90% independently owned, one decider. Weakness: high repeat-patient share, so the recovered-call story must target NEW patients specifically.",
  "body-contouring":
    "High consideration, consultation-gated, largely new-patient traffic — so defection on an unanswered call is high. Weakness: several materially different device conversations, so one agent config serves fewer clinics.",
  "weight-loss-glp1":
    "The most homogeneous intake conversation of any segment, and mostly new-to-practice cold traffic. Weakness: compounding enforcement since the FDA shortage delistings makes these clinics the likeliest to churn, and the intake edges toward clinical.",
};

/** Segments to avoid at launch, with the reason stated so it is re-checkable. */
export const LAUNCH_AVOID: Partial<Record<Segment, string>> = {
  "laser-skin":
    "Likely the largest bucket and the worst fit: chain-dominated (Milan 400+, LaserAway ~200, Ideal Image 140+), so many rows collapse to a handful of central buyers who already run call centres. Lowest lifetime value — the course completes and the patient leaves.",
  "not-a-target": "Not a clinic.",
};
