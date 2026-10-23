> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E8: the demo pipeline report (now) and the sales page (plan only)

Read at main 2e258ae9, repository untouched. Everything here is business contact data on the
apps/web side; nothing touches PHI, apps/app's database or the R1/R2 rails. The only apps/app
contact is R3, the typed ops envelope, and only where marked.

## 1. Current state (verified in code)

- **`/admin/crm`** is an iframe of the marketing Sheet (`apps/web/src/app/admin/crm/page.tsx`): no
  pipeline, no stages, no board, by design.
- **`/admin/demos`** (`admin/demos/page.tsx`, `actions.ts`) is the builder plus the 50 newest
  `demo_sessions` rows with a status chip and four per-row actions (Email, Release anyway, Retry,
  Rebuild). **No totals, no conversion, no per-source view.**
- **The register** is the `demo_sessions` tab (`lib/sheets/schema.ts` L310, `lib/demo/sessions.ts`).
  `created_by` is the source: an operator's address, `"webhook"` (POST `/api/demo-sessions`, an
  Instantly reply rule) or `"homepage"` (`/api/own-demo`). The Stripe webhook stamps
  `claimed_status`/`claimed_plan` and posts to Slack. **Stall** = building/auditing over 8 minutes
  (`DEMO_BUILD_STALL_MS`), seen only on page render, retried only by hand, never alerted (alerts
  exist for held, flagged, homepage-failed, claimed). **Purge**: unclaimed rows go 30 days after
  expiry (cron `purge-leads`), so a window over 37 days has lost its denominator.
- **Other lead sources**: the chat-demo gate → `leads` (`source_campaign` from the cold email's
  `c=`); "Tell us about your clinic" → `setup_requests`, whose setup link is the only door while
  `HEALDESK_CHECKOUT_MODE` is pilot (`lib/checkout-mode.ts`, `/admin/setup`); the contact form →
  email only, no row; nurture (`lib/email/nurture.ts`, Day 7 offers the 100% cohort credit); cold
  lists from `packages/leadgen` (CSV, offline). `scripts/funnel-report.ts` is the only
  cross-source funnel, by hand.
- **Money**: `/api/checkout` builds one subscription Session (setup fee + $0 placeholder month) and
  picks the one credit server-side (`chooseSetupOffer`, `lib/billing.ts` L193: cohort > demo 50/30
  > site 30). The agreement is sealed into the Sheet **before** pay (`/api/agreement`,
  `lib/checkout/records.ts`); the account exists only on the first `invoice.paid` relayed to
  `/api/provision` with both sealed records. Stripe products exist by `lookup_key`
  (`scripts/stripe-setup.ts`); apps/app can raise a one-off invoice on an existing customer
  (`chargeOneOffInvoice`, `lib/billing/stripe-actions.ts` L372). No Payment Link exists, and no
  invoice path for a clinic that does not exist yet.
- **Digest and Slack**: the 07:00 digest is apps/app's (`lib/ops/digest.ts`); apps/web counts reach
  it by relay ops (`relayEmailQuota`). Slack is `postInternalAlert` (`lib/demo/alert.ts`).

## 2. The demo pipeline report (build now)

**Numbers** (`lib/demo/pipeline.ts`, pure, over `listDemoSessions(500)`): for 7 and 30 days,
*requested · built · live now · held · failed · stalled now · expired unclaimed · claimed*;
median build time (`ready_at − build_started_at`); share emailed. **Conversion by source** =
claimed ÷ built for `operator`, `outreach` (webhook) and `homepage`, with the `leads` tab joined
by `lead_email` so a claimed demo also names its `source_campaign`. Anything the Sheet could not
read prints as an em-dash, never a zero (`components/admin/honesty.test.ts` rule).

**Where it lives**: one row at the top of `/admin/demos`, and the same row on the admin home as
E1 lays it out: `Demos · 7d: 12 requested → 9 built → 2 claimed (22%) · 1 stalled [Retry] · 3 live
· by source: operator 2/5, outreach 0/3, homepage 0/1`. It replaces nothing; the list below stays.
One line in the 07:00 digest through a new R3 relay op `demoPipeline` (counts only, no address):
optional, E1 decides whether the digest takes it.

**Stalled builds**: new column `retry_count` (appended to `demo_sessions`, the schema allows
appending). A sweep `GET /api/cron/demo-sweep` (hourly if the Vercel plan allows sub-daily
crons; else it also runs from the `/api/demo/[slug]/status` poll, which a waiting visitor already
drives) retries each stalled build **once**, posts `Demo build stalled: <name>, retried` to Slack,
and after a second stall posts `needs you` and emails hello@ (`problemNotice("failed")` already
exists). The row's button becomes `Retry all stalled` beside the count.

## 3. The sales page (PLAN ONLY, future session)

**Stages, five, plain words**: **New** (a lead arrived from any source) → **Demo** (built or sent)
→ **Talking** (they replied, a call is set) → **Offer sent** (setup link or offer out, with its
clock) → **Won** (paid; the card leaves for Ops with its clinic id). *Lost* is an archive flag with
a reason, not a stage.

**One board**: five columns, cards only. A card shows clinic name, website host, source chip
(outreach campaign / homepage / demo / setup request), days in stage, the offer clock when one
runs (48 h or 14 d left), one line of *next step* with a due date, red when overdue. Click opens a
drawer: a timeline merged from `leads`, `lead_events`, `demo_sessions`, `setup_requests` and
`checkout_intents` (index columns only; sealed records never opened), and the actions. Identity
is the normalised email; an operator demo with no email cannot merge until one is typed.

**Moving**: drag between columns, or one `Advance` button; both call one server action
`moveCard(cardId, stage)`. A move may offer, never silently run: into Demo → *Build demo*
(`requestDemo`); into Offer sent → *Send setup link* (`sendSetupLink`) or *Compose offer*; any
move → *Set next step* (a task). **Won is never set by hand**: only the Stripe webhook's
conversion moves a card there, so the board cannot claim a sale the ledger does not hold.

**The offer composer** (HubSpot's "invoice", in our shape): package, voice and chat steps,
interval; it shows the setup fee, the credit that applies and when it ends, and sends an expiring
link that opens the existing checkout with the package pre-chosen. Prices are the Stripe products
`stripe:setup` made; the credit is the one `chooseSetupOffer` would pick, so board and checkout
cannot disagree, and the 50% never leaves `/admin`. **A Stripe Payment Link or bare Invoice cannot
be the sale**: neither signs the agreement first nor carries the intent and sealed records the
provisioning gate needs, so a payment through one is money with no account. All roads stay: offer
link → `/api/checkout` → Session → `invoice.paid` → `/api/provision`. A custom one-off price to an
**existing** clinic reuses `chargeOneOffInvoice` through a new R3 op, from the Ops card.

**Data**: one new Sheet tab `pipeline`, append-only like `seo_step_ticks`: `id, card_key
(email_normalized), stage, moved_at, moved_by, next_step, due_at, lost_reason, source`. Newest row
per card is its state, so no transaction is needed. No new store, no apps/app table. Reads cache
60 s (four tabs per render against the ~60/min quota).

**Risks**: Sheet quota and row growth (fine to ~2,000 cards); drag needs client JS in a console
built on plain forms; two operators racing on one card (append-only: the later wins, visibly);
board emails must pass `canEmail` and stay one-to-one replies, never a campaign; the board must
not become a second truth for money.

## 4. Guardrails and conflicts

- **OWNER DECISION, custom discounts**: the owner's "custom payment links if needed" collides with
  CLAUDE.md pricing: per product, steps of 100, one setup credit at a time, 48 h, server-decided.
  Closest keeper: an *operator offer*, a per-card setup-fee percentage with an expiry, recorded on
  the card and applied by `chooseSetupOffer` as a fifth offer; never a custom monthly price, never
  stacked. Where it ranks (above or below cohort) is the owner's call.
- **OWNER DECISION, Payment Links**: none for the sale (above). Allow for nothing, or only for
  non-account charges to an existing clinic through apps/app.
- Claims: the board is ours, behind `/admin`; it may show our setup fee and plan price. It never
  prints "booked value", "revenue" or a client's numbers; `markConverted`'s MRR stays internal.
- Outbound: every board email is a reply to a request or a one-to-one operator note from
  hello@healdesk.io through Resend; nurture and cold outreach stay where they are. Nothing here
  contacts a patient.
- Spec: nothing needs a spec change; "Stage 1, payment" is honoured by routing every sale through
  the existing checkout. The spec's open item "manual invoice fallback" (Open items table) is a
  clinic-to-patient question, not this.
- Map: `retry_count` and the `pipeline` tab are settings, not keys; a sub-daily cron is a
  `vercel.json` change and a note on the cron tool's story in `system-map.ts`.

## 5. Build order

| # | Step | Size | Proof | Files |
| --- | --- | --- | --- | --- |
| 1 | `lib/demo/pipeline.ts` + row on `/admin/demos` | S | unit test on fixed rows: counts, by-source, em-dash on read failure | `lib/demo/pipeline.ts(+test)`, `admin/demos/page.tsx` |
| 2 | Same row on the admin home (E1 slot) | S | honesty test renders em-dashes when `ok:false` | `components/admin/*`, `admin/page.tsx` |
| 3 | `retry_count` + sweep + `Retry all stalled` + Slack/hello@ | M | test: stalled row retried once, second stall alerts, running row untouched | `sheets/schema.ts`, `demo/sessions.ts`, `api/cron/demo-sweep/route.ts`, `vercel.json`, `admin/demos/actions.ts`, `system-map.ts` |
| 4 | R3 `demoPipeline` relay + digest line (if E1 takes it) | S | ops-client parse test; digest payload test | `admin/ops-client.ts`, `apps/app/lib/ops/api.ts`, `ops/digest.ts` |
| CRM-A | `pipeline` tab, list view by stage, `Advance`, Won from webhook | M | tab provision test; webhook test moves card to Won | `sheets/schema.ts`, `lib/crm/*`, `admin/crm/page.tsx`, `api/webhooks/stripe/route.ts` |
| CRM-B | Board with drag, drawer timeline, next step and overdue Slack line | M | server action rejects an unknown stage and a hand-set Won | `admin/crm/*`, `lib/crm/*` |
| CRM-C | Offer composer with pre-chosen package on the setup link; operator offer if approved | L | checkout test: link opens the chosen package, credit matches `chooseSetupOffer` | `lib/setup-link.ts`, `lib/setup-links.ts`, `api/checkout/route.ts`, `lib/billing.ts`, `catalog/plans.ts` |
| CRM-D | Durable by-source conversion past the purge (`demo_events` tab) | S | purge test keeps events | `sheets/schema.ts`, `demo/sessions.ts` |

Steps 1–3 are independent of every other design; step 4 and CRM-A touch the webhook and
ops-client, where E1 and E4 also work.

## 6. Open questions (owner)

1. May an operator set a per-card setup-fee percentage, and does it rank above the cohort credit?
2. Stripe Payment Links: none at all, or only for charges to an existing clinic?
3. Is one card per email address right, and should the contact form start writing a row?
4. Should the board replace the Sheet frame at `/admin/crm`, or sit beside it?
5. Which Vercel plan runs production: does it allow an hourly cron for the stall sweep?
