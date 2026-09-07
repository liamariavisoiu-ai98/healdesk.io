# Step by step, in order

Everything outstanding, sequenced. Each step says what to run, what you should
see, and what it unblocks.

Current state: **248 tests in `apps/app`, 10 in `apps/web`, 15 in
`packages/connectors`**, CI green, both apps building.

---

## A — This week, no external dependency

### A1. Run the lead enrichment sample

The niche choice is blocked on this and nothing else. Your `category` column is
23.8% populated with 426 of those saying *"Unresolved"* — so ~85% of the list has
no label and there is nothing to count.

```bash
cd ~/projects/healdesk.io
export APIFY_TOKEN=...
export ANTHROPIC_API_KEY=...

# Sample first. ~200 domains, a few dollars, ten minutes.
npm run enrich -w @healdesk/leadgen -- \
  --input ~/Downloads/healdesk_leads.csv --limit 200
```

**What you should see:** a segment table, then warnings, then per-segment CSVs
under `packages/leadgen/data/segments/`.

**Then do this before spending more.** Open `injectables.csv`, read twenty
`evidence` values against the `website` column, and check the label is right. If
the classifier is wrong you find out for a few dollars instead of across 4,500
domains.

```bash
# Happy with the sample? Run the rest. Crawl is the expensive part.
npm run enrich -w @healdesk/leadgen -- --input ~/Downloads/healdesk_leads.csv
```

**Reading it:** rank on the **high-confidence** column, not the total. If those
two disagree the tool says so — the raw count is being carried by clinics it
could barely read.

*Unblocks: the niche choice, the campaign copy, and which knowledge branch the
site should lead with.*

---

### A2. Verify the email list

4,919 addresses, never validated, about to be sent into ten freshly warmed
domains. Bouncing burns the warmup you have already paid for.

Any of NeverBounce, ZeroBounce or MillionVerifier. Drop anything not
`deliverable`. Expect to lose 10–20%.

*Unblocks: sending at all, safely.*

---

### A3. Decide the sender identity — this is a legal decision, not a deliverability one

Your runbook plans 30 invented personas across 10 lookalike domains.

**California Bus. & Prof. Code §17529.5: $1,000 per email, private right of
action, strict liability on the advertiser.** Falsified sender information is the
pleaded fact pattern, and invented names on lookalike domains is what that
describes. California is a large share of 4,500 US med spas — call it 600. At
$1,000 each that is **$600,000** from one motivated plaintiff.

Sending from a domain you own, with a real person's name, a real reply-to and a
real physical address in the footer removes the fact pattern **at no cost to
deliverability**. Do that.

*Unblocks: sending without an unpriced tail risk.*

---

### A4. Ship the two remaining funnel-stoppers

Already fixed: the proxy path, email verification, membership on invite accept,
console authorisation, the invite email, key rotation.

Still open, and both need a decision from you rather than code:

- **`HEALDESK_EMAIL_TRANSPORT`** is unset, so no email is actually sent. Set it
  to `ses` once the AWS sending domain and DKIM are verified (B2 below). Until
  then the invite logs instead of sending, which is honest but not a product.
- **`approvedByCounsel` still gates nothing.** The production gate keys on
  `baa_signed_at`, which a signature on the *draft* satisfies. Either wire it or
  correct the docstring — do not leave a claimed safeguard that is not there.

---

## B — Accounts, 1–3 weeks, run in parallel

### B1. Synthflow — confirm the US cluster and ask the tier question

You have the US single-region cluster now, which fixes the storage warranty. Two
things still open:

1. **Check your existing workspace's region.** Admin → Workspace Settings →
   Preferences → Customer Region. If it says **Global**, that workspace stores in
   the EU and cannot be migrated — you need a new one on US before any patient
   data.
2. **Ask whether the BAA is available below Enterprise.** Their published BAA has
   no tier gate, but it says "executed at contract signing". This decides whether
   break-even is ~2 clinics or ~24.

Text to send is in [blockers-runbook.md](./blockers-runbook.md) §1.

### B2. AWS BAA — 15 minutes, free

Artifact → Agreements → **Account agreements** → BAA → Download (accepts the NDA
first) → **Accept agreement**. Full click path in the runbook §2.

Then, and this is the part that makes the contract sentence true:

```bash
aws sesv2 put-configuration-set-delivery-options \
  --configuration-set-name healdesk-phi --tls-policy REQUIRE
```

`SesTransport` reads that back and refuses to send unless it is `REQUIRE` — so
the BAA's "we will not transmit over a channel that cannot negotiate encryption"
is enforced at runtime, not just asserted on paper.

### B3. Counsel — the thing that gates revenue

Send them [state-of-play.md](./state-of-play.md) Part 1. It is a
subparagraph-by-subparagraph review of the clause library against
45 CFR 164.504(e), with the three blocking gaps already fixed and the drafting
done. Their job is now review, not authorship.

Phase 1 only: **the BAA, the covered-entity determination method, and the CIPA
posture.** Those three interlock and all three block shipping.

Add the §17529.5 question from A3 — it is fifteen minutes for someone who does
this.

### B4. Insurance — bind something small now

Claims-made policies only cover incidents after the retroactive date, so every
unbound day is a day no future policy will ever cover. A modest $1M/$1M combined
tech E&O + cyber, bound now, locks a retro date you carry forward.

Ten questions to send every broker are in the runbook §7. **Do not compare on
price until you have the endorsement schedule by form number** — the exclusion
that denies your claim arrives by endorsement with a reassuring name.

---

## C — The engineering that makes it a product

### C1. Connect a voice vendor to the ingest path

**The highest-leverage task in the repo.** `lib/voice/ingest.ts` is built and
tested — `classifyRecovery` and `classifyBooking`, idempotent on the platform's
call id. What is missing is the webhook that calls it with real Synthflow
payloads, which needs their post-call shape.

Until a call writes a `conversations` row, every monthly report reads **$0.00**
for every customer, and attribution, reconciliation and the whole pitch are
correct code fed by nothing.

Two things to get right when you wire it:

- **`clinics.callRouting`** must be set per clinic during onboarding.
  `conditional` (their line rings first) means every answered call is recovered.
  `always` (we are the primary number) means only after-hours and callbacks are.
  The default is `conditional`; the other default would silently mark a clinic's
  entire call volume as recovered.
- **`clinics.openingHours`** must be collected, or `after_hours` can never be
  established and every recovery downgrades to `rang_unanswered`. Still counted,
  less informative.

### C2. Point the chat demo at a niche

The tree is live. The route accepts `practice` and `niche` alongside
`specialtyId`, both validated against the shared enum and both falling back
safely.

What is left is the UI: let the visitor pick, and pass it. `nichesFor(practice)`
gives the sensible options for a practice type — it will not offer IV therapy to
a dental practice.

The ids are the same strings the enrichment pipeline classifies into, so a cold
email targeting `weight-loss-glp1` can deep-link straight to that branch.

### C3. The database findings from the audit

Untouched, and none of them block launch:

- Migration 0019's backfill silently updated zero rows under FORCE RLS, then
  dropped the source column.
- The BAA gate sits on state the gated role can write — `healdesk_app` holds
  unrestricted `UPDATE` on `clinics`.
- `baa_acceptances` has no RLS, and the 0016 column grant lets any tenant session
  rebind any organisation's signed BAA.
- `rls-drift.test.ts` never verifies a policy actually references `clinic_id`.

---

## What NOT to do yet

- **More niches in the site UI.** One tuned branch plus the generic root is
  right; build the rest against campaign feedback.
- **SOC 2.** $20–45K against a $2,988–9,588 ACV, and single-location clinics do
  not ask. The trigger is buyer type — a PE-backed group — not revenue.
- **More connector adapters.** Boulevard is Enterprise-tier-gated, will not sign
  a BAA with an integrator, and three of its clauses bar the core mechanic.
- **Selling a subscription.** No longer blocked on the BAA. Template 1.0.0
  ships `approvedByCounsel: true` (published 2026-09-05) and renders
  `approvedPreamble()`, which carries no draft warning, and `provisioning.ts`
  throws if an unapproved template is ever current. What still gates a $249/month
  subscription is delivery, not paper: `provisioning.ts` pins every new clinic to
  `synthetic`, so there is nothing to sell yet.
