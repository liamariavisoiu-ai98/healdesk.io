# Lead Generation Playbook

> Split from the original working doc (Part 2). See [archive/](./archive/).
> Implemented in [`packages/leadgen`](../packages/leadgen).

---

## Targeting signals (signal-to-tool map)

The fast-close clinic has a firmographic signature. **Score against these; don't filter on
any one alone.**

### Signal 1 — owner-operator who's also the provider

No tool has this; it's people data. Sources:

- State nursing/medical-board license lookups — the clinic where the LLC owner's name
  equals the licensed injector's name
- Instagram — the `@[name]aesthetics` account where the owner is the face doing the Reels
- Website About page with a single provider bio
- Booking page listing one provider

### Signal 2 — single location, 1–3 years old, scaling

- Domain age via WHOIS
- Formation date via Secretary of State filings
- One pin on Google Maps
- **Review velocity** — accelerating recent reviews = scaling
- TheirStack's hiring signal on top

### Signal 3 — heavy ad spender

Best tool is free and public: the **Meta Ad Library** — search any clinic and see every
active ad; filter by keyword and location to get the entire ad-spending medspa universe in
a metro. Google's Ads Transparency Center does the same for search.

Reinforce with:
- Pixel detection (a Meta Pixel or Google Ads tag on the site = they run paid)
- Landing-page-builder footprints (Unbounce, Instapage, LeadPages = they run funnels)

### Signal 4 — booking stack (on Mindbody/Vagaro/GHL, not Zenoti/Boulevard)

A pure web-crawl signal. BuiltWith and Wappalyzer detect it and sell "who uses X" lists —
pull the universe of sites running a Vagaro / Mindbody / GoHighLevel booking embed, then
subtract the Zenoti/Boulevard footprints.

Zero-cost version: click the "Book Now" button and see where it points
(`book.mindbody.io`, `vagaro.com/…`, `leadconnectorhq.com` for GHL). GHL is especially
detectable — it leaves `msgsndr`/`leadconnector` footprints all over the page.

> **Note:** treat booking platform as a **scoring attribute, not a hard include/exclude**.
> The true exclusion is whether the clinic already runs a live AI receptionist.

### Signal 0 — no online booking at all

Just a phone number and a Squarespace/Wix site, or a Square/Acuity/Booksy/Fresha widget.

Arguably the **hottest leads** — most primitive front desk, most leakage — and by
definition they have no booking-platform footprint, so a whitelist approach makes them
invisible. Pipeline below.

---

## Finding "no online booking" clinics with Apify

"No booking" is an **absence** signal — you can't query it directly. Build the universe,
detect booking presence on each, then keep the absences. The Maps scraper gives you the
first filter for free.

The flagship actor (`compass/crawler-google-places`, plus cheaper clones) returns
`bookingLinks` and `tableReservationLinks` arrays of `{name, url}` per place, alongside
website, phone, category, hours, and review counts.

### Stage 1 — build the universe and take the free filter

Run the Maps scraper across your target metros with several category queries so you don't
miss segments:

```json
{
  "searchStringsArray": ["med spa", "medical spa", "weight loss clinic", "aesthetic clinic"],
  "locationQuery": "Austin, Texas",
  "maxCrawledPlacesPerSearch": 120,
  "language": "en"
}
```

For each result you get website, phone, and the `bookingLinks` / `tableReservationLinks`
arrays.

**First cut, zero extra cost:** anyone with a populated `bookingLinks` is bookable through
Google's Reserve-with-Google — exclude those initially to catch the no-booking-platform
crowd. Clinics whose `website` field comes back empty are the **hottest bucket** for voice
agents — no site at all, phone-only front desk.

### Stage 2 — check the actual websites

Most medspas run a Mindbody or Vagaro "Book Now" widget on their own site without ever
wiring into Reserve-with-Google, so Google shows `bookingLinks: []` while the clinic is
perfectly bookable. **You have to visit the candidate sites.**

Feed the `website` values into a **rendering** crawler —
`apify/website-content-crawler` or `apify/puppeteer-scraper`/`playwright-scraper` — **not**
a plain Cheerio/HTTP scraper, because these widgets inject via JavaScript and a
non-rendering crawler reports false "no booking."

Flag a site as *has booking* if you find any known scheduler footprint:

> mindbodyonline · vagaro · leadconnector/msgsndr (GHL) ·
> acuityscheduling/squarespace-scheduling · calendly · squareup/book.squareup · booksy ·
> fresha · schedulicity · setmore · jane.app · aestheticrecord · zenoti ·
> blvd/getboulevard · mangomint · pabau · patientnow · aestheticspro

…or a button/link whose text matches book/schedule/reserve/request-appointment pointing to
an external scheduler.

**One distinction to encode:** a plain contact form or "request an appointment" that just
emails the clinic is **not** self-serve booking — those clinics stay in the target set
(arguably warm, since they're collecting interest they then have to chase by phone).

### Smarter Stage 2 (LLM classification)

Instead of a brittle regex signature list, pipe each rendered page's text to an LLM:

```
Does this medspa site let a patient self-schedule via an online calendar/widget?
Return JSON: {has_online_booking: bool, method: 'widget'|'phone_only'|'contact_form'|'none', provider: string}
```

Apify runs this inline via its LLM actors, or export the dataset and classify in Clay.

### Gotchas

- Broad Maps queries cap at **~120 visible results per query** — split by neighborhood and
  category and dedupe by place ID or phone, or you'll silently miss half a metro.
- **Emails usually aren't in the default Maps payload** — plan a second enrichment actor.
- Clinics that book through a **Linktree in their Instagram bio** show up as "no booking"
  in both stages even though they technically have a path. Known blind spot; accept it for
  a demand test.

---

## Additional trigger signals

1. **Front-desk job postings.** Set an alert for front-desk/receptionist roles at
   aesthetic clinics and you get a live feed of clinics feeling the phone strain right
   now — a clinic hiring a receptionist is announcing the exact pain the product solves.

2. **Google review mining for the leak.** Scrape each clinic's reviews for phrases like
   *"couldn't reach anyone"*, *"no one answered"*, *"never called back"*, *"left a
   voicemail and…"* — each is documented, per-clinic proof of the leak and a strong
   outreach hook.

3. **GLP-1 launch detection.** The scaling trigger for the hottest niche: clinics that
   just added a "semaglutide / weight loss" page (diff their sitemap or run Wayback
   Machine comparisons) or just started running GLP-1 ads (the "first seen" date in Meta
   Ad Library).

---

## Compliance note on prospecting data

Scraped clinic data is business firmographic data, not PHI — it does not belong in the
BAA-covered boundary and must not be co-mingled with patient data. Keep it in
`packages/leadgen/data/` (gitignored) or your CRM. Review mining touches
patient-authored public reviews; do not import review text into any system that stores
patient records. See [hipaa-compliance.md](./hipaa-compliance.md).
