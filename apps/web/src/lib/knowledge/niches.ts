import type { Segment } from "@healdesk/catalog";

/**
 * The service-line layer, the deepest branch, and the one that has to survive
 * contact with someone who does this every day.
 *
 * ## What "expert" means here
 *
 * Not more facts. A practitioner spots an outsider by three things, in this
 * order: using a word slightly wrong, quoting a price that is off by a
 * generation, and being confidently vague about the thing they find hard. So
 * each entry carries the vocabulary as a peer uses it, prices in the ranges
 * actually charged this year, and, most importantly, the awkward bit.
 *
 * `theHardPart` is the field that does the work. Anyone can list treatments;
 * only someone who has been around the industry knows that GLP-1 clinics live
 * in fear of the month-three drop-off, or that laser hair removal's real problem
 * is package attrition rather than acquisition. Naming that in one sentence buys
 * more credibility than a paragraph of correct terminology.
 *
 * `neverSay` is the local scope trap. The global rule lives in the persona; this
 * is the specific question that will actually be asked in this niche, and the
 * specific way it gets asked.
 *
 * Ids are the shared segment enum from @healdesk/catalog, the same string the
 * prospecting pipeline classifies a clinic into, so a cold email targeting
 * `weight-loss-glp1` lands a visitor on the branch that knows it.
 */

export type NicheKnowledge = {
  id: Segment | "ivf" | "lasik-refractive" | "trt-hormone" | "ortho-cosmetic";
  label: string;
  /** Words a peer uses, used correctly and without explanation. */
  vocabulary: string;
  /** Approximate US ranges, current. Never presented as a quote. */
  pricing: string;
  /** What the caller actually opens with. */
  opener: string;
  /** The single best qualifying question, short, and not intrusive. */
  qualifier: string;
  /** Why an unanswered call here is LOST rather than delayed. The value driver. */
  defection: string;
  /** The thing practitioners find genuinely hard. Credibility lives here. */
  theHardPart: string;
  /** The local scope trap, phrased as it will actually be asked. */
  neverSay: string;
  /** One true, slightly surprising observation. At most one per conversation. */
  observation: string;
};

export const NICHES: Record<string, NicheKnowledge> = {
  injectables: {
    id: "injectables",
    label: "Injectables",
    vocabulary:
      "Neurotoxins. Botox, Dysport, Xeomin, Jeuveau, Daxxify, dosed in units; fillers dosed in syringes: Juvéderm, Restylane, RHA, Radiesse, Sculptra (a biostimulator, not a filler, and saying so correctly matters). Areas: glabella, frontalis, crow's feet, lips, cheeks, jawline, tear trough. Results at 10–14 days, repeat at 3–4 months.",
    pricing:
      "Neurotoxin $10–20/unit; a glabella treatment runs 20–25 units, a full upper face 50–64. Filler $650–1,200 a syringe. Average injectable visit lands $400–750.",
    opener: "\"How much is Botox?\", often literally the first thing said.",
    qualifier:
      "Have you had injectables before, or would a consult be more useful first?",
    defection:
      "This is the one to get right. A returning patient will absolutely ring back tomorrow. She has an injector she trusts and is not shopping. The money is entirely in the FIRST-TIME caller, who is ringing three med spas in one sitting and books whoever picks up. Pitch new-patient capture, never 'never miss a call'.",
    theHardPart:
      "Injector retention. Patients follow the injector, not the clinic, so losing one takes a book of business out of the door, which is also why owners are wary of anything that makes the practice feel less personal.",
    neverSay:
      "\"Can I get Botox while breastfeeding / pregnant / on antibiotics?\" and \"would filler fix my jawline?\" arrive constantly. Neither gets an answer, not even a hedged one.",
    observation:
      "Most med spas can name their busiest hour but not their busiest missed hour, and the two are usually the same, because the phone rings hardest when every room is full.",
  },

  "weight-loss-glp1": {
    id: "weight-loss-glp1",
    label: "Medical weight loss / GLP-1",
    vocabulary:
      "Semaglutide and tirzepatide; titration schedule; starting dose and maintenance; baseline labs and A1c; monthly membership; compounded versus branded, and since the FDA removed both from the shortage list, most compounding has ended, which is why so many patients are switching or price-shopping.",
    pricing:
      "$300–500 a month, usually sold as a 3–6 month programme, so one new patient is worth $1,800–2,400 over a course. Initial consult and labs often $100–300 or bundled.",
    opener:
      "\"Do you do the weight-loss shots, and how much?\", usually with a price comparison already in hand.",
    qualifier:
      "Are you starting fresh, or continuing a programme you began somewhere else?",
    defection:
      "The highest in the whole tree. Nearly every caller is new to the practice, arrived from an advert, and is comparing on price and start date. They book whoever answers, and an unanswered call here is a lost patient rather than a delayed one.",
    theHardPart:
      "Month three. Acquisition is comparatively easy and retention past the first titration plateau is where programmes live or die, so anything that fills the top of the funnel without fixing follow-up just moves the problem.",
    neverSay:
      "\"Do I qualify?\", \"what's my starting dose?\", \"is it safe with my thyroid?\", \"what BMI do you need?\", every one is a provider conversation. The answer is always the same and always the soonest consult.",
    observation:
      "January in this niche is not a season, it is the year. A clinic that cannot answer its phone for six weeks loses most of its annual acquisition, which is why the phone problem gets discovered in February.",
  },

  "trt-hormone": {
    id: "trt-hormone",
    label: "TRT & hormone therapy",
    vocabulary:
      "Total and free testosterone, oestradiol, SHBG, haematocrit; injections versus creams versus pellets; HCG; aromatase inhibitors. On the women's side: perimenopause, HRT, bioidenticals, pellet therapy. Membership and quarterly labs are the normal commercial shape.",
    pricing:
      "$150–300 a month on membership including labs and medication; initial panel $100–400. Pellets $400–800 per insertion, every 3–5 months.",
    opener:
      "A symptom, not a question, \"I've been exhausted for a year and my doctor says my levels are normal.\"",
    qualifier:
      "Have you had labs done recently, or would you be starting from scratch with us?",
    defection:
      "High, and emotionally loaded. Many callers have already been dismissed by a primary-care doctor and are ringing with low expectations. The clinic that answers warmly wins, and the one that sends them to voicemail confirms what they already suspected.",
    theHardPart:
      "Lab logistics and the gap between enquiry and first dose. Weeks pass between the call, the panel, the results and the consult, and patients drop out at every step.",
    neverSay:
      "\"Are my levels low?\", \"would TRT help me?\", \"what dose would I be on?\" Nothing about symptoms, levels, protocols or eligibility, and be especially careful not to validate a self-diagnosis, however confidently it is presented.",
    observation:
      "The opening line is usually a symptom rather than a question, and responding to the symptom is the single clearest tell of a bot that should not be answering the phone.",
  },

  "body-contouring": {
    id: "body-contouring",
    label: "Body contouring",
    vocabulary:
      "CoolSculpting (cryolipolysis), Emsculpt NEO (HIFEM plus RF), truSculpt iD, SculpSure, Morpheus8 Body, Venus. Sold per applicator or per area, in packages, with results at 8–12 weeks. Almost always consultation-gated.",
    pricing:
      "$700–1,500 a session or applicator; packages $1,700–3,200. The consult is usually free, which makes it an easy yes on the phone.",
    opener:
      "\"How much is CoolSculpting for the stomach?\", area-specific, price-first.",
    qualifier:
      "Which area were you thinking about, and have you had a consult anywhere yet?",
    defection:
      "Very high. High consideration, high ticket, nearly all new patients, and they book consults at two or three places. An unanswered call is usually gone.",
    theHardPart:
      "Expectation management. Results are gradual and partial, the before-and-afters set a high bar, and a disappointed package patient is expensive in refunds and reviews. Which is exactly why nobody wants a bot promising outcomes.",
    neverSay:
      "\"Will it work on me?\", \"how many sessions would I need?\", \"is it better than lipo?\" No candidacy, no session counts, no comparisons to surgery.",
    observation:
      "Because the consult is free and the treatment is expensive, this is the niche where booking the consult is nearly the whole job, the clinic closes in the room, not on the phone.",
  },

  "laser-skin": {
    id: "laser-skin",
    label: "Laser & skin",
    vocabulary:
      "Laser hair removal in packages of 6–8 sessions, by area; IPL and photofacial; fractional resurfacing (ablative and non-ablative); microneedling with or without RF; chemical peels; HydraFacial. Fitzpatrick type matters for device selection, knowing that is a credibility marker.",
    pricing:
      "Small-area hair removal $75–150 a session, packages $400–900; large area $250–450. Resurfacing $500–1,500 a session; microneedling $300–700.",
    opener:
      "\"How much for laser hair removal on legs?\", or a package question, since almost nobody buys one session.",
    qualifier: "Which area, and is this your first course or a top-up?",
    defection:
      "Lower than the rest, and worth being honest about. Package buyers shop on price and chains compete hard here, so the booked-value story is weaker. If someone's practice is mostly this, say so rather than inflating it.",
    theHardPart:
      "Package attrition. The revenue is booked up front and the sessions are not, so no-shows midway through a course clog the diary without adding anything. Retention matters more here than acquisition.",
    neverSay:
      "\"Will it work on my skin tone / hair colour?\" Device suitability is a clinical judgement, and getting it wrong is a burn.",
    observation:
      "This is the one aesthetics niche where answering matters least, because the money is already taken and the problem is getting people back through the door. healdesk answers and books; it sends no reminders, so say so if that is what they need.",
  },

  "wellness-iv": {
    id: "wellness-iv",
    label: "IV therapy & wellness",
    vocabulary:
      "Myers' cocktail, NAD+, glutathione, hydration drips, B12 and lipotropic injections; peptides; functional and longevity panels. Membership and drip-bar walk-ins are two quite different businesses under one label.",
    pricing:
      "Drips $150–400 a visit; NAD+ higher, $400–800. Injections $25–75. Memberships $99–300 a month.",
    opener:
      "\"Do you take walk-ins?\" or \"how much is a hydration drip?\", often same-day intent.",
    qualifier: "Were you after a one-off drip, or something ongoing?",
    defection:
      "Depends entirely on which business they are. Walk-in drip callers want today and will ring the next place immediately; membership patients are loyal. Ask which they mostly sell before claiming a number.",
    theHardPart:
      "Same-day demand against fixed chair capacity. The call volume is spiky and the answer is usually about availability in the next two hours, which is precisely when nobody is free to pick up.",
    neverSay:
      "\"What would help with my fatigue / hangover / long COVID?\" No recommending a drip for a symptom, ever. That is the whole regulatory soft spot of this niche.",
    observation:
      "Same-day intent makes this the niche where speed of answer beats quality of answer. A caller who gets a slot in ninety seconds does not ring anyone else.",
  },

  "hair-restoration": {
    id: "hair-restoration",
    label: "Hair restoration",
    vocabulary:
      "PRP and PRF (PRF is fibrin-rich and centrifuged without anticoagulant, the distinction is real and practitioners notice); exosomes; FUE and FUT; graft counts; Norwood scale; finasteride and minoxidil as adjuncts; donor area.",
    pricing:
      "PRP $500–1,000 a session, typically a series of three then maintenance. Exosome protocols $1,200–2,500. FUE transplants $4,000–15,000 depending on graft count.",
    opener:
      "\"Do you do PRP, and does it actually work?\", researched, slightly guarded.",
    qualifier:
      "Are you looking at something surgical, or starting with the non-surgical options?",
    defection:
      "High, and unusually final. This is a call people work up to, and a large share will not leave a voicemail or ring back, the moment passed.",
    theHardPart:
      "Managing expectations against the internet. Patients arrive with graft counts and timelines from forums, and the consult is often about resetting them, which is why the practice guards the consult so carefully.",
    neverSay:
      "\"How many grafts would I need?\", \"am I too far gone?\", \"will PRP work for me?\" Photographs arrive unprompted; do not comment on them at all.",
    observation:
      "The share of callers who hang up rather than leave a message is higher here than anywhere else in aesthetics, which makes the unanswered call unusually expensive and unusually invisible.",
  },

  ivf: {
    id: "ivf",
    label: "IVF & reproductive medicine",
    vocabulary:
      "Cycles, not rounds. IUI, IVF, ICSI, PGT-A, frozen and fresh transfer, egg retrieval, stimulation, AMH and antral follicle count, donor and reciprocal IVF. 'Trying to conceive' and 'TTC' are the patient's own words.",
    pricing:
      "An IVF cycle $12,000–20,000 before medication; medication $3,000–7,000. IUI $300–1,000 a cycle. Many practices bundle multi-cycle packages with refund guarantees.",
    opener:
      "Often hesitant, \"I'm not really sure where to start, we've been trying for a while.\"",
    qualifier:
      "Would it help to book an initial consultation, or would you rather someone called you back to talk it through first?",
    defection:
      "Extremely high in cost terms rather than probability. Patient acquisition here runs into four figures, cycles are time-critical, and a caller who has finally worked up to ringing may not ring again for months.",
    theHardPart:
      "The emotional weight sits on a very small coordinator team, and calls run twenty minutes or more. The practice is not missing calls through indifference. It is missing them because the person who would answer is on a long, hard call already.",
    neverSay:
      "Anything at all about chances, success rates, age, diagnosis, protocols, or whether they should have come sooner. Absolutely nothing clinical, and never a reassurance about outcome. Take the details, offer the soonest appointment, or pass them to the clinic's team.",
    observation:
      "Fertility practices tend to have the longest calls and the highest acquisition cost in medicine at once, which means the unanswered-call problem is both the most expensive and the least visible of any specialty.",
  },

  "lasik-refractive": {
    id: "lasik-refractive",
    label: "LASIK & refractive",
    vocabulary:
      "LASIK, PRK, SMILE, ICL, refractive lens exchange; dioptres; corneal thickness and topography; the free screening; 'candidacy' is the industry's own word. Monovision for presbyopia.",
    pricing:
      "$2,000–3,500 per eye for LASIK, often quoted all-in for both. SMILE and ICL higher. Financing is nearly universal and is usually the second question.",
    opener:
      "\"How much is LASIK, and am I a candidate?\", both halves, almost always together.",
    qualifier:
      "Have you had a screening anywhere yet? Ours is free and it's the only way to answer the candidacy question properly.",
    defection:
      "High and seasonal. Refractive callers compare two or three practices, and the Q4 FSA and HSA deadline creates a hard cut-off, a missed call in early December is worth several in June.",
    theHardPart:
      "Screening-to-surgery conversion. Free screenings fill the diary with people who will not proceed, so the practice is quietly picky about which enquiries it chases.",
    neverSay:
      "\"Am I too short-sighted?\", \"is my prescription stable enough?\", \"is my cornea thick enough?\" Never assess candidacy, book the free screening, which is what the practice wants regardless.",
    observation:
      "Elective vision correction is one of very few medical purchases with a genuine annual deadline attached, because unused FSA dollars expire. December calls are not like other calls.",
  },

  "ortho-cosmetic": {
    id: "ortho-cosmetic",
    label: "Ortho & cosmetic dentistry",
    vocabulary:
      "Clear aligners (Invisalign, and 'aligners' generically), veneers, composite versus porcelain, bonding, whitening, crowns, implants. Chair time, hygiene recall, treatment plan, case acceptance. Annual maximum and benefits year for the insurance side.",
    pricing:
      "Aligners $3,000–6,500; porcelain veneers $1,000–2,500 per tooth; implants $3,000–5,000 all in; whitening $300–800.",
    opener:
      "Either \"how much are veneers?\" or, more urgently, \"I've broken a tooth, can someone see me today?\"",
    qualifier:
      "Is this something cosmetic you're planning, or do you need to be seen soon?",
    defection:
      "Split. A cosmetic enquiry will shop around calmly. A patient in pain will ring the next practice within a minute and never come back. That caller is the most urgent and the most likely to be lost.",
    theHardPart:
      "Case acceptance. The enquiry is cheap and the treatment plan is expensive, so the practice's real metric is how many presented plans get accepted, and that conversation only ever happens in the chair.",
    neverSay:
      "\"Is this an emergency?\", \"do I need a root canal?\", \"will insurance cover it?\" Never assess pain, never verify benefits. Book the soonest slot. A caller describing swelling, trauma or severe pain gets the clinic's fixed urgent line and goes straight to its on-call contact.",
    observation:
      "Q4 is dental's January: patients with unused annual benefits book in November and December, and a call missed then is revenue that literally expires at midnight on the 31st.",
  },
};

export function getNiche(id: string): NicheKnowledge | undefined {
  return NICHES[id];
}

export function isNiche(value: unknown): value is string {
  return typeof value === "string" && value in NICHES;
}

export const NICHE_OPTIONS = Object.values(NICHES).map((n) => ({
  id: n.id,
  label: n.label,
}));
