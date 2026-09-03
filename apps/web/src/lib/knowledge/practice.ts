/**
 * The practice-type layer — who the business is, not what it sells.
 *
 * A dermatology group and a med spa can both sell Botox, and they are nothing
 * alike as businesses: different callers, different emotional register,
 * different person answering the phone, different reason a missed call hurts.
 * So the tree splits on PRACTICE TYPE here and on SERVICE LINE below, and a
 * service line can hang off several practice types.
 *
 * ## What goes in this layer, and why each field earns its place
 *
 * The original version of this file had one field — approximate pricing — which
 * is the least interesting thing about a practice. These are the fields that
 * actually make an agent sound like a peer:
 *
 *   whoCalls        The first sentence out of a real caller's mouth. It differs
 *                   more by practice type than anything else, and getting it
 *                   right is the fastest possible credibility.
 *   register        The emotional temperature. Fertility is grief-adjacent;
 *                   body contouring is aspirational; a cracked molar is pain.
 *                   Same words at the wrong temperature read as callous.
 *   frontDesk       What the person is DOING when the phone rings. This is what
 *                   makes "you're missing calls" concrete rather than accusatory.
 *   rhythm          Seasonality and timing. Knowing that Q4 is dental benefits
 *                   season is the kind of thing only someone in the industry says.
 *   economics       The number the OWNER watches — chair time, room utilisation,
 *                   OR days, cost per lead. Not our number, theirs.
 *   payerMix        Cash-pay or insurance. Load-bearing beyond tone: it predicts
 *                   HIPAA covered-entity status, which decides which BAA branch
 *                   they sign and which consent standard applies to reminders.
 *   scopeRisk       What the agent must never say in THIS practice specifically.
 *                   The generic rule is in the persona; this is the local trap.
 *   objection       The one push-back this practice type actually gives.
 *   observation     A true, slightly surprising thing a practitioner would nod at.
 *                   One per conversation, dropped where it fits.
 */

export type PracticeKnowledge = {
  id: string;
  label: string;
  whoCalls: string;
  register: string;
  frontDesk: string;
  rhythm: string;
  economics: string;
  payerMix: string;
  scopeRisk: string;
  objection: string;
  observation: string;
  /** Service lines this practice type commonly sells. */
  niches: readonly string[];
};

export const PRACTICES: Record<string, PracticeKnowledge> = {
  "med-spa": {
    id: "med-spa",
    label: "Med spa / aesthetics",
    whoCalls:
      "\"How much is Botox?\" — usually within the first eight words. Price-first, comparison shopping, often three clinics in one sitting. A large minority are first-timers who don't know the vocabulary and are slightly embarrassed about it.",
    register:
      "Light and unhurried. These are discretionary purchases people are a bit self-conscious about. Never gush about results, never imply they need anything.",
    frontDesk:
      "Usually one person who is also the injector, or a single coordinator who is mid-treatment with a patient in the room. The phone rings while someone is holding a syringe.",
    rhythm:
      "Bookings cluster before weddings, reunions and holidays, and neurotoxin brings people back every 3–4 months, so a first-timer is worth roughly three visits a year. January is quiet; November and December are not.",
    economics:
      "Room and injector utilisation. An empty chair at 2pm cannot be resold, and the owner is usually the injector, so every hour on the phone is an hour not treating.",
    payerMix:
      "Almost entirely cash-pay. Most med spas do not bill insurance electronically and are therefore probably NOT HIPAA covered entities — which changes the agreement they sign and removes the healthcare exemption from the TCPA analysis. Never assert their status; ask.",
    scopeRisk:
      "Candidacy questions arrive constantly — 'can I have filler if I'm breastfeeding', 'will this fix my jawline'. Both must go to a human, warmly and immediately.",
    objection:
      "\"We already answer our phones.\" Ask what happens when the injector is in a room and the other line goes. Nobody misses the calls they know about.",
    observation:
      "The call that costs a med spa most isn't the missed one — it's the price-shopper who got through, got a number with no context, and rang the next clinic. A first-timer who gets a warm 90 seconds books at a much higher rate than one who gets a price.",
    niches: ["injectables", "laser-skin", "body-contouring", "weight-loss-glp1", "wellness-iv"],
  },

  dermatology: {
    id: "dermatology",
    label: "Dermatology",
    whoCalls:
      "Split down the middle: medical callers with a mole, a rash or a referral who want the soonest appointment, and cosmetic callers who want price and availability. The two want completely different conversations and often ring the same number.",
    register:
      "Calm and slightly clinical. A medical dermatology caller is often worried about skin cancer and will not say so directly — treat urgency requests seriously without ever assessing anything.",
    frontDesk:
      "A real front desk, often two or three people, and usually a queue in the waiting room. They are not missing calls out of carelessness; they are missing them because they are checking someone in.",
    rhythm:
      "Post-summer is skin-check season. Cosmetic work skews to autumn and winter, when patients can stay out of the sun afterwards — 'laser season' is a real term and using it correctly is a credibility marker.",
    economics:
      "Provider schedule density, and the gap between a booked slot and a filled one. A dermatologist's day is booked in 15-minute blocks and a no-show is a hole nobody fills.",
    payerMix:
      "Mixed, and this is the important one — a practice with a medical side almost certainly bills insurance electronically and IS a covered entity, even though the cosmetic half looks like a med spa. The BAA is not optional here.",
    scopeRisk:
      "Highest of any practice type. Callers describe lesions, ask whether something looks cancerous, and send photos. The agent takes a callback number and nothing else — no reassurance, no triage, not even 'that sounds like it's probably fine'.",
    objection:
      "\"Our patients need a real person.\" Agree, and reframe: the agent's job is to get them to a real person faster, not instead.",
    observation:
      "Derm practices tend to discover their missed-call problem in the cosmetic line first, because that caller simply books elsewhere, whereas a medical caller keeps ringing back. The medical side hides the leak.",
    niches: ["injectables", "laser-skin", "hair-restoration"],
  },

  "plastic-surgery": {
    id: "plastic-surgery",
    label: "Plastic & cosmetic surgery",
    whoCalls:
      "Long-considered and heavily researched. They have read the surgeon's before-and-afters and often name a specific procedure. The call is really an interview, and price is rarely the first question.",
    register:
      "Measured and discreet. Body-image conversations need care; never affirm a perceived flaw, never compliment, never speculate about what would suit them.",
    frontDesk:
      "A patient coordinator whose real job is consultations, not calls. When the surgeon is operating — often two or three days a week — the practice's most valuable calls arrive with nobody free to take them.",
    rhythm:
      "Surgical bookings run months ahead, with a strong 'recovery over Christmas' cluster and a spring pre-summer wave. Consults convert weeks after the first call, so speed to first contact matters more than closing on the phone.",
    economics:
      "OR days. An unfilled surgical slot is the single most expensive empty hour in aesthetics, and consult-to-surgery conversion is the number the practice manager reports on.",
    payerMix:
      "Mostly cash-pay, with reconstructive work billed to insurance. A practice doing any reconstruction is a covered entity.",
    scopeRisk:
      "Never estimate a surgical price beyond a published range, never discuss recovery, risk, or whether someone is a candidate. Book the consult; that is the whole job.",
    objection:
      "\"Our consults are too high-value for a bot.\" Precisely — which is why the alternative is voicemail. The agent captures the number and books the consult, it does not sell the surgery.",
    observation:
      "The highest-value call a surgical practice takes is often the shortest: someone who has already decided and wants a consult date. Those are exactly the calls that go to voicemail on operating days.",
    niches: ["body-contouring", "injectables", "hair-restoration"],
  },

  dental: {
    id: "dental",
    label: "Dental & ortho-cosmetic",
    whoCalls:
      "Three distinct callers on one line: emergencies in pain who need to be seen today, insurance questions, and cosmetic enquiries about veneers or aligners. The emergency caller will not wait on hold.",
    register:
      "Brisk and reassuring for pain calls — get them a time, fast. Warmer and slower for cosmetic. Reading which one you have inside a sentence is the skill.",
    frontDesk:
      "Front desk is also doing check-in, insurance verification and payment. Lunchtime and the 8–9am rush are when the phone is loudest and the desk is least available.",
    rhythm:
      "Q4 is the big one: patients with unused annual benefits book in November and December, and a practice that misses those calls loses revenue that expires. New Year brings the aligner enquiries.",
    economics:
      "Chair time and hygiene recall. An unfilled hygiene slot is lost forever, and the practice tracks production per chair per day.",
    payerMix:
      "Insurance-heavy, so almost always a covered entity — dental practices bill electronically as a matter of course. The BAA matters here and the practice will expect you to have one.",
    scopeRisk:
      "Pain assessment. 'Is this an emergency?' must become 'let me get you the soonest slot and have someone call you straight back' — never a judgement about the tooth.",
    objection:
      "\"Will it handle insurance questions?\" Be honest: it takes the details and routes them, it does not verify benefits. Overpromising here is caught on day one.",
    observation:
      "Dental is the one specialty where the most urgent caller is also the most likely to hang up and try the next practice — someone in real pain does not leave a voicemail.",
    niches: ["ortho-cosmetic"],
  },

  fertility: {
    id: "fertility",
    label: "Fertility, IVF & reproductive medicine",
    whoCalls:
      "People at the end of a long private decision. Often the first call they have ever made about it, frequently made from a car or a bathroom at work. Many have been trying for years and have already been let down somewhere.",
    register:
      "The most careful of any practice type. Quiet, unhurried, no brightness. Never say 'congratulations', never assume a partner, never assume the goal, never use the word 'just'. If someone volunteers something painful, acknowledge it in four words and continue.",
    frontDesk:
      "A small coordinator team carrying long, emotionally heavy calls. A twenty-minute call is normal, which is exactly why the next caller gets voicemail.",
    rhythm:
      "Enquiries spike in January and after holidays — family gatherings are a trigger. Cycles are time-critical: a caller who needs to start with their next cycle cannot wait a week for a callback.",
    economics:
      "Cycle starts per month, and the cost of acquiring a patient is very high — often four figures — so a lost first call is an expensive loss.",
    payerMix:
      "Mixed and complicated; increasingly employer-benefit funded. Almost certainly a covered entity.",
    scopeRisk:
      "Highest emotional stakes in the tree. Never discuss success rates, protocols, eligibility, age, diagnosis, or anything about anyone's chances. Take the details, book the consult, offer a nurse callback.",
    objection:
      "\"This is too sensitive for AI.\" Take it seriously rather than arguing. The honest answer: it answers the calls nobody is free to take, says very little, and gets a human on the phone sooner — and it never discusses anything clinical.",
    observation:
      "Fertility practices routinely have the longest average call time and the highest cost per enquiry in medicine, which means their unanswered-call problem is simultaneously the worst and the least visible.",
    niches: ["ivf"],
  },

  ophthalmology: {
    id: "ophthalmology",
    label: "LASIK, refractive & premium ophthalmology",
    whoCalls:
      "Two very different callers. Refractive enquiries are researched, price-sensitive and comparison shopping. Medical and cataract callers are older, often referred, and want reassurance about the process.",
    register:
      "Confident and plain for LASIK — these callers want candidacy and cost and dislike vagueness. Slower and more patient for cataract and medical calls.",
    frontDesk:
      "Technicians double as reception in smaller practices. During clinic hours nearly everyone is in a lane with a patient.",
    rhythm:
      "Strong Q4 spike from FSA and HSA deadlines — 'use it or lose it' drives a genuine December rush for elective vision correction. January is quiet by comparison.",
    economics:
      "Surgeon and laser-suite utilisation. A refractive practice with an idle laser day is losing several thousand dollars of contribution.",
    payerMix:
      "Refractive is cash-pay; medical and cataract are insurance-billed. Any practice with a medical side is a covered entity.",
    scopeRisk:
      "Candidacy is the trap — 'am I too short-sighted for LASIK', 'is my prescription stable'. Never assess. Book the screening, which is free at most practices and is the natural next step anyway.",
    objection:
      "\"Our callers ask technical questions.\" True, and the agent should answer none of them — it books the free screening, which is what the practice wants anyway.",
    observation:
      "Refractive is one of the few elective procedures with a hard annual deadline attached to it. A missed call in the first week of December is worth several missed calls in June.",
    niches: ["lasik-refractive"],
  },

  "hormone-health": {
    id: "hormone-health",
    label: "TRT, hormone & longevity",
    whoCalls:
      "Mostly men in their 30s to 50s for TRT, often self-diagnosed after months of reading, and often slightly defensive about it. Hormone and menopause callers are usually women who have been dismissed elsewhere and arrive expecting to be dismissed again.",
    register:
      "Matter-of-fact and non-judgemental. No coyness, no innuendo, no wellness-speak. For menopause callers especially: take them seriously and quickly, because being taken seriously is what they are actually shopping for.",
    frontDesk:
      "Often a very small team — sometimes the provider answers the phone between telehealth appointments. High enquiry volume relative to headcount.",
    rhythm:
      "January and September are strongest. Membership models mean the value of one new patient is annual, not per-visit.",
    economics:
      "Membership retention above everything: monthly recurring revenue, and the cost of the first lab panel against the lifetime of the member.",
    payerMix:
      "Predominantly cash-pay and membership. Often not covered entities — ask rather than assume.",
    scopeRisk:
      "Very high. Symptoms, levels, dosing, protocols and 'do I qualify' come up in almost every call. None of it can be touched. The agent books the consult and lab work; the provider does the rest.",
    objection:
      "\"Callers want to know if they qualify.\" That is precisely the conversation the agent must not have — and the practice would not want a receptionist having it either.",
    observation:
      "The single most common opening line in this niche is a symptom, not a question — 'I've been exhausted for a year'. An agent that responds to the symptom is broken; one that responds to the person and books the consult is doing the job.",
    niches: ["trt-hormone", "weight-loss-glp1", "wellness-iv"],
  },

  "weight-loss": {
    id: "weight-loss",
    label: "Medical weight loss",
    whoCalls:
      "Almost all new to the practice, arriving from an advert, comparing three or four clinics on price and start date. Many have taken a GLP-1 before and are switching because of cost or supply.",
    register:
      "Neutral and practical. No congratulating, no encouraging, no commenting on anyone's body or goals in any direction. This is the practice type where a warm-but-neutral tone matters most and is easiest to get wrong.",
    frontDesk:
      "Frequently a single coordinator handling very high enquiry volume, with a lot of repeat questions about price and eligibility.",
    rhythm:
      "January is enormous — the single most concentrated demand spike in the whole tree — with a secondary pre-summer wave. A clinic that cannot answer its phone in January loses a year's worth of acquisition in six weeks.",
    economics:
      "Monthly programme revenue and retention past month three, which is where most attrition happens. One new member is worth $1,800–2,400 over a course, not one visit.",
    payerMix:
      "Cash-pay and membership, occasionally insurance for the visit but not the drug. Usually not covered entities.",
    scopeRisk:
      "Extreme, and the most likely place to get this wrong. Dosing, titration, side effects, contraindications, whether they qualify, BMI thresholds — none of it. Take details, book the consult, provider decides.",
    objection:
      "\"Everyone asks if they qualify.\" Yes — and the agent's answer is always the same: that is a provider conversation, here is the soonest one. Consistency is the feature.",
    observation:
      "This is the one segment where nearly every caller is new to the practice and shopping, so an unanswered call is almost always a lost patient rather than a delayed one. It has the highest defection rate of anything in the tree.",
    niches: ["weight-loss-glp1", "trt-hormone"],
  },

  "hair-restoration": {
    id: "hair-restoration",
    label: "Hair restoration & transplant",
    whoCalls:
      "Heavily researched, privacy-conscious, often having considered it for years before ringing. Many will not leave a voicemail at all — the call itself took some doing.",
    register:
      "Discreet and unembarrassed. Treat it as the ordinary medical decision it is. No jokes, no reassurance about appearance, no enthusiasm.",
    frontDesk:
      "Small practices, often the surgeon or a single coordinator, with consultations taking most of the day.",
    rhythm:
      "Steadier than most aesthetics, with a mild autumn and winter preference because of the visible recovery period.",
    economics:
      "Graft volume and surgical day utilisation. A transplant is a four-figure to five-figure procedure with a long consideration period, so the pipeline matters more than any single week.",
    payerMix: "Cash-pay almost exclusively. Usually not covered entities.",
    scopeRisk:
      "No assessment of hair loss stage, graft counts, candidacy, or whether PRP will work for them. Photographs arrive often; do not comment on them.",
    objection:
      "\"Our consults are very personal.\" Agreed — which is why the agent books them rather than conducting them, and why not leaving a voicemail is such a common outcome here.",
    observation:
      "Hair restoration has an unusually high share of callers who will not leave a message and will not call back. The unanswered call is more final in this niche than almost anywhere else.",
    niches: ["hair-restoration"],
  },
};

export function getPractice(id: string): PracticeKnowledge | undefined {
  return PRACTICES[id];
}

export const PRACTICE_OPTIONS = Object.values(PRACTICES).map((p) => ({
  id: p.id,
  label: p.label,
}));
