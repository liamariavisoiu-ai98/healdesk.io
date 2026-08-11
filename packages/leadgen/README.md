# @healdesk/leadgen

Prospecting pipeline implementing [docs/leadgen-playbook.md](../../docs/leadgen-playbook.md).

Finds clinics whose front desk is most likely leaking calls, scores them against the
fast-close signature, and writes a ranked CSV.

**This never touches the PHI boundary.** Clinic firmographics are business data, not
patient data, and must not be co-mingled with `apps/app`.

---

## Setup

```bash
export APIFY_TOKEN=apify_api_...
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm run discover -w @healdesk/leadgen -- --location "Austin, Texas"

# Narrow the categories
npm run discover -w @healdesk/leadgen -- \
  --location "Miami, Florida" \
  --queries "med spa,plastic surgery,fertility clinic"

# Raise the classification cap for a full sweep
npm run discover -w @healdesk/leadgen -- --location "Phoenix, Arizona" --max-llm 200
```

Output: `packages/leadgen/data/<location>.csv` — gitignored.

---

## How it works

| Stage | What it does | Why |
| --- | --- | --- |
| 1. Universe | Apify Google Maps scraper across several category queries | One query misses whole segments |
| 1b. Free filter | Read `bookingLinks` off the Maps payload | A populated array = Reserve-with-Google, definitively bookable. Empty proves nothing. |
| 2. Render | `apify/website-content-crawler` on Playwright for anything unresolved | Booking widgets inject via JS — a non-rendering crawler reports false "no booking" |
| 3a. Footprint | Match ~18 known scheduler signatures | Fast and free for the common vendors |
| 3b. Classify | Claude, structured output, for pages the footprint pass can't settle | Catches unlisted and self-hosted schedulers the regex list would miss |
| 4. Score | 0–100 against the fast-close signature | Score, never filter — no single signal should gate inclusion |

### Two scores, not one

`score` answers **"how easy is this clinic to sell to"**. `integration_score` answers
**"if they buy, can we prove what we earned them"**. These used to be one number, and they
disagree: Zenoti and Boulevard clinics are the hardest sell — both bundle their own AI —
and the cleanest integrations by a distance. Collapsing them lost whichever half mattered
at the moment you looked.

The playbook is also explicit that booking platform is a **scoring attribute, not a hard
include/exclude**. The real disqualifier — *does this clinic already run a live AI
receptionist* — is not something any of these signals can see.

---

## Trigger signals

Two signals that say *now*, rather than *eventually*.

### Ad spend (Signal 3)

Detected from the same rendered HTML the Stage 2 crawler already fetches, so it costs
nothing extra — and it produces the strongest angle we have.

The distinction that matters is **analytics vs conversion tracking**. Google Analytics on
a page means they measure traffic. A Meta pixel firing `fbq('track', …)` or a Google
`AW-` conversion id means they are *buying* it, and have already decided a new patient is
worth paying for. Only the second justifies the ad-spend pitch.

A tag is evidence of intent, not proof of current spend — pixels outlive the campaigns
that installed them. But it never produces a false *negative* for an active advertiser,
because you cannot run conversion tracking without one. Verify before sending: the CSV
carries a Meta Ad Library link per prospect, which is free, public, and authoritative.

> **Must be rendered HTML.** Tag managers inject these scripts client-side, so a plain
> HTTP fetch reports "not advertising" for a clinic spending five figures a month — the
> exact prospect we most want.

### Front-desk hiring

A clinic posting for a receptionist is publicly announcing the pain the product solves, at
the moment budget is approved and a decision is live. The comparison is concrete: a
front-desk hire is **$47,000–58,000 a year loaded for 40 hours a week**; we cover 168.

Titles matched include patient care coordinator, front desk associate, medical
receptionist and scheduling coordinator — with clinical and out-of-industry lookalikes
(*patient care technician*, *hotel front desk*) explicitly excluded.

Unlike the firmographic signals this one **decays**. A posting older than 45 days, or one
we cannot date at all, is marked stale and never used as an opener — leading with a filled
role tells the owner we haven't looked at them since.

Company matching is deliberately conservative, and strips generic words so two unrelated
"Med Spa"s don't match. A false positive here tells an owner we saw them hiring when they
weren't, which destroys the credibility the signal was meant to buy.

Job-board actors differ enough that hard-coding one would mean rewriting this the first
time it changes, so `searchFrontDeskPostings()` takes the actor id and a mapper.

---

## The outreach angle

A scored list is half the job. Two clinics can score identically and need completely
different first sentences — one is burning ad budget on calls that ring out, the other is
about to sign a $50k employment contract.

Every prospect gets an `angle`, chosen by how *specific the proof is*, with the evidence
and a link a human can check before sending:

| Angle | When | Opens with |
|---|---|---|
| `paid-traffic-leak` | Conversion-tracked ads, especially with no online booking | They're buying traffic that can only book by phone |
| `hiring-front-desk` | Fresh front-desk posting | Worth seeing what the same money buys in coverage |
| `no-booking-path` | No self-serve booking | Every new patient has to get through on the phone |
| `high-demand-no-capture` | 4.5★+ and 40+ reviews | Demand isn't the constraint; answering it is |
| `generic-leakage` | Nothing specific found | Labelled low-confidence, on purpose |

**The paid-traffic angle is the one to build the campaign around.** A clinic running
conversion-tracked ads has already done the hard part — deciding a patient is worth paying
for. The gap is that paid traffic arrives on two channels and they only instrumented one:
the website has a pixel, a funnel and a conversion event, while the phone has whoever
happens to be free. Position the agent as the **capture layer for traffic they already pay
for**, not as a receptionist. That reframes the cost from headcount to media efficiency —
a budget that already exists and is already being spent.

### What the pipeline does not cover

Printed at the end of every run so a CSV is never mistaken for the whole picture:

- **Signal 1** — owner-operator who is also the provider (license lookups, Instagram, About page)
- **Signal 2** — domain age (WHOIS), formation date (Secretary of State)
- **Signal 3** — ad spend (Meta Ad Library, Google Ads Transparency Center, pixel detection)
- **Triggers** — front-desk job postings, review mining for *"no one answered"*, GLP-1 launch detection

**Known blind spot:** clinics that book through a Linktree in their Instagram bio read as
"no booking" in both stages. Accepted for a demand test.

**Known caps:** broad Maps queries return ~120 results max — split by neighbourhood and
dedupe. Emails aren't in the default Maps payload; plan a second enrichment actor.

---

## Cost knob

Stage 3b calls `claude-opus-5` once per ambiguous page, with structured outputs at `low`
effort. `--max-llm` caps how many run (default 50), and any skipped pages are reported
rather than silently folded in.

If you're sweeping whole metros and per-page cost matters more than edge-case accuracy,
the model in [`src/classify.ts`](./src/classify.ts) is the knob — this is a narrow,
high-volume classification, which is the one shape where a smaller model is genuinely
defensible. Left at Opus by default; change it deliberately, not by accident.
