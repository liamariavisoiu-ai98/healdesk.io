/**
 * The treatment vocabulary no reply on Instagram, Messenger or WhatsApp may
 * use (BAA 1.3.0 clause 16: "The assistant names no treatment and confirms
 * no appointment details there").
 *
 * The clinic's own menu is refused by name already (the front door's guard
 * gets every service it has configured), but a menu says "Neurotoxin" where
 * the person writes "Botox", and a clinic with no menu configured has no
 * names to refuse at all. So the Meta reply guard also refuses, for every
 * clinic, every word below: the neurotoxins and their brands, fillers,
 * lasers, peels, microneedling, hair restoration, GLP-1 and other
 * weight-loss drugs, IV therapy, body contouring, hormones, and the
 * procedures of the other specialties healdesk serves. A reply that names
 * one is not sent; the person gets the fixed hand-off line.
 *
 * Broader than TREATMENT_NAMES (the email copy lint's list), on purpose: an
 * email template is written by us and must not fail an honest sentence, so
 * that list holds phrases ("chemical peel"), while a reply on Meta is written
 * by a model and the cost of a false positive is only the hand-off line, so
 * this one holds the bare words too ("peel", "laser"). Matching is by whole
 * words, with a plural allowed on the last word, so "peel" never matches
 * "appeal" while "lasers" matches "laser".
 * Words that are ordinary in another language are left out ("fue" is
 * Spanish for "was").
 */
export const META_TREATMENT_VOCABULARY: readonly string[] = [
  // Neurotoxins and their brands.
  "botox",
  "baby botox",
  "dysport",
  "xeomin",
  "jeuveau",
  "daxxify",
  "letybo",
  "neurotoxin",
  "neuromodulator",
  "toxin",
  "tox",
  "lip flip",
  "wrinkle relaxer",
  "anti wrinkle injection",
  // Fillers.
  "filler",
  "dermal filler",
  "lip filler",
  "cheek filler",
  "juvederm",
  "restylane",
  "radiesse",
  "sculptra",
  "belotero",
  "kybella",
  "injectable",
  "injection",
  // Lasers and light.
  "laser",
  "laser hair removal",
  "laser resurfacing",
  "ipl",
  "bbl",
  "photofacial",
  "fraxel",
  "picosure",
  "picoway",
  "moxi",
  // Peels and skin.
  "peel",
  "chemical peel",
  "facial",
  "hydrafacial",
  "dermaplaning",
  "microdermabrasion",
  "ultherapy",
  "thermage",
  // Microneedling.
  "microneedling",
  "micro needling",
  "morpheus8",
  "potenza",
  "vivace",
  // Body contouring.
  "coolsculpting",
  "emsculpt",
  "trusculpt",
  "liposuction",
  "lipo",
  "thread lift",
  "pdo thread",
  // Hair restoration.
  "prp",
  "hair restoration",
  "hair transplant",
  "minoxidil",
  "finasteride",
  "scalp micropigmentation",
  // GLP-1 and weight-loss drugs.
  "semaglutide",
  "tirzepatide",
  "liraglutide",
  "ozempic",
  "wegovy",
  "mounjaro",
  "zepbound",
  "saxenda",
  "phentermine",
  "glp 1",
  "glp1",
  "weight loss injection",
  "weight loss shot",
  // IV therapy and wellness.
  "iv therapy",
  "iv drip",
  "iv infusion",
  "vitamin drip",
  "myers cocktail",
  "nad",
  "b12 injection",
  "b12 shot",
  "peptide therapy",
  // Hormones.
  "hormone therapy",
  "hormone replacement",
  "bhrt",
  "trt",
  "testosterone",
  // Plastic surgery.
  "rhinoplasty",
  "breast augmentation",
  "breast lift",
  "breast implant",
  "tummy tuck",
  "abdominoplasty",
  "facelift",
  "blepharoplasty",
  "mommy makeover",
  // Fertility.
  "ivf",
  "iui",
  "egg freezing",
  "embryo transfer",
  // Dental and vision.
  "dental implant",
  "all on 4",
  "invisalign",
  "veneer",
  "root canal",
  "teeth whitening",
  "tooth extraction",
  "lasik",
  // Veterinary.
  "spay",
  "neuter",
  // Massage and chiropractic.
  "chiropractic adjustment",
  "spinal decompression",
  "deep tissue massage",
];

/** Lower case, every run of anything but a letter or a digit one space. */
function wordsOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VOCABULARY_PATTERN = new RegExp(
  `(?:^| )(?:${META_TREATMENT_VOCABULARY.map((entry) => escape(wordsOf(entry)))
    .sort((a, b) => b.length - a.length)
    .join("|")})(?:s|es)?(?= |$)`,
  "u",
);

/**
 * Whether `text` uses a word of META_TREATMENT_VOCABULARY, whole, with a
 * plural allowed. Which word is never returned, so it cannot reach a log or
 * an audit row.
 */
export function namesMetaTreatment(text: string): boolean {
  return VOCABULARY_PATTERN.test(wordsOf(text));
}
