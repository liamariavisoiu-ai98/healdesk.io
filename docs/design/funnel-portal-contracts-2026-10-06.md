# Funnel, onboarding and portal: the contracts other sessions build to (6 October 2026)

The owner approved the funnel, onboarding and portal plan on 6 October 2026
(`docs/design/funnel-onboarding-portal-2026-10-06.md`). This file is the part of
it that other sessions build against: the Stripe session (packages B, C and D of
`docs/design/stripe-launch-2026-10-05.md`), the calendar session, and the
runtime. Precedence is unchanged: `docs/v1-product-spec.md` wins, then the plan,
then the Stripe design.

Each owning session acknowledges its section before building on it.

---

## 1. What the plan changes in the Stripe design

- **Superseded by the plan:** A1 (accounts, sign-in, portal shell, purchase
  backend), A2 (the apps/web purchase flow) and E's portal screens. The plan
  builds them. E's ops billing panel stays Package C's.
- **Built to this file:** B, C and D.
- **One email address per clinic.** It is the clinic's only sign-in, the Stripe
  customer's email, the agreement's notice address and where every notification
  goes. A shared inbox such as info@ is fine. Each device adds its own passkey.
  The design's three roles (§6) are deferred past v1: `requirePortal(slug)`
  checks membership only, and the Stripe billing portal needs one configuration,
  not an owner one and a billing one.
- **The provisioning cutover** (D2 semantics), `/welcome` and the welcome email
  are the plan's. `/welcome` replaces §4.3 and §4.4's done-page polling.
- **The email platform and its sender** are the plan's (§4 below). Package C
  supplies kinds, payloads and templates.
- **The portal has no Behaviour screen.** It has Home, Settings, Knowledge,
  Conversations, Bookings and Billing. Every route the design sends to
  `/c/<slug>/behaviour` goes to `/c/<slug>/settings` instead.

## 2. The deferred start (Package C)

Monthly billing starts **the day AYA first answers a patient**, and no later
than a backstop date (purchase plus `PLAN_START_TERM_DAYS`, a catalog constant,
default 60). **There is no Stripe trial anywhere.**

Why no trial: Visa's trial rules bind "only… merchants that offer free trials
or introductory promotions" (Visa Business News AI09334, 26 Sep 2019), and the
plan gives nothing free. A Stripe trial would make Stripe treat it as one, and
Stripe appends "TRIAL OVER" to the first charge's statement descriptor.

**Checkout (apps/web, built by the plan):**
- subscription mode, cards only;
- line items: the bought package's setup fee (one-time), and a **$0 recurring
  price**, "Monthly plan: starts when AYA first answers"
  (`lookup_key: plan_start_placeholder_month`);
- no `trial_end`; no package price and no metered items yet;
- `metadata {app, ref}`; `custom_text` carries the plan-start sentence;
- the setup credit still applies to the setup-fee line. Subscription mode always
  saves the card, even when the total is $0.

The first invoice (setup fee plus the $0 line) fires `invoice.paid` with
`billing_reason=subscription_create`, so provisioning is unchanged.

**Functions Package C provides:**

| Function | Does |
|---|---|
| `schedulePlanStart({clinicId, subscriptionId, boughtPlanId, interval, backstopAt})` | Called by provisioning after commit. Creates a schedule `from_subscription`, then sets phase 0 to the $0 line until `backstopAt`, and phase 1 to the bought package as a placeholder (plus metered items on monthly plans) with `billing_cycle_anchor: phase_start` and no end. Stores `entitlements.stripe_schedule_id`. Idempotent per subscription. |
| `startPlan(clinicId, reason: "first_answer" \| "backstop")` | **`first_answer`** (the engine calls it once, on the clinic's first `first_answer`): rewrites phase 1 to the package matching the channels in service, ends phase 0 now and starts phase 1 now, so Stripe charges the first period that day. **`backstop`** (a job, 7 days before the backstop): sets phase 1 to the channels ready on our side, live or waiting on the clinic, and enqueues `plan_start_reminder`. If no channel is ready on our side, the delay is ours, so it calls `extendPlanStart` instead. `notifyOps` fires if this job hasn't run by 3 days before the backstop. |
| (on the first plan invoice's `invoice.paid`) | Sets `entitlements.plan_started_at`, opens the allowance window and enqueues `plan_started`, with the hosted receipt and the cancel link. At the backstop the copy reads "Your plan started today, as scheduled". A failed charge enqueues `payment_failed` instead. |
| `stepUpPackage(clinicId, channel, reason: "first_answer" \| "waiting")` | **Only once the plan has started.** It adds a channel to the current phase from its first answer (`price_stepped_up` that day), or 30 days after the later of its readiness and the plan start (`step_up_reminder` 7 days ahead). Monthly plans use `create_prorations`; annual plans use `always_invoice`. It never re-charges a setup fee, and metered rates stay at the **bought** package's. Before the start, waiting channels count only at the backstop. |
| `extendPlanStart(clinicId, date, reason: "ours" \| "ops")` | Moves phase 0's end and enqueues `plan_start_moved`. When an opening date moved too, the clinic gets one email for both. |
| `setAutoRenew(clinicId, false)` before the start | Sets the schedule to end with phase 0, so nothing more is charged: "Your plan won't start, and nothing more is charged." |

**Gate additions for `assistantMayAnswer` (Package B):** the channel is Off; the
channel is not live; `ai_paused_until` is in the future; a cancellation before
the start is set.

**Tests Package C adds:** no subscription is ever `trialing`; no charge carries
"TRIAL OVER"; a $0 invoice sends no email and doesn't trip `recordFirstInvoice`,
the allowance windows, the renewal reminder or usage alerts.

## 3. Notice kinds (Package C's payloads and templates, the plan's sender)

The catalogue ids are the plan's Annex X.

| Kind | Annex X | When |
|---|---|---|
| `plan_started` | L2 | First plan invoice paid |
| `price_stepped_up` | L3 | A channel's price joins |
| `step_up_reminder` | L4 | 7 days before a waiting channel joins |
| `plan_start_reminder` | L5 | 7 days before the backstop |
| `plan_start_moved` | L6 | `extendPlanStart` |
| `allowance_fallback` | L19 | "Stop and fall back" engages, whatever the usage-alerts switch says |
| `meta_deadline` | L26 | 14 and 3 days before Meta's switch-or-refund date |
| F0's kinds | L27, E1, E2 | As the design's §7 says. `renewal_upcoming` goes at 30 **and** 21 days. `canceled` carries carrier-specific steps for undoing call forwarding. |
| `receipt` | L27 | Any paid invoice above $0 that no other email covers, with the cancel link |
| `refund_issued` | L27 | `commitRefund` |
| `card_expiring` | L27 | The default card expires before the next renewal |

- `welcome_resend` leaves the CHECK: the welcome is a link email (Annex X1.5).
- **No receipt for an invoice that has its own email:** the welcome, `plan_started`,
  `price_stepped_up`, `plan_changed`, `location_added`, `restored` and
  `overage_invoiced` link Stripe's hosted receipt themselves.
- **Payloads carry no PHI:** cents, ISO dates, Stripe-hosted URLs, plan and
  channel names, counts.
- **Recipient:** the clinic's one address. `billingRecipients()` returns it.

## 4. The email platform (built by the plan in M2)

- **One outbox: F0's `billing_notices`, name kept.** Its kinds widen from a kind
  registry in code. Package C keeps calling `enqueueNotice(tx, kind, dedupeKey,
  payload, {sendAfter})` exactly as F0 wrote it.
- **One ledger: `report_deliveries`, name kept**, gaining `delivery_status` and
  `delivery_at`.
- **The sender replaces F0's stubs** (`sendPendingNotices`,
  `runBillingNoticesJob`): critical kinds go in-process right after commit;
  everything else and every retry runs from a pg-boss `notices` queue every
  minute. Package C does not write a sender.
- **Templates:** `apps/app/src/lib/email/templates/<kind>.ts`, each a pure
  `(payload, ctx) => {subject, preheader, text, html}`, with a snapshot test per
  kind. The plan's copy lint and payload allowlist run over them.
- **Resend:** one account, healdesk.io verified. Product mail comes from
  `healdesk <hello@healdesk.io>`; marketing from `healdesk <noreply@healdesk.io>`.
  Every reply reaches hello@.
- **Stripe's own customer emails** (receipts, refunds, failed payments,
  renewals, trial reminders, expiring cards) are switched off at launch, once
  each replacement above is live and tested.

## 5. Package D (deposits and Connect)

- **Connect starts from** Settings → Payments and the wizard's deposit step.
  - The callback returns to `/c/<slug>/settings?connect=ok|declined|failed`, or to
    `/c/<slug>/setup?connect=…` when started from setup.
  - Operator-started connects keep the neutral `/connect/stripe/done` page.
- **Connecting and disconnecting** need a step-up in the portal.
  - `connect_disconnected` (O14) also serves as the security record.
  - Connecting enqueues `connect_connected` (O14), so add it beside
    `connect_disconnected`.
- **A deposit that is flagged, held or expired**, or a booking refused for want
  of one, raises L10 through the plan's
  `notifyBookingAlert(tx, "deposit_to_collect", {appointmentId})`. Its payload
  carries ids only.

## 6. The calendar session

- **Functions:**
  - `getCalendarConnection(clinicId)`
  - `startGoogleConnect(clinicId, returnTo)`
  - `disconnect(clinicId)`
  - `listCalendars(clinicId)`, only if the calendar-list scope is approved
  - `effectiveBookingMode(clinicId) → {mode: "direct" | "requests", reason}`
- **A connection that stops working, or is reconnected after setup:** call the
  plan's `notifyCalendarState(clinicId, "stopped" | "reconnected")`, which sends
  O13. Connecting during setup sends nothing.
- **The next BAA version gives 24 hours' notice** by email before adding a
  subprocessor that will handle PHI, and keeps the practice's right to object.
  - The plan's DPA uses the same clause.
  - The owner decided this on 6 October; it is a counsel risk row.
  - BAA 1.2.1 keeps its 15 days for anyone who signed it.
- **The direct-booking kill switch** is, in v1, the clinic's one sign-in, with a
  step-up.
- **The calendar step sits in setup step 3** (`/c/<slug>/setup`) and in Settings
  → Calendar. Both use `startGoogleConnect` with a `returnTo` on the
  portal's own origin.

## 7. Engine and runtime (built by the plan; the runtime consumes it)

- `respond(...)` and `recordTurn(...)`: `recordTurn` is the only writer to
  `conversation_turns`.
- **Channel events:**
  - `live`: setup done, runtime present, the channel's audit passed;
  - `first_answer`: the first inbound patient conversation answered on a live
    channel. It excludes healdesk's test calls, the forwarding-test window,
    calls from the clinic's own numbers, the preview and the practice questions.
- **The clinic's first `first_answer`** calls `startPlan(clinicId,
  "first_answer")`; each later channel's calls `stepUpPackage(clinicId, channel,
  "first_answer")`.
- **Also provided:**
  - the pre-model urgent matcher, keyed by specialty, with human and veterinary
    sets;
  - per-channel engine config (model, effort, `max_tokens`, streaming).

## 8. New environment variables

Already present and reused: `HEALDESK_OPS_EMAIL`, `RESEND_API_KEY`,
`HEALDESK_EMAIL_FROM` (set per app: apps/web sends as noreply@, apps/app as
hello@), `RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
`STRIPE_CONNECT_CLIENT_ID`.

| Variable | App | From | Purpose |
|---|---|---|---|
| `HEALDESK_CHECKOUT_MODE` | web | M1 | `pilot` or `public`; unset or anything else means `pilot`. Declared in `turbo.json` |
| `STRIPE_AUTOMATIC_TAX` | web | M2 | `true` turns on Stripe Tax at checkout (owner's open item 9) |
| `NEXT_PUBLIC_PORTAL_URL` | web | M3 | The site's "Sign in" link. Declared in `turbo.json`'s `build.env` |
| `HEALDESK_SUPPORT_PHONE` | app | M3 | Help's voicemail number (open item 7); Help hides it while unset |
| `HEALDESK_CALL_BOOKING_URL` | app | M3 | The five-minute call link (open item 8); the button hides while unset |
