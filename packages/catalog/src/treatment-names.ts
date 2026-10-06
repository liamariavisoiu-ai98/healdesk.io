/**
 * Treatment and procedure names, the ones no email of ours may print.
 *
 * Email goes through Resend, which signs no business associate agreement, and
 * a treatment beside a clinic's name is the half of PHI an email can leak
 * without anyone noticing: "2 Botox bookings" says what this clinic's patients
 * came for. So every email names the KIND of thing that needs attention and a
 * count, and links into the portal for the rest (Annex X1.2 of
 * docs/design/funnel-onboarding-portal-2026-10-06.md). apps/app's copy lint
 * fails a template that names anything below.
 *
 * The list is the treatment vocabulary this package and the specialty copy
 * already use (segments.ts's definitions, the specialties' pricing context),
 * one entry per name a clinic would put on its menu. Whole-word matching, so
 * each entry is a phrase rather than a fragment: "dental implant" rather than
 * "implant", "chemical peel" rather than "peel", because the lint must not fail
 * an honest sentence about an implant of a different kind. Lower case.
 *
 * It is a floor, not the clinic's menu. The clinic's own service names are
 * checked where they leave for a vendor (assertNoTreatmentName in
 * @healdesk/connectors); this list catches what a template author might type.
 */
export const TREATMENT_NAMES: readonly string[] = [
  // Injectables
  "botox",
  "dysport",
  "xeomin",
  "jeuveau",
  "daxxify",
  "neurotoxin",
  "dermal filler",
  "lip filler",
  "filler",
  "juvederm",
  "restylane",
  "sculptra",
  "kybella",
  // Laser and skin
  "laser hair removal",
  "ipl",
  "photofacial",
  "microneedling",
  "chemical peel",
  "hydrafacial",
  "laser resurfacing",
  "fraxel",
  "morpheus8",
  // Body contouring
  "coolsculpting",
  "emsculpt",
  "trusculpt",
  // Weight loss
  "semaglutide",
  "tirzepatide",
  "ozempic",
  "wegovy",
  "mounjaro",
  "zepbound",
  "glp-1",
  // Wellness
  "iv drip",
  "iv therapy",
  "b12 injection",
  "hormone therapy",
  "trt",
  "testosterone",
  "nad+",
  "peptide therapy",
  // Hair restoration
  "prp",
  "hair transplant",
  "fue",
  "fut",
  // Plastic surgery
  "rhinoplasty",
  "breast augmentation",
  "breast lift",
  "breast implants",
  "tummy tuck",
  "abdominoplasty",
  "facelift",
  "liposuction",
  "bbl",
  "blepharoplasty",
  "mommy makeover",
  // Fertility
  "ivf",
  "egg freezing",
  "iui",
  "embryo transfer",
  // Dental
  "dental implant",
  "all-on-4",
  "invisalign",
  "veneers",
  "root canal",
  "teeth whitening",
  "tooth extraction",
  // Vision
  "lasik",
  // Veterinary
  "spay",
  "neuter",
  // Massage and chiropractic
  "chiropractic adjustment",
  "spinal decompression",
  "deep tissue massage",
];
