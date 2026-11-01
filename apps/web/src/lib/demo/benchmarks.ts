import type { SpecialtyId } from "@healdesk/catalog";

/**
 * Typical US prices for the treatments a demo prices when the clinic's
 * website listed one without a price (lib/demo/samples.ts, owner,
 * 1 November 2026: the made-up values are a step of the build, established
 * once, stored and audited).
 *
 * Each entry is one kind of treatment: the words a menu's name carries, the
 * price as a menu would print it (in the forms apps/app's `demoPrice` reads:
 * "$712/syringe", "from $180", "$938"), what that price is for, and the
 * published figure it comes from, with the page and the day it was opened.
 * `range` is the published range for the same figure (or the figure alone
 * when the source gives none); the build's fill check (`checkDemoFill`)
 * holds a demo whose stored price for a kind falls outside it.
 *
 * Most figures are CareCredit's (Synchrony's yearly "Average Procedural Cost
 * Study", conducted by ASQ360° Market Research), the only national survey
 * found that publishes per-treatment prices on open pages; one is the
 * American Society of Plastic Surgeons'. Each was read on the page named.
 *
 * `source: null` marks a figure no published source was found and opened
 * for: it is the value the demo used before this table, kept for the owner
 * to confirm or replace. A treatment no entry covers gets no price at all
 * ("Price at consultation", CONSULTATION_PRICE): a guessed figure is worse
 * than an offer to talk it through.
 *
 * Order matters: the first entry whose words match a treatment's name is
 * its kind, so the narrower words come first ("laser hair" before "laser").
 */

export type BenchmarkUnit = "unit" | "syringe" | "vial" | "session" | "treatment" | "injection" | "tooth" | "visit" | "vaccine" | "course";

export type Benchmark = {
  /** Stable id, stored with each filled price. Never reuse one. */
  id: string;
  /** The words a treatment's name carries. */
  match: RegExp;
  /** Only for these kinds of practice; every kind when absent. */
  specialties?: readonly SpecialtyId[];
  /** As the menu prints it. */
  price: string;
  /** What the price is for, as the source states it. */
  unit: BenchmarkUnit;
  /** The published range for the figure, in dollars, low to high. */
  range: readonly [number, number];
  /** The page the figure was read on, or null when none was found (unsourced, for the owner). */
  source: string | null;
  /** The day the source was opened and the figure read, ISO date; null when unsourced. */
  checked: string | null;
  /** What the source says, in brief, for the owner. */
  note: string;
};

/** The day the sourced figures below were read. */
const CHECKED = "2026-11-01";

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: "neurotoxin",
    // Dysport is dosed in different units, so its per-unit price is not this one: it is left to a consultation.
    match: /\b(?:botox|xeomin|jeuveau|daxxify|neuro ?toxins?|neuromodulators?|tox|wrinkle relax)/i,
    price: "$14/unit",
    unit: "unit",
    range: [11, 35],
    source: "https://carecredit.com/well-u/health-wellness/botox-cost-and-botox-financing",
    checked: CHECKED,
    note: "A unit of BOTOX Cosmetic costs an average of $11 to $35 (2026 Synchrony cost study, page of 10 July 2026); $14, the demo's earlier figure, sits inside it.",
  },
  {
    id: "filler",
    match: /\b(?:fillers?|juvederm|juvéderm|restylane|rha|lip (?:flip|augment|enhance|plump))/i,
    price: "$712/syringe",
    unit: "syringe",
    range: [529, 1155],
    source: "https://www.carecredit.com/well-u/health-wellness/dermal-fillers",
    checked: CHECKED,
    note: "National average per syringe of Juvéderm (hyaluronic acid) $712, range $529 to $1,155 (2026 Synchrony cost study, page of 18 September 2026).",
  },
  {
    id: "hydrafacial",
    match: /\bhydra ?facial/i,
    price: "$199",
    unit: "session",
    range: [199, 300],
    source: "https://carecredit.com/well-u/health-wellness/facials-costs-and-financing",
    checked: CHECKED,
    note: "A HydraFacial takes about 60 minutes and costs between $199 and $300 (page of 12 May 2023).",
  },
  {
    id: "microneedling",
    match: /\b(?:micro ?needling|morpheus|rf needling)/i,
    price: "$938",
    unit: "treatment",
    range: [686, 1515],
    source: "https://www.carecredit.com/well-u/health-wellness/microneedling-cost",
    checked: CHECKED,
    note: "National average of a microneedling treatment $938, range $686 to $1,515 (2026 Synchrony cost study, page of 17 July 2026).",
  },
  {
    id: "laser-hair-removal",
    match: /\blaser hair/i,
    price: "from $180",
    unit: "session",
    range: [135, 1526],
    source: "https://www.carecredit.com/well-u/health-wellness/laser-hair-removal-cost",
    checked: CHECKED,
    note: "Per session by area: underarms $180 ($135 to $295) up to back $927 ($695 to $1,526) (Synchrony cost studies 2025-2026, page of 23 October 2026).",
  },
  {
    id: "laser-resurfacing",
    match: /\b(?:resurfacing|co2|fraxel|erbium)/i,
    price: "$1,829",
    unit: "treatment",
    range: [1829, 1829],
    source: "https://www.plasticsurgery.org/cosmetic-procedures/laser-skin-resurfacing/cost",
    checked: CHECKED,
    note: "ASPS: the average cost of skin resurfacing procedures like laser skin resurfacing is $1,829 (no range given).",
  },
  {
    // unsourced, for the owner: no open national figure was found for IPL, BBL or a laser facial.
    id: "laser-light",
    match: /\b(?:laser|ipl|bbl|photo ?facial)/i,
    price: "from $300",
    unit: "session",
    range: [300, 300],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    id: "sclerotherapy",
    match: /\b(?:sclerotherapy|spider veins?|veins?)\b/i,
    price: "$503",
    unit: "injection",
    range: [373, 802],
    source: "https://www.carecredit.com/cosmetic/article/zap-spider-veins",
    checked: CHECKED,
    note: "National average of one sclerotherapy injection $503, range $373 to $802 (Synchrony cost studies 2025-2026, page of 23 October 2026).",
  },
  {
    // unsourced, for the owner: the GLP-1 clinic prices found were aggregator pages, not a survey.
    id: "glp1",
    match: /\b(?:semaglutide|tirzepatide|glp|weight)/i,
    price: "from $299",
    unit: "course",
    range: [299, 299],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    id: "kybella",
    match: /\bkybella/i,
    price: "$640/vial",
    unit: "vial",
    range: [492, 1150],
    source: "https://www.carecredit.com/well-u/health-wellness/kybella-cost",
    checked: CHECKED,
    note: "Average of a single vial of Kybella $640, range $492 to $1,150 (2024 Synchrony cost study, page of 4 April 2025).",
  },
  {
    // unsourced, for the owner: no open national survey figure for PRP was found.
    id: "prp",
    match: /\b(?:prp|prf)\b/i,
    price: "from $500",
    unit: "session",
    range: [500, 500],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    id: "body-contouring",
    match: /\b(?:cool ?sculpt|body contour|fat (?:freez|reduction))/i,
    price: "$1,602",
    unit: "session",
    range: [1213, 2599],
    source: "https://www.carecredit.com/well-u/health-wellness/cool-sculpting-cost-and-coolsculpting-financing",
    checked: CHECKED,
    note: "Average of a single CoolSculpting treatment $1,602, range $1,213 to $2,599 (2026 Synchrony cost study, page of 24 July 2026).",
  },
  {
    id: "chemical-peel",
    match: /\bpeels?\b/i,
    price: "$230",
    unit: "treatment",
    range: [170, 370],
    source: "https://www.carecredit.com/well-u/health-wellness/type-of-chemical-peels/",
    checked: CHECKED,
    note: "Light (superficial) chemical peel average $230, range $170 to $370 (2026 Synchrony cost study, page of 19 June 2026).",
  },
  {
    id: "facial",
    match: /\bfacials?\b/i,
    price: "from $80",
    unit: "session",
    range: [75, 200],
    source: "https://carecredit.com/well-u/health-wellness/facials-costs-and-financing",
    checked: CHECKED,
    note: "A spa facial varies from around $75 to $200, the national average around $80 (page of 12 May 2023, citing Thervo).",
  },
  {
    id: "teeth-whitening",
    match: /\bwhitening/i,
    price: "$583",
    unit: "treatment",
    range: [463, 1011],
    source: "https://carecredit.com/well-u/health-wellness/teeth-whitening-costs",
    checked: CHECKED,
    note: "In-office Zoom! whitening average $583, range $463 to $1,011 (2024 Synchrony cost study, page of 1 November 2024).",
  },
  {
    id: "vet-dental",
    // unsourced, for the owner: no national figure for a pet's dental cleaning was opened.
    match: /\b(?:dental|teeth) cleaning/i,
    specialties: ["veterinary"],
    price: "from $300",
    unit: "treatment",
    range: [300, 300],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    // unsourced, for the owner: the cleaning prices found were on unreliable pages.
    id: "dental-cleaning",
    match: /\b(?:cleaning|hygiene|check-?up)/i,
    specialties: ["dental"],
    price: "$150",
    unit: "visit",
    range: [150, 150],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    id: "clear-aligners",
    match: /\b(?:invisalign|aligners?)\b/i,
    price: "$5,108",
    unit: "course",
    range: [1800, 8100],
    source: "https://carecredit.com/well-u/health-wellness/invisalign-cost-invisalign-financing",
    checked: CHECKED,
    note: "National average of clear aligners without insurance $5,108, varying from $1,800 to $8,100 (2023 Synchrony cost study, page of 28 March 2025).",
  },
  {
    id: "dental-implant",
    match: /\bimplants?\b/i,
    price: "$2,143",
    unit: "tooth",
    range: [1646, 4157],
    source: "https://www.carecredit.com/well-u/health-wellness/single-tooth-implant",
    checked: CHECKED,
    note: "National average of a full-size single tooth implant $2,143, range $1,646 to $4,157 (2024 Synchrony cost study, page of 20 February 2026).",
  },
  {
    id: "veneer",
    match: /\bveneers?\b/i,
    price: "$1,455",
    unit: "tooth",
    range: [1020, 2506],
    source: "https://www.carecredit.com/well-u/health-wellness/faq-what-are-veneers-and-how-long-do-veneers-last/",
    checked: CHECKED,
    note: "Single porcelain veneer national average $1,455, range $1,020 to $2,506 (2026 Synchrony cost study, page of 14 August 2026).",
  },
  {
    // unsourced, for the owner: no crown figure was opened.
    id: "crown",
    match: /\bcrowns?\b/i,
    price: "from $1,200",
    unit: "tooth",
    range: [1200, 1200],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier figure, kept for the owner.",
  },
  {
    id: "hair-transplant",
    match: /\b(?:hair restoration|hair transplant|fue)\b/i,
    price: "$6,344",
    unit: "treatment",
    range: [4417, 10640],
    source: "https://carecredit.com/well-u/health-wellness/hair-transplant-cost",
    checked: CHECKED,
    note: "FUE hair transplant average $6,344, range $4,417 to $10,640 (2026 Synchrony cost study, page of 24 July 2026).",
  },
  {
    id: "massage",
    match: /\bmassage/i,
    price: "$100",
    unit: "session",
    range: [65, 180],
    source: "https://carecredit.com/well-u/health-wellness/massage-therapy-costs-and-financing",
    checked: CHECKED,
    note: "Average massage $100 a session, ranging from $65 to $180 an hour (page of 1 June 2022, citing Thumbtack).",
  },
  {
    id: "chiropractic",
    match: /\b(?:chiro|adjustments?)\b/i,
    price: "$76",
    unit: "visit",
    range: [76, 81],
    source: "https://www.carecredit.com/chiropractic/costs",
    checked: CHECKED,
    note: "Manual spinal adjustment $76, drop table technique $81 (2024 Synchrony cost study; the page carries no date).",
  },
  {
    id: "vet-vaccine",
    match: /\bvaccin/i,
    specialties: ["veterinary"],
    price: "from $27",
    unit: "vaccine",
    range: [27, 96],
    source: "https://carecredit.com/well-u/pet-care/dog-puppy-vaccine-cost",
    checked: CHECKED,
    note: "A dog vaccine from $27 to $96; rabies $35, DHPP $42 (2025 Synchrony cost study, page of 21 November 2025).",
  },
  {
    id: "vet-wellness",
    match: /\b(?:exam|wellness)/i,
    specialties: ["veterinary"],
    price: "$95",
    unit: "visit",
    range: [75, 171],
    source: "https://www.carecredit.com/well-u/pet-care/top-expenses-dog-owners",
    checked: CHECKED,
    note: "National average wellness vet visit for a dog $95, range $75 to $171 (2025 Synchrony study, page of 20 February 2026).",
  },
  {
    // unsourced, for the owner: a free consultation is the demo's earlier sample, not a published figure.
    id: "consultation",
    match: /\bconsult/i,
    price: "Complimentary",
    unit: "visit",
    range: [0, 0],
    source: null,
    checked: null,
    note: "Unsourced: the demo's earlier sample (a free consultation), kept for the owner.",
  },
];

/** What a treatment the table does not cover is priced as: no figure, an offer to talk it through. */
export const CONSULTATION_PRICE = "Price at consultation";

/** The kind of a treatment, by its name and the practice's specialty, or null when no entry covers it. */
export function benchmarkFor(name: string, specialty: SpecialtyId | null): Benchmark | null {
  return BENCHMARKS.find((b) => (!b.specialties || (specialty !== null && b.specialties.includes(specialty))) && b.match.test(name)) ?? null;
}

export function benchmarkById(id: string): Benchmark | null {
  return BENCHMARKS.find((b) => b.id === id) ?? null;
}

/** The dollar figure a printed price carries ("$1,602" → 1602, "$14/unit" → 14), 0 for "Complimentary", null for none. */
export function priceFigure(price: string): number | null {
  if (/^complimentary$/i.test(price.trim())) return 0;
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/.exec(price);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}
