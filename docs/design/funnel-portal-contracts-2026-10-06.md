# Funnel, onboarding and portal: the contracts other sessions build to (6 October 2026)

The owner approved the funnel, onboarding and portal plan on 6 October 2026
(`docs/design/funnel-onboarding-portal-2026-10-06.md`). This file is the part of
it that other sessions build against: the Stripe session (packages B, C and D of
`docs/design/stripe-launch-2026-10-05.md`), the calendar session, and the
runtime. Precedence is unchanged: `docs/v1-product-spec.md` wins, then the plan,
then the Stripe design.

Each owning session acknowledges its section before building on it.

**Updated later on 6 October 2026** with the owner's answers on the open-items page and the
sessions' acknowledgements:
- §2 has no backstop and no schedule; it has the 30-day setup window;
- §3 loses L5, L6 and L26;
- §6 carries the corrected kill switch and the agreed signatures;
- §8 adds `HEALDESK_SETUP_LINKS`.

The Stripe session and the calendar session have acknowledged these versions.

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
  *Since 14 October 2026* the signed agreement and the purchase are recorded on
  apps/web (sealed records in the marketing Sheet) instead of in apps/app at
  signing and at Pay, and apps/app imports both when the first invoice is paid;
  Stripe returns the buyer to apps/web's `/welcome`, which hands the browser on
  to apps/app's `/welcome` once the account exists. Provisioning's semantics
  are unchanged. See `docs/design/checkout-records-on-vercel-2026-10-14.md`.
- **The email platform and its sender** are the plan's (§4 below). Package C
  supplies kinds, payloads and templates.
- **The portal has no Behaviour screen.** It has Home, Settings, Knowledge,
  Conversations, Bookings and Billing. Every route the design sends to
  `/c/<slug>/behaviour` goes to `/c/<slug>/settings` instead.

## 2. The deferred start (Package C)

Monthly billing starts **the day AYA first answers a patient**. There is **no backstop date** and
**no Stripe trial anywhere** (owner, 6 October 2026).

Why no trial: Visa's trial rules bind "only… merchants that offer free trials or introductory
promotions" (Visa Business News AI09334, 26 Sep 2019), and the plan gives nothing free. A Stripe trial
would make Stripe treat it as one, and Stripe appends "TRIAL OVER" to the first charge's statement
descriptor.

**Checkout (apps/web, built by the plan):**
- subscription mode, cards only;
- line items: the bought package's setup fee (one-time), and a **$0 recurring price**, "Monthly plan:
  starts when AYA first answers" (`lookup_key: plan_start_placeholder_month`, created by stripe-setup in M2);
- no `trial_end`; no package price and no metered items yet;
- `metadata {app, ref}`; `custom_text` carries the plan-start sentence;
- the setup credit still applies to the setup-fee line. Subscription mode always saves the card, even
  when the total is $0;
- **the setup fee is never refundable** (owner, 6 October 2026), and the funnel and the Terms say so before payment.

The first invoice (setup fee plus the $0 line) fires `invoice.paid` with
`billing_reason=subscription_create`, so provisioning is unchanged.

**No subscription schedule.** At the first answer the worker swaps the $0 item for the package price on
the plain subscription, with `billing_cycle_anchor: "now"` and `proration_behavior: "none"`, so Stripe
invoices the first period at once. Nobody stores a schedule id.

**The 30-day setup window (owner, 6 October 2026):**
- provisioning sets `entitlements.setup_deadline_at`: the end of the 30th day after purchase;
- while no channel is live, the plan sends a setup reminder every five days, six in all (days 5 to 30);
- at the deadline, a clinic with no live channel is closed. The setup fee is not refunded, the account and
  its setup data are removed, and the signed agreement and the billing records are kept for as long as the
  law requires.

**Functions Package C provides** (each records the request in the caller's transaction; the worker calls
Stripe with idempotency keys and retries). The final signatures, as Package C stubs them on 6 October 2026, follow the table:

| Function | Does |
|---|---|
| `startPlan(tx, clinicId)` | The clinic's first `first_answer`. Swaps the $0 item for the package matching the channels in service, anchored now, so the first period is charged that day. |
| (on the first plan invoice's `invoice.paid`) | Sets `entitlements.plan_started_at`, opens the allowance window and enqueues `plan_started` (L2), with the hosted receipt and the cancel link. A failed charge enqueues `payment_failed` instead. |
| `stepUpPackage(tx, clinicId, channel, reason: "first_answer" \| "waiting")` | **Only once the plan has started.** It adds a channel from its first answer (`price_stepped_up` that day), or 30 days after the later of its readiness and the plan start (`step_up_reminder` 7 days ahead). Monthly plans use `create_prorations`; annual plans use `always_invoice`. It never re-charges a setup fee, and metered rates stay at the **bought** package's. |
| `setAutoRenew(tx, clinicId, false)` before the start | Sets `cancel_at_period_end` on the $0 period: the account closes at that period's end unless auto-renew is turned back on, and nothing more is charged. Billing shows the earlier of that date and `setup_deadline_at`. |
| `closeUnfinishedSetup(tx, clinicId)` | At `setup_deadline_at` with no live channel. The worker re-checks that no channel is live (if one is, it calls `notifyOps` instead), then cancels immediately with no proration and no final invoice. Package C sends no `canceled` notice for it; the plan's closure email is the only one. |

**Final signatures (Package C, 6 October 2026), all in apps/app.** Recorders run inside the caller's
transaction; everything else runs outside any transaction.

- `startPlan(tx, clinicId, reason?: "first_answer" | "reconcile" | "ops") → { recorded }`
- `stepUpPackage(tx, clinicId, channel, reason) → { recorded }`
- `closeUnfinishedSetup(tx, clinicId, reason?: "deadline" | "ops") → { recorded }`. Package C's hourly
  billing reconcile records it with `"deadline"` once `setup_deadline_at` has passed, the plan has not
  started, the clinic is not canceled and no location has `live_at`; the unique row makes a second
  caller harmless. The worker cancels with `cancellation_details.comment = "hd_setup_closure"`, and
  `events.ts` sends no `canceled` notice and calls `startOffboarding(tx, "setup_closure")`: the plan's
  closure email keys on that reason.
- These three record on the **billing** clinic through a definer, so a location's transaction may call them.
- `assistantMayAnswer({ clinicId, channel, usage?: { source, sourceRef }, now?, actor })` →
  `{ decision: "answer" }` or `{ decision: "pass_through", reason, fallback: "direct_line" | "contact_form" | "no_reply", directLine }`.
  It takes **no transaction** and must be called outside one (it reads the location, then the billing
  clinic). The `usage` ref replaces `startsNew`: a hard cap applies while that call or conversation is not
  yet counted. Reasons: `unpaid`, `suspended`, `canceled`, `not_active`, `ai_paused`, `channel_off`,
  `channel_not_live`, `not_purchased`, `cancel_before_start`, `allowance_cap`, `outside_coverage`.
- `recordUsage({ locationClinicId, meter, quantity, source, sourceRef, occurredAt, actor })`: on every
  allowed message, idempotent per `sourceRef`. Never for test calls, forwarding tests, the clinic's own
  numbers, the preview or the practice questions.
- `setAutoRenew({ clinicId, on, actorLabel }) → { status: "ok", closesOn } | { status: "busy" | "refused", message }`
- `changePlan({ clinicId, planId, interval, requestId, actorLabel })` and `addLocation({ clinicId, requestId,
  actorLabel, name? })`, each returning a typed union whose statuses include `busy`, `payment_failed` and
  `not_available`. `requestId` is fresh per user attempt. `addLocation` refuses with `not_available` while
  `LOCATION_CLINICS_READY` (lib/location-clinic.ts) is false, and calls `createLocationClinic({
  billingClinicId, locationNumber, name?, actor })`, which is idempotent on (billing clinic, location number).
- `createPortalSession({ clinicId, returnUrl, flow?: "payment_method_update" }) → { url } | { status:
  "unavailable" }`: payment method and invoices only. Its URL lasts about five minutes, so it never goes
  in an email.
- For Billing, `lib/billing/summary.ts`: `getBillingSummary(clinicId)` (database only: status, bought and
  billed plans, interval, locations, channels in service and not yet priced, plan started, first period
  end, paid through, setup deadline, auto-renew and closes-on, overage mode, usage alerts, the open
  invoice's URL and amount, grace, usage meters), `previewNextInvoice(clinicId)`, `previewChangePlan({
  clinicId, planId, interval })` (with the setup-fee difference and the proration) and
  `previewAddLocation(clinicId)`.

**Gate additions for `assistantMayAnswer` (Package B):** the channel is Off; the channel is not live;
`ai_paused_until` is in the future; `cancel_at_period_end` is set before the plan starts; and, in
after-hours-only coverage, a call inside opening hours (`isOpenAt` with `closedOn`) passes through with
reason `outside_coverage`.

**Tests Package C adds:** no subscription is ever `trialing`; no charge carries "TRIAL OVER"; a $0
invoice sends no email and doesn't trip `recordFirstInvoice`, the allowance windows, the renewal reminder
or usage alerts ("the placeholder period opens no window and sends no email").

## 3. Notice kinds (Package C's payloads and templates, the plan's sender)

The catalogue ids are the plan's Annex X.

| Kind | Annex X | When |
|---|---|---|
| `plan_started` | L2 | First plan invoice paid |
| `price_stepped_up` | L3 | A channel's price joins |
| `step_up_reminder` | L4 | 7 days before a waiting channel joins |
| `allowance_fallback` | L19 | "Stop and fall back" engages, whatever the usage-alerts switch says |
| F0's kinds | L27, E1, E2 | As the design's §7 says. `renewal_upcoming` goes at 30 **and** 21 days. `canceled` carries carrier-specific steps for undoing call forwarding. |
| `receipt` | L27 | Any paid invoice above $0 that no other email covers, with the cancel link |
| `refund_issued` | L27 | `commitRefund` (the first-period refund; the setup fee is never refunded) |
| `card_expiring` | L27 | The default card expires before the next renewal |
| `connect_connected` | O14 | Package D, beside `connect_disconnected` |

- These eight are registered in `apps/app/src/lib/email/kinds.ts` by the shared contracts commit.
  Package C may change the attributes of its own kinds there, and nowhere else.
- L5, L6 and L26 are gone with the backstop and the Meta date. The setup reminders and the closure email
  are the plan's kinds (M3).

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
- **The direct-booking kill switch is `HEALDESK_DIRECT_BOOKING_ENABLED`**, off by default and set only by
  the owner (5 October decision). It is not a clinic control. The clinic's own control is Auto-confirm
  (`clinic_settings.auto_confirm_bookings`, default on), which the portal puts behind step-up through the
  calendar session's `setAutoConfirm(clinicId, on, actor)`. (Corrected 6 October: this line first called
  the clinic's sign-in the kill switch.)
- **Agreed signatures:**
  - `startGoogleConnect({clinicId, returnTo, disclosureVersion}) -> {authUrl}`. It is called from a server
    action on app.healdesk.io, never apps/web, because it sets an HttpOnly binding cookie. `returnTo` is
    exactly `/c/<slug>/setup` or `/c/<slug>/settings`. Setup step 3 and Settings → Calendar render
    `GOOGLE_CALENDAR_DISCLOSURE` (packages/catalog) directly above an unticked box and the Google-branded
    button.
  - `notifyCalendarState(tx, clinicId, state, { dedupeKey })` lives at
    `apps/app/src/lib/notices/calendar-state.ts`. It is a no-op seam until M3, when it enqueues O13 inside
    the caller's transaction.
  - `effectiveBookingMode(clinicId) -> {mode, reason, reasons}`; `listCalendars` returns owned calendars
    only, primary first.
- **Provisioning creates the clinic's one membership as active, with role `owner`**, which the calendar
  session's election guard requires.
- **Google scopes are five**, the calendar list included (owner, 6 October).
- **The calendar step sits in setup step 3** (`/c/<slug>/setup`) and in Settings
  → Calendar. Both use `startGoogleConnect` with a `returnTo` on the
  portal's own origin.

## 7. Engine and runtime (built by the plan; the runtime consumes it)

- **No turn is stored.** `recordTurn(...)` and `conversation_turns` are dropped
  (owner, 13 October 2026): the transcript is emailed to the practice when the
  conversation ends and healdesk keeps no copy of it, and BAA 1.5.0 deletes
  the outbox's copy once delivery is confirmed
  (`docs/design/transcript-email-2026-10-13.md`). One brain,
  `apps/app/src/lib/assistant/*`, answers the call and the web chat
  (`answerTurn`), on one model client the Meta front door shares.
- **Channel events:**
  - `live`: setup done, runtime present, the channel's audit passed;
  - `first_answer`: the first inbound patient conversation answered on a live
    channel. It excludes healdesk's test calls, the forwarding-test window,
    calls from the clinic's own numbers, the preview and the practice questions.
- **The clinic's first `first_answer`** calls `startPlan(tx, clinicId,
  "first_answer")`; each later channel's calls `stepUpPackage(tx, clinicId,
  channel, "first_answer")`, both inside the transaction that records the event.
- **Before answering anyone,** the runtime asks `assistantMayAnswer(...)`
  outside any transaction and, for every allowed message, calls `recordUsage(...)`
  with the call's or conversation's own reference (signatures in §2).
- **Also provided:**
  - the pre-model urgent matcher, keyed by specialty, with human and veterinary
    sets (`findUrgentContent(text, specialty)` in packages/catalog), and the
    fixed urgent replies (`fixedUrgentReply`);
  - per-channel engine config (model, effort, `max_tokens`, timeout), with no
    streaming: the guard reads the whole reply.

## 8. New environment variables

Already present and reused: `HEALDESK_OPS_EMAIL`, `RESEND_API_KEY`,
`HEALDESK_EMAIL_FROM` (set per app: apps/web sends as noreply@, apps/app as
hello@), `RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
`STRIPE_CONNECT_CLIENT_ID`.

| Variable | App | From | Purpose |
|---|---|---|---|
| `HEALDESK_CHECKOUT_MODE` | web | M1 | `pilot` or `public`; unset or anything else means `pilot`. Declared in `turbo.json` |
| `HEALDESK_SETUP_LINKS` | web | M1 | `open` lets /admin/setup send setup links; unset, production refuses (Gate A, the owner's switch). Declared in `turbo.json` |
| `STRIPE_AUTOMATIC_TAX` | web | M2 | `true` turns on Stripe Tax at checkout (owner's open item 9) |
| `NEXT_PUBLIC_PORTAL_URL` | web | M3 | The site's "Sign in" link. Declared in `turbo.json`'s `build.env` |
| `HEALDESK_SUPPORT_PHONE` | app | M3 | Help's voicemail number (open item 7), E.164: `+18886889404`, the owner's. Help hides it while unset or malformed |
| `HEALDESK_CALL_BOOKING_URL` | app | M3 | The five-minute call link (open item 8), https: `https://calendly.com/healdesk-io/quick-onboarding`, the owner's. Emails link it through `/help/call`; the button hides while unset or malformed |
