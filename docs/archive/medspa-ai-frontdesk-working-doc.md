# MedSpa AI Front Desk — PRD & Go-to-Market Working Doc

Working document for a vertical AI front-desk / voice-agent service for medical spas: the product requirements and the lead-generation targeting playbook.

---

## Part 1 — Product Requirements (PRD)

The baseline (capture → book → reactivate) is table stakes already covered — unevenly — by incumbents. The wedge is the closed-loop revenue attribution that a standalone receptionist structurally cannot do. Build the floor to compete; build the gap to differentiate.

### Baseline service (table stakes — must match incumbents)

- [ ] **Full service:** 24/7 omnichannel capture across voice, SMS, Instagram DM, WhatsApp, and web chat; treatment qualification and pricing Q&A; writing real bookings into the calendar/EMR; deposit collection through integrated payment processors; contraindication screening with escalation to a clinician; intake and consent capture (medical-grade intake, signed PDF consent artifacts, Fitzpatrick / Accutane / pregnancy screening); appointment reminders and no-show sequences; outbound — automatic callback of missed numbers, warm-lead follow-ups, and reactivation sequences for no-shows and lapsed clients. _(capture → qualify → book → intake → deposit → remind → basic reactivation is already covered, if unevenly, across incumbents. This is the floor, not the differentiator.)_

### Conversion & revenue

- [ ] Integrated payment structure (Stripe or alternatives) for immediate booking-payment / upsell at the point of booking.
- [ ] Convert the "how much is Botox" price-shopper into a booked consult — pitch the membership, sequence complementary treatments (contraindication-aware). _Doing this well means encoding each clinic's treatment economics and best-converting paths._
- [ ] Missed-call text-back, speed-to-lead on form fills, no-show prevention via deposits and reminders, and the underexploited lever: reactivating lapsed high-LTV clients from the clinic's dormant list, plus membership conversion. _(Medspas are sitting on lists of people who got filler eight months ago and never rebooked.)_

### Clinical & compliance

- [ ] Chat listener operating during the consultation, generating a structured, HIPAA-compliant clinical note, integrated to the clinic's CRM/EMR via API.
- [ ] Post-care triage & anxiety management using the clinic's approved protocols (standard recovery-timeline questions); escalate anything related to complications to a human provider.
- [ ] HIPAA / BAA handling, contraindication screening, correct clinical handoff (the agent cannot prescribe, diagnose, or set treatment plans), audit-ready documentation of intake and consent.

### Verticalization

- [ ] Niche-of-the-niche bot per vertical: injectables-heavy clinics, laser / body-contouring, and hormone / TRT / GLP-1 clinics each have different call patterns, upsell paths, and compliance requirements.

### The gap to own (differentiator)

- [ ] **Closed-loop revenue attribution.** Current providers see the call and the booking-created event — but not whether the patient showed, what was performed, or what was collected, because they write _into_ the booking system and don't read the money event back _out_ of the POS. That means a standalone receptionist structurally cannot tell a clinic "this specific recovered call became $1,400 of booked-and-collected treatment." The solution must reconcile clicks → booked appointments → showed → spent in a single attribution view, and feed that back to the ad platforms — the capability Zenoti has today — **without enterprise pricing or lock-in.**

---

## Part 2 — Lead Generation

### Target niches, ranked by conversion speed

**Tier 1 — the ROI sentence writes itself**

1. **Medical weight-loss / GLP-1 programs.** The strongest combination on every axis. It's recurring, not one-shot — 40 active GLP-1 patients generate $14,000–$24,000 in monthly recurring revenue, and a mature program runs $15,000–$40,000 in monthly net within six months. Crucially, about 40% of GLP-1 medspa patients are completely new to the practice, so these leads arrive cold through paid ads — the front desk isn't built for the volume, and every missed call is a lost annuity, not a lost visit. Demand is enormous: GLP-1 programs are now offered at ~38% of US medspas, and 1 in 8 US adults have used one. The caveat is real: this is regulated intake (can't prescribe/diagnose, needs a BAA, medical-necessity documentation), so it converts fastest on ROI but is not the easiest to deliver cleanly.
2. **Hair restoration (PRP / PRF / exosome / transplant).** $3,000–$9,000 lifetime revenue per patient, with patients returning every 4–6 weeks, and demand surging partly because of GLP-1 shedding. Consult-driven and high-consideration, so it's inbound-call-heavy, and one recovered consult pays for the service for months.
3. **Body contouring (CoolSculpting / EmSculpt / Morpheus8).** Packages priced $2,000–$6,000 per area, 4–8 sessions, with strong upfront cash collection, and demand up ~22% year-over-year. Price-shopped hard over the phone ("how much is it?"), which means high call volume where each captured package is a huge ticket.

**Tier 2 — great pain, but more competition**

1. **Injectables-led medspas (Botox / filler / bioremodelers).** Highest raw volume — a Botox appointment generates $350–$550, and bioremodelers ($600–$1,200/session) are the fastest-growing injectable slice — with repeat and membership models. The catch: this is exactly the segment existing AI-receptionist vendors already target, and the most likely to be on Boulevard/Zenoti with native AI bundled in. Real pain, but you'd fight for it.
2. **Laser hair removal / laser clinics.** High volume, package-based, price-shopper-heavy — but already explicitly named and targeted by incumbents like AgentZap. Good economics, crowded lane.

**Tier 3 — adjacent or situational**

1. **TRT / men's health** — recurring and cash-pay like GLP-1, but the same (or heavier) controlled-substance compliance friction.
2. **IV therapy / wellness drips** — high volume but lower ticket and event-driven, so the per-call ROI is weaker and the yes is slower.
3. **Longevity / hormone-optimization clinics** — an early-mover window, but the category is still nascent, so demand is thinner.

### Targeting signals (signal-to-tool map)

The fast-close clinic has a firmographic signature. Score against these; don't filter on any one alone.

**Signal 1 — owner-operator who's also the provider.** No tool has this; it's people data. Sources: state nursing/medical-board license lookups (the clinic where the LLC owner's name equals the licensed injector's name), Instagram (the "@[name]aesthetics" account where the owner is the face doing the Reels), the website About page with a single provider bio, and a booking page listing one provider.

**Signal 2 — single location, 1–3 years old, scaling.** Domain age via WHOIS, formation date via Secretary of State filings, one pin on Google Maps, and review velocity (accelerating recent reviews = scaling). Then TheirStack's hiring signal on top.

**Signal 3 — heavy ad spender.** Best tool is free and public: the Meta Ad Library — search any clinic and see every active ad; filter by keyword and location to get the entire ad-spending medspa universe in a metro. Google's Ads Transparency Center does the same for search. Reinforce with pixel detection (a Meta Pixel or Google Ads tag on the site = they run paid) and landing-page-builder footprints (Unbounce, Instapage, LeadPages = they run funnels).

**Signal 4 — booking stack (on Mindbody/Vagaro/GHL, not Zenoti/Boulevard).** A pure web-crawl signal. BuiltWith and Wappalyzer detect it and sell "who uses X" lists — pull the universe of sites running a Vagaro / Mindbody / GoHighLevel booking embed, then subtract the Zenoti/Boulevard footprints. Zero-cost version: click the "Book Now" button and see where it points (book.mindbody.io, vagaro.com/…, leadconnectorhq.com for GHL). GHL is especially detectable — it leaves msgsndr/leadconnector footprints all over the page. _(Note: treat booking platform as a scoring attribute, not a hard include/exclude — the true exclusion is whether the clinic already runs a live AI receptionist.)_

**Signal 0 — no online booking at all.** Just a phone number and a Squarespace/Wix site, or a Square/Acuity/Booksy/Fresha widget. Arguably the hottest leads (most primitive front desk, most leakage) — and by definition they have no booking-platform footprint, so a whitelist approach makes them invisible. Pipeline below.

### Finding "no online booking" clinics with Apify

"No booking" is an _absence_ signal — you can't query it directly. Build the universe, detect booking presence on each, then keep the absences. The Maps scraper gives you the first filter for free.

The flagship actor (`compass/crawler-google-places`, plus cheaper clones) returns `bookingLinks` and `tableReservationLinks` arrays of `{name, url}` per place, alongside website, phone, category, hours, and review counts.

**Stage 1 — build the universe and take the free filter.** Run the Maps scraper across your target metros with several category queries so you don't miss segments:

```json
{
  "searchStringsArray": ["med spa", "medical spa", "weight loss clinic", "aesthetic clinic"],
  "locationQuery": "Austin, Texas",
  "maxCrawledPlacesPerSearch": 120,
  "language": "en"
}
```

For each result you get website, phone, and the `bookingLinks` / `tableReservationLinks` arrays. First cut, zero extra cost: anyone with a populated `bookingLinks` is bookable through Google's Reserve-with-Google — exclude those initially to catch the no-booking-platform crowd. Clinics whose `website` field comes back empty are the hottest bucket for voice agents — no site at all, phone-only front desk.

**Stage 2 — check the actual websites.** Most medspas run a Mindbody or Vagaro "Book Now" widget on their own site without ever wiring into Reserve-with-Google, so Google shows `bookingLinks: []` while the clinic is perfectly bookable. You have to visit the candidate sites. Feed the `website` values into a **rendering** crawler — `apify/website-content-crawler` or `apify/puppeteer-scraper`/`playwright-scraper`, **not** a plain Cheerio/HTTP scraper, because these widgets inject via JavaScript and a non-rendering crawler reports false "no booking."

Flag a site as _has booking_ if you find any known scheduler footprint — mindbodyonline, vagaro, leadconnector/msgsndr (GHL), acuityscheduling/squarespace-scheduling, calendly, squareup/book.squareup, booksy, fresha, schedulicity, setmore, jane.app, aestheticrecord, zenoti, blvd/getboulevard, mangomint, pabau, patientnow, aestheticspro — or a button/link whose text matches book/schedule/reserve/request-appointment pointing to an external scheduler. One distinction to encode: a plain contact form or "request an appointment" that just emails the clinic is **not** self-serve booking — those clinics stay in the target set (arguably warm, since they're collecting interest they then have to chase by phone).

**Smarter Stage 2 (LLM classification).** Instead of a brittle regex signature list, pipe each rendered page's text to an LLM:

```
Does this medspa site let a patient self-schedule via an online calendar/widget?
Return JSON: {has_online_booking: bool, method: 'widget'|'phone_only'|'contact_form'|'none', provider: string}
```

Apify runs this inline via its LLM actors, or export the dataset and classify in Clay.

**Gotchas.**
- Broad Maps queries cap at ~120 visible results per query — split by neighborhood and category and dedupe by place ID or phone, or you'll silently miss half a metro.
- Emails usually aren't in the default Maps payload — plan a second enrichment actor.
- Clinics that book through a Linktree in their Instagram bio show up as "no booking" in both stages even though they technically have a path. Known blind spot; accept it for a demand test.

### Additional trigger signals

1. **Front-desk job postings.** Set an alert for front-desk/receptionist roles at aesthetic clinics and you get a live feed of clinics feeling the phone strain right now — a clinic hiring a receptionist is announcing the exact pain the product solves.
2. **Google review mining for the leak.** Scrape each clinic's reviews for phrases like "couldn't reach anyone," "no one answered," "never called back," "left a voicemail and…" — each is documented, per-clinic proof of the leak and a strong outreach hook.
3. **GLP-1 launch detection.** The scaling trigger for the hottest niche: clinics that just added a "semaglutide / weight loss" page (diff their sitemap or run Wayback Machine comparisons) or just started running GLP-1 ads (the "first seen" date in Meta Ad Library).

---

## Part 3 — Highest-ROI niches for healdesk

The ROI of an AI front desk is basically: **revenue at risk per missed call × call volume / leakage × cash-pay margin × how fast the "yes" comes.** Ranked on that, with fertility and aesthetic surgery included.

> Figures below are approximate industry ranges, not precise quotes — worth firming up before they go on a sales deck.

**Tier 1 — the ROI sentence writes itself**

1. **Fertility / IVF & reproductive medicine.** The highest ticket in the entire list. One IVF cycle runs roughly $15k–$25k out of pocket, patients often do 2–3 cycles, and add-ons (ICSI, PGT, egg freezing) push lifetime value toward $40k–$60k+. Inbound is intensely high-intent and emotional — these patients research obsessively and call. A long consideration window with many touchpoints makes it a perfect nurture/reactivation use case. A single missed call can be a $25k journey walking to a competitor. Caveat: heavier compliance and often better-staffed front desks than a solo medspa — but per-lead value dwarfs everything else here.
2. **Plastic & cosmetic surgery (aesthetic chirurgie).** Rhinoplasty ~$8k–$15k, breast aug ~$8k–$12k, tummy tuck/BBL ~$10k–$18k, facelift ~$15k–$30k+. Cash-pay, consult-driven, aggressively price-shopped by phone — and the surgeon is in the OR while the phone rings out. One recovered consult is a five-figure case. Bonus: surgeons value the qualification layer that screens tire-kickers from serious consults.
3. **Medical weight-loss / GLP-1** (already Tier 1 in Part 2). Recurring revenue, ~40% brand-new patients arriving cold from ads, every missed call a lost annuity rather than a lost visit.
4. **Dental — implants, full-arch, ortho, cosmetic.** A rare high-ticket _and_ high-volume combo. Single implant ~$3k–$5k, full-arch (All-on-4) ~$20k–$50k per arch, Invisalign ~$4k–$6k. Colossal call volume, heavily price-shopped, and dental front desks are famously slammed. The high-ticket electives are largely cash/financed, so insurance friction is limited on exactly the cases that matter.

**Tier 2 — strong ROI, more friction or more competition**

5. **Hair restoration / transplant.** $3k–$9k+ per patient, recurring maintenance, consult-heavy — GLP-1 shedding is a tailwind. (Ranks Tier 1 in the medspa-only view in Part 2; sits at Tier 2 here because fertility, surgery, and dental outrank it on ticket.)
6. **LASIK / refractive & premium ophthalmology.** ~$2k–$4k per eye, elective, cash-pay, price-shopped, fast clean yes; premium cataract lenses extend the ticket.
7. **Cosmetic dermatology.** Overlaps medspa but standalone derm too — Mohs, cosmetic derm, high volume.
8. **Med spas / injectables / body contouring** — the existing core, sitting in Tier 2 here only because incumbents like Zenoti/Boulevard already bundle native AI in this lane. Real pain, contested lane.

**Tier 3 — good but situational**

9. **Concierge / functional / longevity medicine** — recurring cash-pay memberships, but nascent, thinner demand.
10. **Bariatric surgery** — $15k–$25k, but more insurance-gated and lower volume.
11. **TRT / men's health** — recurring cash-pay, but controlled-substance compliance friction.
12. **Vein / vascular cosmetic, IV therapy** — lower ticket or event-driven, weaker per-call ROI.
