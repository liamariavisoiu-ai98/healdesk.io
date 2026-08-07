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

### Scoring is not filtering

The playbook is explicit that booking platform is a **scoring attribute, not a hard
include/exclude**. A clinic on Zenoti scores lower (native AI likely bundled) but stays in
the set. The real disqualifier — *does this clinic already run a live AI receptionist* —
is not something any of these signals can see.

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
