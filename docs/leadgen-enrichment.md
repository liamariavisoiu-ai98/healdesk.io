# Turning 4,919 contacts into a launch segment

The end-to-end plan for `healdesk_leads.csv`, and how to run it.

---

## What the file actually is

Profiled before writing any code, because the shape of the list decides the plan.

| | |
|---|---|
| Rows | **4,919** contacts |
| Distinct clinics | **4,512** (by website domain) |
| Contact inflation | **1.09×** — mild, but not random |
| `website` populated | **100%** |
| `phone` populated | **21.3%** |
| `category` populated | **23.8%** — and 426 of those say *"Unresolved (opaque name, needs enrichment)"* |
| States covered | 54 |

**The decisive number is that last one.** Roughly **85% of the list has no usable
category**. Choosing a launch niche by counting the `category` column would mean
choosing on a 15% sample selected by whatever heuristic produced it — exactly the
"the count measures the scraper, not the market" failure.

That is why the pipeline crawls. The label has to come from what each clinic says
about itself, not from a directory tag that is mostly absent.

**The good news:** every clinic has an emailable contact, and they are
decision-makers — Owner 454, CEO 442, Founder 251, Business Owner 118, President
105. That is an unusually clean list for cold outreach.

---

## The pipeline

Four stages, each checkpointing to `packages/leadgen/data/`.

```
healdesk_leads.csv
        │
        ▼
 ┌──────────────┐   4,919 rows → 4,512 clinics
 │  1. DEDUPE   │   domain → phone → name+city
 └──────┬───────┘   best contact per clinic, by seniority
        ▼
 ┌──────────────┐   apify/website-content-crawler
 │  2. CRAWL    │   homepage + up to 3 service pages
 └──────┬───────┘   rendering browser, not plain HTTP
        ▼
 ┌──────────────┐   one forced label from a closed enum
 │  3. LABEL    │   + booking / weight-loss / chain signals
 └──────┬───────┘   + confidence
        ▼
 ┌──────────────┐   tally, honesty checks, per-segment CSVs
 │  4. REPORT   │
 └──────────────┘
```

### Why each stage is built the way it is

**1 — Dedupe on domain first.** It is 100% populated and a practice almost never
shares one. Phone is only 21% populated, so it can only be a fallback. Name
matching is last and includes the city, because "Radiance Med Spa" in two states
is two businesses.

The duplicates are not random: a clinic with two contacts in a database is one
big enough to have an office manager *as well as* an owner. Leaving them in tilts
the count toward multi-location practices — the slowest sale.

**Best contact per clinic** is chosen by title, because a second email to the same
clinic inside one sequence reads as a blast and burns the domain, not just the
lead. Owner/founder/CEO scores 100, clinician 90, practice manager 80, marketing
30 — a marketing contact does not own the phone line and will not champion a
spend they do not control.

**2 — A rendering crawler, not a fetch.** Most clinic sites are Wix, Squarespace
or a React theme where the service menu is client-rendered. A plain HTTP fetch
returns a shell with no services in it, so a non-rendering crawler produces
confident **false negatives** rather than obvious failures. That is the worst
error available here, because it looks like data.

Depth 1, 4 pages, policy and blog pages excluded. The homepage plus a service page
names the primary offering; going deeper multiplies cost across 4,500 domains for
very little extra signal.

**Sites that fail to load are kept, not dropped.** Discarding them would shrink
the denominator and flatter every segment's share.

**3 — One label, forced, from a closed enum.** Two rules, both so the output can
be *counted*:

- **Single label.** A clinic doing Botox, laser and a bit of CoolSculpting is one
  business and must occupy one bucket. Multi-label output cannot be tallied —
  every overlapping clinic inflates several segments at once, which is precisely
  the defect in the source `category` column.
- **Closed enum, validated on return.** An open question produces near-synonyms
  ("medspa", "med spa", "aesthetics") that look like different segments. Anything
  outside the enum is rejected rather than coerced, because a silently coerced
  label is a wrong row that looks right.

The tie-break for multi-service clinics is **what the homepage leads with** — the
clinic's own statement of its primary business, stable across crawls, and where
the marketing spend and inbound calls go. Two exceptions: a headline weight-loss
programme wins regardless (distinct intake conversation), and a surgical practice
wins over an attached med spa.

Sites with under 200 characters of text are labelled without an API call. Sending
an empty page to a model produces a confident guess from the business name — the
exact inference this pipeline exists to replace.

**4 — The report shows the count next to what makes it meaningful.** A bare tally
is what started this problem. So each segment is reported with its emailable
count, high-confidence count, phone-dependent share, chain share and state
spread — and the tool warns when:

- the largest segment is **not** the largest once low-confidence labels are
  dropped *(the ranking was never real)*;
- a segment clears the volume floor on paper but not in emailable contacts;
- over 25% of a segment looks chain-owned *(rows collapse to a few central
  buyers)*;
- a segment spans fewer than 8 states *(concentration is probably an artefact)*;
- under 40% lacks online booking *(a voice agent is worth least where booking has
  already left the phone)*.

---

## Running it

Credentials come from `packages/leadgen/.env`, which is gitignored and loaded
natively by Node — copy `.env.example` and fill in the Apify token.

For Anthropic, prefer `ant auth login` over a key: it stores a short-lived OAuth
profile the SDK resolves on its own, so there is no long-lived secret to keep
anywhere. The pipeline accepts either.

```bash
cp packages/leadgen/.env.example packages/leadgen/.env   # then add APIFY_TOKEN
ant auth login --no-browser                              # or set ANTHROPIC_API_KEY

npm run enrich -w @healdesk/leadgen -- --input ~/Downloads/healdesk_leads.csv
```

### Adding a second batch

Repeat `--input`. Give every list, every time — the first one included:

```bash
npm run enrich -w @healdesk/leadgen -- \
  --input ~/Downloads/healdesk_leads.csv \
  --input ~/Downloads/leads_batch2.csv \
  --batch --hours
```

`01-clinics.json` records which files it was built from. Given a different set
it re-dedupes across all of them, which is free and takes a second, and is
safe for everything downstream: a clinic's id is a hash of its domain, so a
clinic from the first list keeps its id and therefore keeps its crawl, its
label, its DNS probe, its booking-page fetch and its hours. **Only the clinics
the new file adds reach the paid stages.** The report says how many that is:

```
  8619 rows → 7371 clinics (3 unusable)
    healdesk_leads.csv               4919 rows   4512 clinics not in an earlier file
    leads_batch2.csv                 3700 rows   2859 clinics not in an earlier file
    132 clinics appear in more than one file — their contacts were merged, not duplicated.
```

*(illustrative numbers — the real overlap is printed by the run)*

Two consequences worth knowing before the run:

- **A clinic in both lists can change its primary contact.** Contacts are
  ranked by seniority across both files, so if batch 2 supplies the owner where
  batch 1 only had the office manager, the owner becomes `contacts[0]` and the
  manager moves to `second-contacts.csv`. Right, but if batch 1 has already
  been *sent*, diff `all-leads.csv` on `clinic_id` before loading it.
- **The two lists have different columns.** The first was a bespoke export
  (`website`, `first_name`, `jobTitle` …); the second is a raw Apollo export
  (`Website`, `First Name`, `Title` …). The format is detected from the header
  and mapped (`src/enrich/sources.ts`); a file that matches neither stops the
  run. Fed in unmapped, an Apollo file dedupes to zero clinics with no error —
  which is what made the mapping worth a hard stop rather than a warning.

Every row of every CSV now carries `source` (the file the *contact* came from)
and `clinic_sources` (every file that named the clinic), so a campaign can be
filtered to one batch and a bad row traced to the export it arrived in.

| Flag | Why |
|---|---|
| `--limit 200` | Crawl a sample first. **Do this before the full run.** |
| `--max-llm 500` | Hard cap on classification spend |
| `--force-crawl` | Redo the crawl, keep the dedupe |
| `--force-label` | Reclassify from the cached crawl — no Apify spend |
| `--batch` | Half the token price via the Batch API. Use on the full run. |

**Every stage checkpoints.** Crawling 4,500 domains costs real money and time; a
pipeline that loses that because stage three threw is one nobody runs twice.
Re-running is free, and `--force-label` lets you iterate on the classification
prompt without re-crawling.

### What it costs

Classification runs on **Haiku 4.5** ($1/$5 per million tokens), because this is
a closed-enum label against text already in front of the model — the hard part is
the crawl, not the judgement.

| | 4,512 clinics |
|---|---|
| Haiku 4.5, streaming | **~$14** |
| Haiku 4.5, `--batch` | **~$7** |
| *(Sonnet 5, for comparison)* | *~$43* |

Plus the Apify crawl, which is the larger and less predictable line — budget on
their current compute-unit rate for ~4,500 rendered page loads at depth 1.

`--batch` is half price because batches are not latency-guaranteed: most finish
within an hour, the ceiling is 24. For a job you read the next morning, paying
double for speed is a straight waste. Use the streaming path for the `--limit`
sample, where you want the evidence column in front of you immediately.

Prompt caching does **not** help here and is deliberately not used: the system
prompt is ~700 tokens and Haiku 4.5's minimum cacheable prefix is 4,096, so a
`cache_control` marker would silently never fire.

### Output

```
packages/leadgen/data/
  01-clinics.json          deduped clinics with ranked contacts, + the input files it came from
  02-crawl.json            page text per domain
  03-labels.json           segment + confidence + signals
  03b-dns.json             { probed, findings } — booking vendors seen in DNS
  03b2-pages.json          { attempted, findings } — vendors behind the clinic's own booking link
  03c-hours.json           Google opening hours (only with --hours)
  report.json              the tally
  segments/
    injectables.csv        ← contact-ready, one row per clinic
    weight-loss-glp1.csv
    body-contouring.csv
    excluded.csv           chains, not-a-clinic — no copy, kept apart on purpose
  unreadable-leads.csv     sites that could not be read: one touch, honest copy
  second-contacts.csv      the second person at a clinic — a later wave, never day one
  all-leads.csv            everything contactable, with `list` saying which of the three
```

Every stage is incremental on `clinic_id` (or domain, for DNS). Adding a list
re-runs only what the new clinics need; `--force-<stage>` redoes a stage for
everyone. The DNS and booking-page files were once hit-only arrays, which
could not tell "probed, nothing found" from "never probed" — an old-format
file is read fine, and clinics crawled before the current run are assumed
probed, since every earlier run swept the whole set.

Each CSV is campaign-ready: best contact, segment, confidence, and the evidence
line that decided the label, so a sample can be spot-checked by eye.

`data/` is gitignored. Scraped business data is not patient data, but it does not
belong in version control either.

---

## Reading the result

**Rank on the high-confidence column, not the total.** If those disagree, the raw
count is being carried by clinics we could barely read.

**Then apply the criteria that actually decide value** — see
[state-of-play.md](./state-of-play.md), Part 3:

1. **Defection probability** — would the caller have gone elsewhere? This *is* the
   product's value.
2. **Phone share** — a veto for the voice agent, not for the account: a clinic that
   books by Instagram DM is a buyer for the Meta bot. The `phone_dependent` column is
   the proxy.
3. **Config homogeneity** — can one agent config serve hundreds?
4. **Consultation-gating** — a consult is a low-commitment yes.
5. **Owner-operator** — the `job_title` column already tells you.
6. **Volume floor** — ~600–800 emailable clinics. A **floor**, not a target.
7. **Ticket size** — pass/fail only. At the August price of $249/month,
   break-even was under one booked appointment per month for every med spa
   segment, so it screened nothing *within* med spa. The packages now run
   $397–1,197/month plus a setup fee (`packages/catalog/src/plans.ts`); redo the
   break-even against the package a segment would buy before relying on it.

**Two expected traps, both flagged automatically:**

- **Laser/skin will probably be large and is the wrong pick** — chain-dominated
  (Milan 400+, LaserAway ~200, Ideal Image 140+), so many rows collapse to a few
  central buyers who already run call centres, and it has the lowest lifetime
  value of any segment.
- **Injectables will probably be largest and is the strongest pick anyway**, on
  the only transaction-level evidence available: 78% of ~20,000 appointments
  booked by phone rather than online. Its weakness is loyalty — target the
  *first-time* caller in the copy, not "never miss a call".

---

## After the segment is chosen

The segment id is a **shared contract**, not just a label. It lives in
`packages/catalog/src/segments.ts` and is used by:

- the enrichment pipeline, to classify a clinic;
- the chat agent's knowledge tree (`apps/web/src/lib/knowledge/index.ts`), to pick a
  branch.

So the segment a cold email targeted is the same string that selects the bot's
knowledge when that person lands on the site. Two enums that drifted would
silently send GLP-1 traffic to a generic bot.

---

## Before the first email goes out

Not part of this pipeline, but on the same critical path:

1. **Verify the emails.** The list has never been validated; bouncing into fresh
   domains wastes the warmup you have already paid for.
2. **Send from real domains with real sender names.** California §17529.5 is
   **$1,000 per email**, private right of action, strict liability on the
   advertiser — and the invented-persona-on-a-lookalike-domain pattern is the
   pleaded fact pattern. A real domain, a real person and a real address removes
   it at no cost to deliverability.
3. **Have something honest to sell.** BAA 1.0.0 is approved. What stands
   between today and an honest subscription is the spec's launch gates and its
   copy changes: no follow-ups, reminders, text-back or SMS, no "live in two
   minutes", no unqualified "HIPAA compliant", and a set-up promise stated per
   channel ([v1-product-spec.md](./v1-product-spec.md), "Copy and pricing changes
   this scope requires"). Discovery calls, design-partner slots and a demo are
   honest today.
