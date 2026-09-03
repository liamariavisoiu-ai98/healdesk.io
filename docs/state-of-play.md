# State of play — 2 September 2026

> **This is a dated audit, not the task list.** Written 2 Sep 2026. Parts of Part 5
> have since been done, and the open findings below now live in
> [handover.md](./handover.md) § 3, which is the list to work from. Keep this for
> the reasoning — the CFR coverage matrix, the defect analysis, and the niche
> argument are not summarised anywhere else.

*(updated the same day: the fixes below have landed — see "What changed" at the end)*

Where healdesk actually stands, what the BAA review found, and what to do next in
what order.

Produced from a 38-agent audit that read the source rather than the docs, plus an
adversarial pass over every regulatory claim. Where a doc and the code disagreed,
the code won and the doc is listed as a defect.

---

## The one-paragraph version

The foundation is genuinely strong — better than most funded startups ship. The
tenant isolation is real, the encryption is correctly bound, the money arithmetic
is exact, and the reasoning in the comments is sound. **And almost none of it is
connected to anything.** Nothing writes a `conversations` row, so every attribution
report computes zero for a real clinic. There is no voice integration of any kind.
Three small bugs mean the self-serve funnel cannot complete today. And the BAA that
gates the whole product is a draft that disclaims itself in its own body while the
checkout is live enough to take money.

The gap is not "more features". It is **connection, and a lawyer**.

---

## Part 1 — The BAA review

I am not a lawyer and this does not substitute for one. What follows is the review
a careful engineer can do: map every clause against the regulation it is supposed
to discharge, and read the promises against what healdesk can actually deliver.

### Coverage against 45 CFR 164.504(e)(2)(ii)

| Subparagraph | Requirement | Status |
|---|---|---|
| (A) | Not use or disclose except as permitted | ✅ `permitted-uses` |
| (B) | Appropriate safeguards, Subpart C for ePHI | ⚠️ present, drops the purposive tail |
| (C) | Report impermissible use/disclosure and breaches | ⚠️ present, no timeline |
| (D) | Subcontractor flow-down | ⚠️ present, wrong grammatical mood |
| (E) | Make PHI available per §164.524 (access) | ❌ **switched off for non-CE** |
| (F) | Available for amendment per §164.526 | ❌ **switched off for non-CE** |
| (G) | Accounting of disclosures per §164.528 | ❌ **switched off for non-CE** |
| (H) | Comply as a CE where carrying out CE obligations | ❌ **absent entirely** |
| (I) | Records available to the Secretary | ✅ `records-to-hhs` |
| (J) | Return or destroy at termination | ✅ best-drafted clause in the file |
| (iii) | Termination for material breach | ⚠️ narrower than the rule, and buried |

### The three blocking defects

**1. Three mandatory subparagraphs vanish on a checkbox.** The `patient-rights`
clause carries `appliesWhen: (v) => v.isCoveredEntity !== false`. A clinic that
answers "no" to the covered-entity question signs an agreement with **none** of
(E), (F) or (G). The compliance of the document is made contingent on a legal
self-diagnosis by a med spa owner — and cash-pay clinics that occasionally submit
one electronic claim are exactly the population most likely to answer it wrong.

There is no upside to the gating. If the clinic genuinely is not a covered entity,
the clause imposes an obligation that is never triggered, at zero cost.

> **Fix:** predicate becomes `ALWAYS`. This is my error and it is the single most
> dangerous construct in the library.

**2. (H) is missing entirely** — from the clauses and from the explainer. It
requires that where the BA carries out a *covered entity's* obligation, it meets
the covered-entity standard, not the lighter BA standard. That is live here, not
theoretical: the outbound clause has healdesk sending messages *"on the clinic's
behalf and in its name"*.

**3. The breach-reporting clause defers its own timeline to a document that will
never exist.** It says *"The executed agreement will state the timeline"* — but in a
click-through funnel **this is the executed agreement**. Worse than silence, because
silence would default to the 60 days §164.410(b) allows, whereas a promise of a
future number invites the argument that the click-through was never the integrated
agreement, which undercuts the whole evidentiary design.

Commercially it fails too: the clinic's own 60-day clock under §164.404 may start
on the day *healdesk* discovered the breach. No covered entity's counsel accepts 60.

> **Fix:** state real numbers — 5 business days for an impermissible use, 5 calendar
> days for a breach — and carve out routine unsuccessful security incidents
> (blocked sign-ins, port scans) or the clause generates noise nobody reads.

### The defect that worries me most

**Every promise in this document is stronger than what healdesk holds upstream.**

| The BAA tells the clinic | What is actually true |
|---|---|
| "stored in United States infrastructure" | Synthflow's default **Global cluster stores in the EU**, permanently |
| "encrypted in transit" | SES defaults to **opportunistic TLS** and silently sends cleartext |
| Subcontractors "are bound by the same restrictions" | Twilio won't sign below Security Edition; Boulevard won't sign at all |
| No liability cap at all | Synthflow caps at **~$150**, Boulevard at **$100** |

That is the classic business-associate failure: uncapped downstream promises
backed by capped upstream ones. Two of those sentences would be **false on the day
of signature** today.

### Three more that a lawyer will flag on sight

- **Silence on §164.504(e)(4) hurts you, not the clinic.** Those uses — proper
  management and administration, carrying out your own legal responsibilities, data
  aggregation — exist *only if the contract grants them*. `permitted-uses` as drafted
  affirmatively forecloses them, which means you cannot retain PHI to defend yourself
  in a suit brought by a patient.
- **The preamble calls the clinic "Covered Entity" in all three branches**, including
  the branch whose own clause says it may not be one. And a document titled *Business
  Associate Agreement* signed with a non-covered entity is not void, but it is a
  representation that can be held against you. That variant should be a data
  protection addendum with a different name.
- **"DRAFT — NOT FOR EXECUTION" plus a collected signature plus a UI banner reading
  "Business Associate Agreement signed"** is the worst of the three available
  configurations. It almost certainly forms no contract, and it presents as executed.

### Two things I claimed in comments that are not true of the code

- **`approvedByCounsel` gates nothing.** My docstring says provisioning refuses
  production classification while it is false. It does not — provisioning hardcodes
  `synthetic`, and the database gate keys on `baa_signed_at`, which a signature on
  the *draft* satisfies. Either wire it or correct the comment; as written a future
  reader takes it for a guarantee the system does not provide.
- **The assent label is client-supplied and never validated** against
  `BAA_ASSENT_LABEL`, despite that constant existing precisely so the words on the
  button cannot drift. Two test fixtures already disagree with it.

### The explainer

Fact-checked against the verbatim subparagraphs: **the citations are right**,
including the subtle one — item 4 correctly moves the security-incident duty to
§164.314(a)(2)(i)(C) rather than leaving it in §164.504. Defects are narrowing
qualifiers dropped ("of which it becomes aware", "where applicable") and the same
(H) omission. But it **promises rights the non-CE buyer will not get**, because it
renders unconditionally while `patient-rights` does not.

### On HHS's sample provisions

Still published, last reviewed 16 June 2017. HHS disclaims it explicitly: *"This is
only sample language and use of these sample provisions is not required for
compliance with the HIPAA Rules."* A drafting aid, **not a safe harbour**.

---

## Part 2 — What is actually built

~25,600 lines across 16 commits and four weeks.

### Genuinely done and sound

- **Tenant isolation.** `withTenant()` is transaction-scoped `set_config(..., true)`
  that cannot leak across a pooled connection. All 13 `clinic_id` tables are RLS
  ENABLED *and* FORCED with a policy on each. The runtime role is proven
  NOBYPASSRLS by test. Both SECURITY DEFINER functions pin `search_path` correctly.
- **Envelope encryption.** AAD bound to `{clinicId, credentialId}`, enforced on the
  single `open()` path, identity taken from the caller's arguments rather than the
  row — so relocated ciphertext genuinely fails.
- **Append-only records by GRANT, not convention.** Audit log, suppressions, BAA
  acceptances. Migration 0016's column-scoped `GRANT UPDATE (organization_id,
  bound_at)` is correctly scoped — the signature is physically immutable.
- **The pure functions.** Integer-cents money, DST-aware period maths via `Intl`,
  upserts correctly targeting partial unique indexes.
- **Agreement-before-payment is genuinely enforced server-side.** `/api/provision`
  rejects any request without a real, unbound agreement row. There is no route to an
  account without one.

### Built but connected to nothing

- **Nothing writes a `conversations` row.** So `recovery_reason` is always null,
  `recoveredBookings` is always 0, and **every monthly report computes zero** for a
  real clinic. The attribution engine, the matcher, the reports — all correct, all
  fed by nothing.
- **Nothing starts a sync.** No cron, no `boss.schedule()`. The only enqueue site is
  a webhook path unreachable because no registered adapter implements `parseWebhook`.
- **Zero lines of voice or telephony.** No Synthflow, Twilio, Bandwidth or Deepgram
  anywhere in the tree.
- **No email is ever sent** by any code path — while the checkout success screen
  tells the buyer one was.
- **Three modules are tested thoroughly and called by nothing**: opening-hours
  classification, the TCPA contact gate, report delivery.

### Three bugs that stop the very first user

| Bug | Effect | Status |
|---|---|---|
| `/api/agreements` missing from the proxy's self-authenticating list | the BAA could never be signed in a deployed environment | ✅ **fixed in this commit** — one line, my bug |
| `grantOwnerMembership()` has zero callers | an invited owner gets an account but no membership row, so no clinic page opens | ❌ open |
| `requireEmailVerification: true` with no `sendVerificationEmail` | every sign-in returns `EMAIL_NOT_VERIFIED`, forever | ❌ open |

### The defects that would corrupt customer-visible numbers

- **Reconciling one period auto-resolves every open exception from every other
  period** — and closes the whole queue when a period has none.
- **The `coverageStartedAt` caveat trips the PHI guard**, so the report it belongs on
  can never be delivered.
- **The PHI guard never scans the HTML body** — only the text parts.
- **Rate budgets never fire.** The `Throttle` is constructed per sync run, so the
  daily counter always restarts at zero. The budgets that "shape the architecture"
  are inert.
- **A connection is marked `active` with `last_verified_at` set although nothing was
  verified.**

### Database-layer findings

- **Migration 0019's backfill silently updated zero rows.** It runs as the table
  owner against a FORCE-RLS table with no tenant GUC set, then drops the source
  column. Irreversible, silent loss of exactly the figure the product is sold on.
- **The BAA gate sits on state the gated party can write.** `healdesk_app` holds
  unrestricted `UPDATE` on `clinics`, so a tenant session can set its own
  `baa_signed_at`. And `app_enforce_baa_gate()` is the one function with no pinned
  `search_path`.
- **The gate covers only the four tables that existed in 0004** — `webhook_events`,
  whose `raw_payload` the migration's own comment calls PHI, was never added.
- **`baa_acceptances` has no RLS at all**, and the 0016 column grant lets any tenant
  session rebind any organisation's signed BAA.
- **`rls-drift.test.ts` checks less than it claims** — it never verifies a policy
  actually references `clinic_id`.

### Testing

**230 tests collected, 159 run.** The other 71 silently `describe.skip` when
`TEST_APP_URL` is unset — and they are every tenant-isolation, RLS-drift,
BAA-immutability, TCPA, provisioning and sync test. There is no CI. The 31% that
skips is the 31% that decides whether the product may hold patient data.

The single largest untested control is **`resolveTenantContext()`** — the only thing
deciding which clinic id goes into the RLS GUC. RLS cannot defend it, because RLS
trusts whatever id it is handed. Zero tests.

### Console authorization

**There is none beyond "has a valid session."** Any authenticated user can enumerate
every clinic through the SECURITY DEFINER function, toggle platform-wide jobs, and
mint invitations into the internal ops org — which is the only credential sign-up
requires.

---

## Part 3 — The niche question

**"Pick the subcategory with the most leads" is the wrong rule**, and your own
two-bot plan is what makes it wrong.

### The structural argument

If you ship a tuned bot *and* a generic "other services" bot, the generic bot already
harvests the largest bucket at acceptable quality. The largest med spa bucket is also
the **most generic** one — which is exactly the bucket a generic bot serves least
badly. So pointing the tuned bot at it buys the smallest quality delta over the
fallback you were shipping anyway, while leaving the specialised segments — where a
generic bot visibly fails — served by the weak bot.

**You don't have to choose between volume and value.** The generic bot captures the
volume, the deliverability feed and the fast feedback from the big bucket. The tuned
bot should go where tuning earns most.

### Three further problems with counting

1. **"Most leads" is not a well-defined count.** Maps and Apollo tags are
   *multi-label*, not a partition — one clinic carries "botox", "medical spa",
   "laser hair removal" and "weight loss" simultaneously. Any tally double-counts,
   and two buckets can share most of their members.
2. **Rows are not clinics.** Contact-to-account inflation runs 1.0–6.4× depending
   purely on how each export was pulled. Your 4,900 may be far fewer clinics, and
   the inflation is uneven *across segments* — enough to invert the ranking.
3. **Bucket size measures the scraper.** Your own playbook specifies the search
   strings, and broad Maps queries cap at ~120 results per query — so the largest
   segments are silently truncated to the cap while smaller ones are captured whole.
   The "biggest" bucket may just be the one that clusters in the metros you scraped
   hardest.

### The argument you expected to be decisive isn't

Break-even recovered appointments per month to cover the $249 plan:

| Segment | Ticket | Break-even /mo |
|---|---|---|
| Laser hair removal, small area | $75–150 | 1.7–3.3 |
| Botox session | $400–750 | 0.33–0.62 |
| Med spa average visit (AmSpa) | $536 | 0.46 |
| GLP-1, six-month course | $1,800–2,400 | 0.10–0.14 |
| Body contouring plan | $1,723–3,170 | 0.08–0.14 |

Except for single-area laser, **every med spa segment pays for the plan on well under
one recovered appointment a month.** Ticket value is a screen everything passes, not
a discriminator. Use it to justify med spa *against other verticals* — not to choose
within it.

### What actually drives value: defection probability

The product only recovers revenue when the unanswered caller would otherwise have
been **lost**. So value = ticket × margin × **probability the caller defects** — and
the third term varies far more across segments than the first two.

A repeat Botox patient who gets voicemail calls back tomorrow. She has a
relationship, a preferred injector, no urgency. Defection is near zero, so the
recovered-revenue claim is close to false for that call. A first-time
body-contouring or weight-loss shopper ringing round comparing prices books whoever
answers. Defection approaches one.

This also predicts where your monthly report will read as credible and where it will
read as over-claiming — and that report is the entire retention mechanism.

### Ranked criteria

1. **Defection probability** — this *is* the product's value
2. **Phone share of booking** — a veto criterion; if they book by Instagram DM a voice agent is structurally irrelevant
3. **Config homogeneity** — decides whether this is software or consultancy; the criterion you are most likely to underweight
4. **Consultation-gating** — a consult is a low-commitment yes, and a clean bot-to-human handoff
5. **Owner-operator decisions** — 81%+ of med spas are single-location, and the owner *is* the provider missing the calls
6. **Deliverable list volume** — a **floor** (~600–800 deduped, verified clinics), not a quantity to maximise
7. Ticket value — pass/fail screen only
8. No-show economics — retention argument, weak for acquisition
9. Seasonality — tie-breaker

### The two research passes disagreed, which is useful

**Injectables** (recommended by the economics pass) has the only *transaction-level*
evidence of phone dependence available: Mangomint's analysis of ~20,000 injectable
and filler appointments in its own software found **21.89% booked online, 78.11% by
phone, in person or recurring**. Largest procedure volume in US aesthetics
(9.88M neuromodulator treatments, ASPS 2024), >90% independently owned, one decider,
fast close.

**GLP-1 / medical weight loss** (recommended by the selection pass) has exceptional
config homogeneity — the intake is near-scripted everywhere — plus high defection
and a natural consult gate.

**My read: injectables, with the defection weakness handled in the copy.** The
evidence quality is not close — one is transaction data, the other is reasoning. And
GLP-1 carries a live business risk: FDA delisted tirzepatide (Dec 2024) and
semaglutide (Feb 2025) from the shortage list, ending most compounding, so those
clinics are both the riskiest to serve and the likeliest to churn mid-contract.

But the defection argument is real and cuts against injectables. Handle it by
targeting the **new-patient** call specifically in the copy — not "never miss a
call" but "the first-time patient who called at 6:40pm and booked with someone else".

**Both passes agree on the trap: laser hair removal.** Likely your biggest bucket
and the worst possible fit — dominated by chains (Milan 400+, LaserAway ~200, Ideal
Image 140+) that already run call centres, so several hundred rows collapse to a
handful of central buyers, with the lowest lifetime ceiling of any category.

### Run this against your 4,900 before writing any bot config

1. **Dedupe to one row per clinic** — place_id, then normalised phone, then
   registrable domain.
2. **Force a single primary label** per clinic by crawling the homepage and
   `/services` and classifying with an LLM into a fixed enum. **Never count tags.**
3. **Measure the artefact** — cross-tab each segment by originating search string and
   metro; discount any segment concentrated in one string.
4. **Phone-share proxy** — share of clinics with no self-serve online booking.
5. **Defection proxy** — share with an active Meta Ad Library presence, plus
   review-mining for "no one answered", "never called back".

Steps 1–2 alone may reorder the buckets and change the answer.

---

## Part 4 — Sequencing

### The good news: campaign versus compliance is a false choice

`docs/outreach/run-log.md` records the programme at **"HOLD — pre-flight gate NOT
CLEARED"**: zero of 10 domains registered, zero of 30 mailboxes provisioned. Adding
warmup (2–3 weeks), the ≥85% seed-placement gate, and a ramp sized for the real
volume, **the first email is ~3 weeks out and the last is ~10 weeks out** from
authorising spend today.

The entire compliance backlog fits inside the warmup window, at a carrying cost of
about $189/month.

**The sequencing is inverted:** the work you believe is blocking (two chatbots) is
largely built — six specialties already drive the chat and voice demos. The work that
is actually blocking — domains, list verification, counsel-approved BAA, vendor BAAs
— has not started.

### The real risk is not a cold lead

It is that **checkout is live enough to take money for a service the database refuses
to let a clinic use**, under a BAA whose own preamble reads *"DRAFT — NOT FOR
EXECUTION… does not create a business associate relationship"*, while `provisioning.ts`
pins every new clinic to `synthetic` regardless of what the buyer chose.

Burning a lead costs one row in 4,900. Selling an undeliverable service under a
self-disclaiming contract is an FTC Section 5 fact pattern and is not recoverable by
apologising. **The FTC banned Air AI — an AI voice agent sold to small businesses —
in March 2026.**

Delay the *ask*. Do not delay the *conversation*: discovery interviews, design-partner
slots and an ungated demo are all honest today, and they would answer the niche
question you are currently guessing at.

### One exposure the docs underweight

**California Bus. & Prof. Code §17529.5** carries **$1,000 per email** in liquidated
damages with a private right of action and strict liability on the advertiser — a
larger and more likely exposure than CAN-SPAM. The disposable-domain-plus-invented-
sender-name pattern in the runbook is the pleaded fact pattern. Get this in front of
counsel with the BAA work.

---

## Part 5 — What to do, in order

### Now — this week, no external dependency

1. **Fix the three funnel-stoppers.** Proxy path (done), `grantOwnerMembership`
   wiring, email verification. Without these nobody can sign in, ever.
2. **Fix the BAA blockers**: `patient-rights` → `ALWAYS`, add the (H) clause, put
   real numbers in the breach timeline, add the §164.504(e)(4) own-use clause.
3. **Soften the three unsupportable warranties** to what is true today — or make them
   true. "US infrastructure" is false while the Synthflow workspace is on Global.
4. **Wire `approvedByCounsel` to actually gate**, or correct the comment. Do not
   leave a claimed safeguard that does not exist.
5. **Validate the assent label** against the constant.
6. **Turn on CI with the database.** 71 skipped tests that decide PHI-handling is not
   a test suite, it is a hope.
7. **Add authorization to the console.** Any account is currently an ops account.

### Next — 1 to 3 weeks, unblocks everything downstream

8. **Engage counsel.** Phase 1 from the runbook: BAA + covered-entity determination +
   CIPA posture. This gates the product's ability to exist. Send them this review.
9. **Ask Synthflow Condition 0** and check your cluster. If it is Global your data is
   in the EU permanently and you need a new workspace before anything else.
10. **Accept the AWS BAA.** 15 minutes, free.
11. **Register the outreach domains** and start warmup — the clock is 3 weeks and it
    runs in parallel with everything above.
12. **Run the niche decision procedure** against the 4,900.

### Then — the thing that makes the product a product

13. **Connect the voice agent so something writes a `conversations` row.** This is
    the single highest-leverage engineering task in the repo. Every downstream
    system — attribution, reconciliation, reporting, the entire pitch — is correct,
    tested, and fed by nothing. Until a call produces a row, the monthly report
    reads $0.00 for every customer.

### Deliberately not now

- More niches. One tuned bot plus one generic is right; build the rest against
  campaign feedback.
- SOC 2. $20–45K against a $2,988–9,588 ACV, and small clinics do not ask.
- More connector adapters. Boulevard is Enterprise-tier-gated and will not sign a
  BAA with you; the catalog still sells it as "One click".


---

## What changed after this review

Everything in this section was fixed in the follow-up commit. The findings above
are left as written, because a review that quietly edits itself once the bugs are
gone is not a record of anything.

### The BAA

| Was | Now |
|---|---|
| `patient-rights` predicated on `isCoveredEntity !== false` | **`ALWAYS`**, and split into (E) access, (F) amendment, (G) accounting as separate lettered obligations with a ten-business-day window |
| (H) absent | New `acting-in-your-place` clause — where healdesk carries out an obligation the Privacy Rule places on the clinic, it meets the *covered entity's* standard |
| "The executed agreement will state the timeline" | **Real numbers**: 5 business days for an impermissible use, 5 calendar days for a breach, plus a carve-out for routine unsuccessful incidents so the clause does not generate noise nobody reads |
| "encrypted in transit" (flatly, and false) | Narrowed to what we control, plus an explicit promise **not to transmit over a channel that cannot negotiate encryption** — and `SesTransport` now reads back the configuration set and **refuses to send unless `TlsPolicy=REQUIRE`** |
| Subcontractors "**are** bound" (a statement of fact, and untrue) | A **covenant**: before healdesk sends any patient information to a subcontractor, it will have obtained that subcontractor's written agreement. Plus a subprocessor list and notice before adding one |
| No liability cap at all | New `liability` clause: 12× monthly fee, **carved out for wilful misconduct, gross negligence and breach-notification costs** — and it says out loud that upstream vendors cap far lower and we are not passing that through |
| "United States infrastructure" unsupportable | ✅ **Now true** — Synthflow ships a US single-region cluster. Stays true only while every subprocessor is pinned to a US region, which is a standing commitment, not a one-off |

Two clause notes worth keeping in mind. The liability number is a **placeholder** and
is the single most likely thing counsel changes — what is load-bearing is the
carve-out and the disclosure, not the multiplier. And the subcontractor clause still
cannot discharge §164.504(e)(5): that governs the healdesk-to-vendor paper, and only
actually holding those BAAs satisfies it.

### The code

| Fixed | What it was |
|---|---|
| `/api/agreements` in the proxy bypass | The BAA could never have been signed in a deployed environment |
| `requireEmailVerification: false` | With no verifier configured it blocked **every** sign-in permanently. Redundant anyway — the invitation link already proves control of the address |
| New `lib/access.ts`, called from the Better Auth `after` hook | Accepting an invitation now marks it accepted, creates the org `member` row, and grants `clinic_memberships` for every location. Previously a user signed up successfully and landed on a console with no clinics |
| `grantOwnerMembership()` deleted | Superseded, and it had zero callers |
| `requireInternalStaff()` on every ops surface | The console was gated on "has a session", so **every clinic customer was also an operator** — able to enumerate every clinic, toggle platform-wide jobs, and mint invitations into the internal org |
| New `lib/voice/ingest.ts` + migration 0022 | **Something finally writes a `conversations` row.** Idempotent on the platform's call id, with `classifyRecovery()` deciding recovery at ingestion from observable facts |
| `lib/email/invite.ts`, wired into provisioning | The invitation email the checkout screen has always claimed to send. Only on a fresh provision, never on a Stripe replay |
| PHI guard now scans the HTML body | It watched the part recipients never read and ignored the part they do |
| Coverage caveat is long-form, not ISO | `2026-07-15` matched the guard's date-of-birth pattern, so the guard refused to send the very report the caveat belonged on |
| `sync.test.ts` clock pinned | It asserted on fixture data landing in the *current* calendar month — failing on early-month days and passing the rest of the time |
| `.github/workflows/ci.yml` | Provisions the two-role Postgres, migrates, runs everything, and **fails the build if fewer than 200 tests pass** — so the security suite can never silently skip to green again |

**242 tests passing, all of them actually running.**

### The recovery classification is the piece to scrutinise

`classifyRecovery()` is the one judgement in the ingestion path, and it decides the
number a clinic judges us on. The rule it enforces: a value goes in **only** if the
clinic genuinely would not have handled the contact.

- A call answered during opening hours on a free line is **not** recovered — even if
  it booked. Counting it would inflate the exact figure we ask to be trusted on.
- No opening hours on file returns **null, not `after_hours`** — otherwise missing
  configuration manufactures revenue.
- A malformed schedule is a config bug, not evidence of recovery.
- A callback outranks after-hours, because "we rang them back" is the stronger claim.
- The **clinic's** timezone decides, so a west-coast practice is not billed recovery
  for calls its own front desk was sitting there to answer.

### Still open

- **The clause text is still not counsel-approved.** `approvedByCounsel` remains
  `false` and every document still says DRAFT in its body. What changed is that
  counsel's job is now much smaller and much better specified.
- **`approvedByCounsel` still gates nothing in code** — the production gate keys on
  `baa_signed_at`, which a signature on the draft satisfies. Either wire it or
  correct the docstring; do not leave a claimed safeguard that is not there.
- **The assent label is still client-supplied** and never compared to
  `BAA_ASSENT_LABEL`.
- **No voice vendor is connected to the new ingest path.** The module and its
  classification are done and tested; the webhook that calls it with real Synthflow
  payloads is not written, because it needs the vendor's payload shape.
- **The database-layer findings** — 0019's silent zero-row backfill, the BAA gate
  sitting on state the gated role can write, `baa_acceptances` having no RLS — are
  untouched.
