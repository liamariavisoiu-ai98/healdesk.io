import type { Segment } from "@healdesk/catalog";

/**
 * A specialty and the one service people most often ask that specialty about,
 * worked out from nothing but an Apollo row: the company name, the person's
 * title, Apollo's industry and its keyword list. No page is fetched.
 *
 * The top service is common sense, not a scrape. A plastic surgery practice's
 * best-known cash-pay service is Botox, a dental practice's is implants, an eye
 * centre's is LASIK. When the clinic's own site is crawled later
 * (`npm run enrich`), the crawl's `topService` replaces it. The outreach copy
 * names it as "booking Botox" or "about Botox", so each value is written the way
 * a clinic would say it, in the plural where that is natural, and lower case
 * except for proper names.
 *
 * `segment` is the pipeline's closed vocabulary (packages/catalog/src/
 * segments.ts), so a row can go straight into the enrichment and the outreach
 * generator. Several specialties share one segment: an orthodontist and a
 * general dentist are both "dental".
 */

export type Specialty = {
  /** Machine id, stable. */
  id: string;
  /** What the owner reads in the spreadsheet. */
  label: string;
  topService: string;
  segment: Segment;
  /** Matched against the company name. */
  name: readonly RegExp[];
  /**
   * Words that hint at the specialty but also appear in clinics of every kind
   * ("wellness", "studio", "skin"). Worth a little, never enough to decide
   * against a real signal.
   */
  weakName?: readonly RegExp[];
  /** Matched against the person's job title. */
  title: readonly RegExp[];
  /** Matched against Apollo's keywords, one point each (capped). */
  keywords: readonly RegExp[];
};

const i = (s: string) => new RegExp(s, "i");

/**
 * Ordered most specific first: on a tie the earlier entry wins, so "Eye &
 * Laser Center" is an eye practice and not a laser clinic.
 */
export const SPECIALTIES: readonly Specialty[] = [
  {
    id: "plastic-surgery", label: "Plastic & cosmetic surgery", topService: "Botox", segment: "plastic-surgery",
    name: [i("plastic"), i("cosmetic surg"), i("aesthetic surg"), i("reconstructive"), i("rhinoplasty"), i("breast (center|surgery|aug)"), i("facial (plastic|aesthetic)")],
    title: [i("plastic"), i("cosmetic surgeon"), i("aesthetic surgeon"), i("reconstructive"), i("oculoplastic"), i("facial plastic")],
    keywords: [i("plastic surgery"), i("cosmetic surgery"), i("breast augmentation"), i("facelift"), i("liposuction"), i("rhinoplasty"), i("tummy tuck"), i("aesthetic surgery")],
  },
  {
    id: "ophthalmology", label: "Eye care & LASIK", topService: "LASIK", segment: "vision",
    name: [i("\\beye"), i("ophthalm"), i("lasik"), i("retina"), i("cataract"), i("optom"), i("vision"), i("\\boptical"), i("cornea"), i("sight")],
    title: [i("ophthalm"), i("retina"), i("vitreoretinal"), i("cataract"), i("optometr"), i("\\beye\\b"), i("cornea")],
    keywords: [i("ophthalmology"), i("ophthalmologists"), i("lasik"), i("cataract surgery"), i("optometrists"), i("vision correction"), i("refractive surgery"), i("eye care")],
  },
  {
    id: "dermatology", label: "Dermatology", topService: "Botox", segment: "dermatology",
    name: [i("dermatolog"), i("\\bderm\\b"), i("\\bmohs"), i("skin cancer"), i("skin (institute|center|specialist|physicians)")],
    title: [i("dermatolog"), i("mohs")],
    keywords: [i("dermatology"), i("medical dermatology"), i("cosmetic dermatology"), i("mohs surgery"), i("skin cancer")],
  },
  {
    id: "dental", label: "Dental & orthodontics", topService: "dental implants", segment: "dental",
    name: [i("dental"), i("dentist"), i("\\bdds\\b"), i("\\bdmd\\b"), i("orthodont"), i("periodon"), i("endodont"), i("oral (&|and)? ?maxillofacial"), i("oral surg"), i("\\bsmiles?\\b"), i("\\bteeth\\b"), i("braces")],
    title: [i("dentist"), i("orthodont"), i("periodon"), i("endodont"), i("oral (&|and)? ?maxillofacial"), i("oral surgeon"), i("\\bdds\\b"), i("\\bdmd\\b")],
    keywords: [i("dentistry"), i("dental"), i("orthodontics"), i("invisalign"), i("dental implants"), i("teeth whitening")],
  },
  {
    id: "hair-restoration", label: "Hair restoration", topService: "hair transplants", segment: "hair-restoration",
    name: [i("hair (restoration|transplant|clinic|institute|center|replacement)"), i("hairline"), i("follic"), i("bosley")],
    title: [i("hair (restoration|transplant)")],
    keywords: [i("hair restoration"), i("hair transplant"), i("hair loss")],
  },
  {
    id: "weight-loss", label: "Weight loss & GLP-1", topService: "semaglutide", segment: "weight-loss-glp1",
    name: [i("weight"), i("bariatric"), i("semaglutide"), i("glp"), i("\\bslim"), i("metabolic")],
    title: [i("bariatric"), i("weight loss")],
    keywords: [i("weight loss"), i("weight management"), i("bariatric"), i("semaglutide"), i("glp")],
  },
  {
    id: "body-contouring", label: "Body contouring", topService: "CoolSculpting", segment: "body-contouring",
    name: [i("contour"), i("sculpt"), i("body (lab|by|studio|shaping)"), i("\\blipo"), i("cryo")],
    title: [],
    keywords: [i("body contouring"), i("coolsculpting"), i("body sculpting"), i("fat reduction")],
  },
  {
    id: "laser-skin", label: "Laser & skin clinic", topService: "laser hair removal", segment: "laser-skin",
    name: [i("laser"), i("\\bipl\\b"), i("hair removal"), i("rejuvenat")],
    weakName: [i("skin (clinic|studio|bar|lounge|care)"), i("skincare")],
    title: [],
    keywords: [i("laser hair removal"), i("laser treatments"), i("skin rejuvenation"), i("skin tightening"), i("microneedling"), i("chemical peels")],
  },
  {
    id: "wellness-iv", label: "Wellness & IV therapy", topService: "IV therapy", segment: "wellness-iv",
    name: [i("\\biv\\b"), i("hydrat"), i("\\bdrip"), i("infusion"), i("longevity"), i("vitality"), i("regenerat"), i("functional medicine")],
    weakName: [i("wellness")],
    title: [],
    keywords: [i("iv therapy"), i("longevity"), i("regenerative medicine"), i("functional medicine"), i("cryotherapy")],
  },
  {
    id: "med-spa", label: "Med spa & aesthetics", topService: "Botox", segment: "injectables",
    name: [i("med(ical)? ?spa"), i("medspa"), i("aesthetic"), i("esthetic"), i("\\bspa\\b"), i("inject"), i("botox"), i("\\bfiller")],
    weakName: [i("beauty"), i("\\bglow"), i("radian"), i("\\bskin\\b"), i("lounge"), i("\\bstudio\\b")],
    title: [i("injector"), i("aesthetic nurse"), i("esthetician")],
    keywords: [i("med spa"), i("medical spa"), i("injectables"), i("botox"), i("dermal fillers"), i("aesthetic treatments"), i("beauty & spas"), i("skin care")],
  },
  {
    id: "chiropractic", label: "Chiropractic", topService: "spinal adjustments", segment: "chiropractic",
    name: [i("chiropract"), i("\\bspine"), i("spinal")],
    title: [i("chiropract")],
    keywords: [i("chiropractic"), i("chiropractor")],
  },
  {
    id: "physical-therapy", label: "Physical therapy & rehab", topService: "physical therapy evaluations", segment: "physical-therapy",
    name: [i("physical therap"), i("\\bpt\\b"), i("rehab")],
    title: [i("physical therap")],
    keywords: [i("physical therapy"), i("rehabilitation"), i("sports medicine")],
  },
  {
    id: "acupuncture", label: "Acupuncture", topService: "acupuncture", segment: "acupuncture",
    name: [i("acupunct"), i("oriental medicine"), i("chinese medicine")],
    title: [i("acupunct")],
    keywords: [i("acupuncture"), i("traditional chinese medicine"), i("chinese herbology"), i("herbal medicine")],
  },
  {
    id: "massage", label: "Massage therapy", topService: "massage", segment: "massage-therapy",
    name: [i("massage")],
    title: [i("massage")],
    keywords: [i("massage therapy"), i("massage")],
  },
  {
    id: "hearing", label: "Hearing", topService: "hearing tests", segment: "hearing",
    name: [i("hearing"), i("audiolog"), i("\\bent\\b"), i("ear,? nose")],
    title: [i("audiolog"), i("\\bent\\b")],
    keywords: [i("audiology"), i("hearing aids"), i("hearing")],
  },
  {
    id: "mental-health", label: "Mental health", topService: "therapy sessions", segment: "mental-health",
    name: [i("psych"), i("counsel"), i("therap(y|ist) (center|group|associates)"), i("behavioral"), i("mental health"), i("ketamine")],
    title: [i("psycholog"), i("psychiatr"), i("counselor"), i("therapist")],
    keywords: [i("mental health"), i("psychiatry"), i("psychology"), i("counseling"), i("ketamine")],
  },
  {
    id: "fertility", label: "Fertility", topService: "IVF", segment: "other-medical",
    name: [i("fertility"), i("\\bivf\\b"), i("reproductive (medicine|endocrin|health)")],
    title: [i("reproductive endocrin"), i("fertility")],
    keywords: [i("fertility clinics?"), i("\\bivf\\b"), i("reproductive endocrinology"), i("infertility")],
  },
  {
    id: "hormone", label: "Hormone & men's health", topService: "testosterone therapy", segment: "wellness-iv",
    name: [i("hormone"), i("men'?s (health|clinic|medicine|wellness|t)\\b"), i("\\btrt\\b"), i("low ?t\\b"), i("testosterone"), i("urolog"), i("man cave")],
    title: [i("urolog")],
    keywords: [i("hormone replacement"), i("bioidentical"), i("testosterone"), i("mens health"), i("men's health"), i("erectile")],
  },
  {
    id: "womens-health", label: "OB-GYN & women's health", topService: "annual exams", segment: "other-medical",
    name: [i("women'?s (health|care|center|clinic|medical)"), i("ob-?gyn"), i("obstetric"), i("gynecolog"), i("midwi")],
    title: [i("ob-?gyn"), i("gynecolog"), i("obstetric")],
    keywords: [i("obgyn"), i("obstetrics"), i("gynecology"), i("womens health"), i("women's health")],
  },
  {
    id: "orthopedics", label: "Orthopedics & sports medicine", topService: "orthopedic consultations", segment: "other-medical",
    name: [i("orthop"), i("sports (medicine|performance)"), i("joint"), i("bone")],
    title: [i("orthop")],
    keywords: [i("orthopedics"), i("orthopaedic"), i("sports medicine"), i("joint replacement")],
  },
  {
    id: "primary-care", label: "Primary & urgent care", topService: "new patient visits", segment: "other-medical",
    name: [i("family (medicine|practice|health|care)"), i("primary care"), i("urgent care"), i("internal medicine"), i("walk-?in"), i("direct primary")],
    title: [i("family (medicine|physician)"), i("internal medicine")],
    keywords: [i("primary care"), i("family practice"), i("urgent care"), i("internal medicine"), i("direct primary care")],
  },
];

/** Industries Apollo gives to clinics. Any other industry is a clinic only if the company's own name says so. */
const CLINIC_INDUSTRY = new Set([
  "medical practice", "hospital & health care", "health, wellness & fitness", "alternative medicine",
  "mental health care", "cosmetics", "consumer services", "individual & family services", "",
]);

/** Words in a company name that mark a vendor, an agency or a lab, never a clinic. */
const VENDOR_NAME = i("\\b(pharmacy|software|technolog(y|ies)|digital|marketing|media|agency|consulting|ventures|insurance|supply|supplies|distribution|manufactur\\w*|biotech|therapeutics|genomics|health ?tech|saas|labs?|diagnostics|logistics)\\b|\\.ai\\b");

/**
 * Keywords that mean the company sells a product, a software service or a
 * matching service rather than seeing patients: supplements, SaaS, e-commerce,
 * surrogacy and egg-donor agencies. Weighed only when the keywords are the sole
 * evidence ("weight loss" in the keywords of Noom, an app, must not make it a
 * weight-loss clinic). "Telehealth" and "app" are not here: clinics list both.
 */
const PRODUCT_SOURCE = "\\bsaas\\b|mobile app|e-?commerce|supplements?|nutraceutical|online (store|pharmacy)|personal care products|consumer products|direct-to-consumer|\\bd2c\\b|surrogacy|egg donor|egg donation|sperm donation|donor conception|subscription box";
const PRODUCT_OR_AGENCY = i(PRODUCT_SOURCE);
const PRODUCT_OR_AGENCY_G = new RegExp(PRODUCT_SOURCE, "gi");

const HEALTH_SYSTEM_NAME = i("hospital|health system|medical center|health ?care|\\bhealth\\b|\\bupmc\\b|\\bclinic\\b");
const PHYSICIAN_TITLE = i("physician|\\bm\\.?d\\b|\\bd\\.?o\\b|surgeon|doctor|medical director|nurse practitioner|\\bnp\\b|dentist");

export type SpecialtyGuess = {
  id: string;
  label: string;
  topService: string;
  segment: Segment | "not-a-target";
  /** What decided it, so the owner can audit a row in one glance. */
  basis: "title" | "company name" | "keywords" | "industry only" | "industry (not a clinic)" | "company name (not a clinic)" | "size (health system)" | "product or agency keywords" | "nothing";
};

const OUT = (label: string, id: string, basis: SpecialtyGuess["basis"]): SpecialtyGuess => ({ id, label, topService: "", segment: "not-a-target", basis });

/**
 * Score every specialty and take the best.
 *
 * The title and the company name are the strong signals. A person titled
 * "Plastic Surgeon" runs a plastic surgery practice whatever the company is
 * called, so a title hit outweighs a name hit. Keywords are weak, because every
 * aesthetic clinic lists "botox" and "skin care", and count a point each up to
 * three. Words like "wellness" and "studio" in a name are weaker still, worth
 * half a keyword.
 *
 * A row is not a clinic when its name is a vendor's ("... Pharmacy", "... Media",
 * "... Software"), or when Apollo files it under an industry clinics are not
 * filed under and its name says nothing clinical. "Soilytics" is a soil-testing
 * company whose Apollo keywords include "fertility"; the keyword must not make
 * it a fertility clinic. A very large health system is out too: it is not an
 * owner-run clinic.
 *
 * When no specialty scores, a physician-titled or health-industry row is an
 * "Other medical practice" with the one service every practice sells, a new
 * patient visit; a row with no signal at all is left for the owner to review.
 */
export function guessSpecialty(row: { company: string; title: string; industry: string; keywords: string; employees?: number }): SpecialtyGuess {
  const company = row.company.toLowerCase();
  const title = row.title.toLowerCase();
  const industry = row.industry.toLowerCase().trim();
  const keywords = row.keywords.toLowerCase();

  if (VENDOR_NAME.test(company)) return OUT("Not a clinic", "not-a-clinic", "company name (not a clinic)");

  let best: { s: Specialty; score: number; titleHit: boolean; nameHit: boolean } | null = null;
  for (const s of SPECIALTIES) {
    const titleHit = s.title.some((r) => r.test(title));
    const nameHit = s.name.some((r) => r.test(company));
    const weakHit = (s.weakName ?? []).some((r) => r.test(company));
    const kw = Math.min(3, s.keywords.filter((r) => r.test(keywords)).length);
    const score = (titleHit ? 7 : 0) + (nameHit ? 6 : 0) + (weakHit ? 0.5 : 0) + kw;
    if (score > 0 && (!best || score > best.score)) best = { s, score, titleHit, nameHit };
  }

  if (!CLINIC_INDUSTRY.has(industry) && !best?.nameHit) return OUT("Not a clinic", "not-a-clinic", "industry (not a clinic)");
  if ((row.employees ?? 0) > 1000 && industry === "hospital & health care" && HEALTH_SYSTEM_NAME.test(company) && !best?.nameHit) {
    return OUT("Hospital / health system", "health-system", "size (health system)");
  }

  // Keywords alone, and they describe a product or an online service: not a local clinic.
  //
  // One product word is not enough when the keywords also describe treatments:
  // a med spa that lists "supplements" among its botox, fillers and lasers is
  // still a med spa. It takes two distinct product signals, or almost no
  // clinical evidence.
  const productSignals = new Set((keywords.match(PRODUCT_OR_AGENCY_G) ?? []).map((m) => m.toLowerCase())).size;
  if (!best?.nameHit && !best?.titleHit && PRODUCT_OR_AGENCY.test(keywords) && (productSignals >= 2 || (best?.score ?? 0) <= 2)) {
    return { ...OUT("Product, online brand or agency", "product-or-agency", "product or agency keywords") };
  }

  if (best) {
    const basis: SpecialtyGuess["basis"] = best.titleHit ? "title" : best.nameHit ? "company name" : "keywords";
    return { id: best.s.id, label: best.s.label, topService: best.s.topService, segment: best.s.segment, basis };
  }
  if (PHYSICIAN_TITLE.test(title)) {
    return { id: "other-medical", label: "Other medical practice", topService: "new patient visits", segment: "other-medical", basis: "title" };
  }
  if (industry) {
    return { id: "other-medical", label: "Other medical practice", topService: "new patient visits", segment: "other-medical", basis: "industry only" };
  }
  return { id: "unclear", label: "Unclear: review", topService: "", segment: "other-medical", basis: "nothing" };
}
