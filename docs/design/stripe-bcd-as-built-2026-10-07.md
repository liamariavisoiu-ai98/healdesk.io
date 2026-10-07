# The rest of the Stripe launch, as built (7 October 2026)

This is the record of what the Stripe session built after the owner said
"resume" on 6 October 2026. It covers Packages B, C and D and Package E's ops
console billing panel, plus the billing email templates, all built to:
- `docs/design/funnel-portal-contracts-2026-10-06.md`;
- the amendments agreed with the funnel session that day (no subscription
  schedules, billing by channels in service, no setup-fee refund, a 30-day
  setup window);
- the owner's decision the same day to bill overage in blocks of 100.

Precedence is unchanged: `docs/v1-product-spec.md` wins, then the approved
funnel plan, then this record, then `docs/design/stripe-launch-2026-10-05.md`.
That design's A1, A2 and portal screens were superseded by the funnel plan.

Where this record and the code disagree, the code is right: it was tested, and
this was written from it.

## Release gate: the overage copy

The new metered prices bill per started block of 100 units. Until the Terms
(§3), the pricing page and the funnel's Review & pay line say so, **do not run
`stripe:setup` on live**: it archives the per-minute and per-conversation
prices those pages still describe. The funnel session writes that copy from
the catalog's `OVERAGE_BLOCK_UNITS` and `overageBlockCents` once this build is
on main. Production checkout opens only through setup links that ops mints, so
nobody buys on the per-unit wording unless we hand them a link.

## What a clinic's money does, start to finish

1. **Checkout (funnel session).** The setup fee, plus a $0 monthly line
   (`healdesk_plan_start_placeholder_month`). There is no Stripe trial anywhere:
   Stripe would print "TRIAL OVER" on the first charge.
2. **The first invoice** (`subscription_create`) activates the clinic and records
   the setup fee paid (gross), whatever its total. It opens no allowance window
   and sends no email; the funnel's welcome covers it.
3. **The first patient answer.** The engine calls
   `startPlan(tx, clinicId, "first_answer")`, which only records a request. The
   billing worker then swaps the $0 line for the price of the package matching
   the channels in service:
   - billing_cycle_anchor `now`, proration `none`, `allow_incomplete`,
     `off_session`;
   - the card moves to the customer's default, so a card replaced in the
     Customer Portal is the one charged;
   - Stripe charges the first period inside that call.
4. **The first plan invoice's `invoice.paid`** stamps `plan_started_at`, opens the
   allowance window and sends L2 (`plan_started`). A failed charge sends
   `payment_failed` instead, and the clinic goes into dunning.
5. **Later channels.** Each one's first answer steps the price up
   (`stepUpPackage`): monthly plans are prorated onto the next invoice, annual
   plans are invoiced at once, and no setup fee is charged again. A channel that
   is ready on our side but waiting on the clinic joins 30 days after the later
   of its readiness and the plan start, with L4 a week ahead. A step-up never
   drops a channel already billed.
6. **Renewals** reset the window and send a receipt. Overage is billed per started
   block of 100 units:
   - monthly plans report single units to Stripe's meters, and the metered
     prices' `transform_quantity` turns the period's total into started blocks;
   - annual plans get one invoice per closed month.
   "Stop and fall back" bills no overage at all.
7. **The 30-day setup window.** With no channel live by the end of the 30th
   day, the reconcile records a closure. The worker re-checks for a live channel
   at the last moment, then cancels the subscription with no refund and no
   proration. The funnel's offboarding sends the closure email.
8. **Refunds** follow Terms §5. Within 14 days of the plan start, the first
   period's subscription fees are refunded and the plan cancelled. Under the
   first-month guarantee, one month's fee is refunded. The two never stack, and
   the setup fee is never refunded.

## The parts

| Package | What | Main files |
|---|---|---|
| S0 | Ledger, writers, payload types, stubs | migrations `0050_stripe_bcd` and `0053_stripe_bcd_review`, `lib/billing/{entitlements,notices,requests}.ts`, `lib/identifier-ref.ts` |
| B | Answer gate, usage, chat threads, Meta/voice wiring, usage alerts | `lib/billing/{answering,usage,usage-alerts}.ts`, `lib/chat/threads.ts`, the Meta route, `lib/voice/*` |
| C-events | Stripe webhooks: invoice classification, dunning and end notices, restore rules, sweep, renewal reminders | `lib/billing/events.ts`, `lib/scheduler/{billing-sweep,annual-renewal-reminder}.ts` |
| C-requests | The durable request worker and the hourly reconcile | `lib/billing/{requests,reconcile,card-expiring}.ts`, the `billing-minute` queue |
| C-actions | changePlan, addLocation, setAutoRenew, portal session, refunds, previews, overage billing, the settings script | `lib/billing/{stripe-actions,summary,support,metered-items,usage-report,annual-overage}.ts`, `apps/web/scripts/stripe-account-settings.ts` |
| D | Deposits and Stripe Connect | `lib/billing/{deposits,deposit-link,connect,connect-events}.ts`, the Connect routes and pages |
| E | The ops console's billing panel | `lib/ops/billing.ts`, `apps/web/src/app/admin/ops/[clinicId]/billing/` |
| T | The 21 billing email templates | `lib/email/templates/*` |

## Decisions that matter when changing this code

- **Only the worker calls Stripe for a plan start, a step-up, a closure or a
  refund's cancellation.** Callers record a request in their own transaction,
  through the definer `app_record_billing_request`, which always files it on the
  billing clinic. The drainer:
  - claims one row per billing clinic under a 5-minute lease, renewed before
    every Stripe call;
  - holds the billing clinic's Stripe mutation lease while it acts;
  - re-reads the subscription before every attempt, under a fresh idempotency
    key, so a failure Stripe cached is never replayed. A re-armed request bumps
    its `epoch`, which is part of every key.
- **`assistantMayAnswer` takes no transaction.** It reads the location and then
  its billing clinic in sequence: nesting the two deadlocks the pool. A
  production clinic with no billing row is refused; only synthetic clinics skip
  the billing checks.
- **`plan_code` is the billed package and `bought_plan_id` the bought one.**
  `channels_enabled` follows the bought package. Otherwise a channel bought but
  not yet billed would be refused for ever and could never step up.
- **A plan change in flight is recorded before anything is charged**
  (`entitlements.pending_plan_change_*`, under the Stripe mutation lease), so a
  retry adopts it instead of charging the setup-fee difference again.
- **A meter with no allowance in the billed package borrows the bought
  package's allowance** (`effectiveIncluded`), so a waiting channel's first
  answer is neither overage nor capped.
- **`invoice.paid` reads the live subscription and invoice from Stripe** before
  its transaction, so delivery order no longer matters, and
  `stripe_subscription_synced_at` makes a snapshot read earlier than the last
  one applied a no-op. A payment lifts a suspension only when money was paid
  against the invoice owed, after a non-payment suspension; a dispute is lifted
  by support.
- **Notices are enqueued on the billing clinic** with the dedupe keys in
  `notices.ts`. Critical kinds are delivered right after the commit.
- **Connect:**
  - states are hashed, single-use, 15 minutes long, and bound to the user;
  - the OAuth code is exchanged in one attempt;
  - a different account is refused, and an account another clinic shares is
    never revoked;
  - test-mode events and the clinic's own Checkout sales are ignored.
- **Deposit links meet BAA 1.3.0's release gate 10** (docs/counsel/agreement-changes.md
  § 12.14):
  - only website chat and Meta: `createDepositLink` takes `"web" | "meta"`, and
    `deposit_payments_channel_check` refuses anything else before Stripe is
    called;
  - Stripe sees an amount, "Appointment deposit", the suffix DEPOSIT and the
    row's id, in metadata too, and nothing else (the exact-parameters test in
    `deposit-link.test.ts`);
  - no payer details are kept: the Connect ledger stores no payload, and a
    paid deposit keeps its status, time and event id.
  No chat or Meta adapter sends a link yet. When one does, it sends
  `createDepositLink`'s URL inside `depositLinkText` and nothing more.
- **The Customer Portal** offers the payment method and invoice history only.
  Cancellation is the Auto-renew switch, behind step-up.
- **After Stripe's last retry the subscription is marked unpaid**, never
  cancelled (a Dashboard setting). `unpaid` suspends the clinic at once and
  Stripe attempts no further payment; the sweep suspends after seven days of
  grace in any case.

## Jobs (all seeded off; see "Switching it on")

| Job | Cadence | Does |
|---|---|---|
| `billing-notices` | every minute (the funnel's `notices` queue) | sends the outbox |
| `billing-requests` | every minute (`billing-minute` queue), and hourly as a backstop | drains requests |
| `billing-reconcile` | hourly | ensures plan starts and step-ups, waiting channels, deadline closures, location resumes, Connect disconnects after the end |
| `setup-closure` | switch only | lets the drainer execute closures |
| `billing-sweep` | hourly | grace warnings and suspensions |
| `usage-meter-report` | hourly | reports overage units to Stripe's meters |
| `usage-alerts` | hourly | the 80% and 100% notices |
| `annual-overage-invoice` | daily, 05 UTC | invoices annual plans' overage per closed month |
| `billing-housekeeping` | daily, 06 UTC | clears expired checkout records, old message references and Connect states |
| `card-expiring` | daily, 07 UTC | expiring-card notices |
| `annual-renewal-reminder` | daily, 09 UTC | `renewal_upcoming` at 30 and 21 days |

## Switching it on (owner)

The "Stripe launch: your steps" doc has the click-by-click version.
1. Release gate first (above): the overage copy must be on main before any
   live `stripe:setup`.
2. Run `npm run queue:install -w @healdesk/app` as the migrator in every
   environment before the worker deploys.
3. Run `stripe:setup`. It creates the block-priced metered prices and the $0
   plan-start price, and archives the per-unit prices.
4. Re-run `stripe-account-settings` on live: portal cancellation off, and
   `charge.refunded` subscribed.
5. Set on apps/app: `STRIPE_SECRET_KEY`, `HEALDESK_IDENTIFIER_REF_KEY`,
   `STRIPE_CONNECT_CLIENT_ID` and `STRIPE_CONNECT_WEBHOOK_SECRET`.
6. Once apps/app has a public origin, run the settings script with
   `--connect-endpoint` and `HEALDESK_APP_PUBLIC_URL`.
7. Enable Connect OAuth (Standard) with the redirect URI
   `https://app.healdesk.io/api/connect/stripe`, in both modes.
8. Switch the jobs on:
   - Gate A, before the first clinic's setup deadline (its purchase + 30
     days): `billing-notices`, `billing-requests` and `billing-reconcile`, then
     `setup-closure` last, because a closure cannot be undone;
   - before the first plan start: the rest.
9. Turn Stripe's own failed-payment and expiring-card emails off only once ours
   are live.
10. Rehearse a plan start, a renewal and a failed payment on a Stripe test clock
    before live.

## The review (7 October 2026)

Five reviewers read the integrated build, one per lens: money; concurrency;
security, PHI and tenancy; the spec and contracts; and test quality. Then one
adversarial verifier per lens tried to refute each finding. Of 27 findings, 25
survived. All 25 are fixed here except the overage copy, which is the release
gate above and the funnel session's to write. Each fix has a test that fails
without it.

- **Money and concurrency:**
  - a plan change is recorded before it is charged, so a lost answer cannot
    charge the setup-fee difference twice ([0], [2]);
  - a step-up applied on Stripe whose answer was lost finishes as the step-up
    it was ([4]);
  - an extra location charged but never marked charged is settled by the
    reconcile ([5]);
  - subscription snapshots apply in the order they were read ([6]);
  - a re-armed request never replays a failure Stripe cached ([7]);
  - the plan-start and step-up workers read entitlements under the row lock,
    and wait while a plan change is pending ([18]);
  - a second unpaid invoice keeps the clinic in dunning until both are paid
    ([19]);
  - an interval change re-anchors the allowance window, and leaving annual
    claims the annual months not yet invoiced ([20]);
  - the Billing summary carries overage in dollars, so the portal never does
    its own billing maths ([17]).
- **Copy:** nine billing emails now say only what is true in the case at hand
  ([8] to [16]), using the payload flags `hasUncheckedLinks`, `kind`,
  `isProrated`, `isPaid`, `startedOn` and `graceEndsAt`.
- **Privacy:**
  - chat-thread references are purged after 30 idle days, and offboarding
    destroys them with `meta_inbound_messages` ([3]);
  - the Connect done page no longer prints text from its query string ([21]).
- **Tests and CI:**
  - the usage race test now races;
  - addLocation's charged marker has a test;
  - CI fails on any skipped or todo test, not only on fewer than 200 passes
    ([22] to [24]).

Two findings were refuted:
- **"The plan start sends `default_payment_method: ""`, which Stripe cannot
  unset."** Stripe's API treats an empty string as unsetting such a field,
  although the SDK types do not show it. No live call has proved it for
  `subscriptions.update`, so the test-clock rehearsal must check it: a plan
  start that clears the subscription's card and charges the customer's
  default.
- **"Voice minutes are metered at most once."** This is deliberate
  (`lib/voice/ingest.ts`): a failure after the call is recorded under-bills,
  which is the safe direction, and the vendor is not asked to retry.

What the fixes left open:
- No ops alert fires for a plan change stuck pending, and there is no console
  op to resume one. The reconcile finishes or drops it after ten minutes; a
  new ops event would need `ops/notify.ts` and `ops_alert.ts`.
- After a lost answer to an annual-to-monthly change, the subscription
  webhook can move `billing_interval` before the reconcile's hand-over runs,
  and the meter reporter could then send pre-switch annual rows to a meter.
  This is rare, and closing it needs `usage-report.ts` or `events.ts`.
- Nothing alerts ops if Stripe collects an unpaid first invoice inside the
  14-day refund window; the ops panel's refund-window flag still shows it.
- A step-up applied on Stripe but never recorded locally can make a later
  setup-only plan change say it was prorated. This is rare.

## Open items

- The funnel's M3 adds `portalUrl` and `billingUrl` to the email template
  context; the billing templates then link Billing directly.
- `createLocationClinic` belongs to the funnel. `LOCATION_CLINICS_READY` is
  false until it lands, and addLocation refuses until then.
- The usage-alert templates (`usage_80`, `usage_100`) wait for the funnel's
  stop-link page.
- The data-destruction dates in the `canceled` email come from
  `canceledPayload` in `events.ts`. The funnel session replaces those two lines
  with its per-agreement function (BAA 1.2.1 and earlier: day 30 flat), keeping
  `exportByOn` and `destroyByOn` and their meanings.
- The plan's Part J test (every `clinic_id` table is in the destroy list and
  the purge, or in a reasoned keep-list) is M5 work.
