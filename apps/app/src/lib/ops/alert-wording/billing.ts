import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "billing" section of docs/on-call.md's alert runbook. Every control a
 * step names is on the clinic's Billing tab (apps/web
 * app/admin/clinics/[clinicId]/billing/BillingPanel.tsx) or the Jobs page
 * under System, and money is the owner's: a refund, a credit or a change to
 * what Stripe bills waits for the owner's word, and every step that touches
 * it says so. So does Turn on for the billing-requests row: that job ships
 * off on purpose (lib/billing/stripe-actions.ts, commitRefund), and turning
 * it on carries out every waiting billing change for every clinic, plan
 * starts that charge cards included. The Touch log's Record button shows
 * for every clinic until its account is closed (lane N3; apps/web
 * TouchLog.tsx, lib/ops/health.ts touchRefusal).
 *
 * `clinicId` can be null on billing_event_dead_lettered and
 * connect_event_dead_lettered (an event that resolved to no clinic shows on
 * no Billing tab), so those name the clinic in an optional clause and their
 * first step says what to do when none is named.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // /api/provision, once per purchase: a second subscription was paid for a
  // practice whose clinic exists (by its purchase, or by its Stripe customer
  // alone). Checkout charges the setup fee plus a $0-a-month placeholder
  // (apps/web lib/billing.ts), so the duplicate's plan never starts and no
  // first period is charged. Nothing is made for it; the clinic named is the
  // existing one, and the duplicate is the newer subscription.
  duplicate_subscription: {
    title: "A clinic was charged for a second subscription",
    headline: "{clinicName} paid for AYA a second time: it already has its account",
    whatHappened:
      "{clinicName} paid a second setup fee: it already has its account. Stripe took the fee on a newer subscription for the same practice. Nothing was made for it; the account the clinic has is unchanged.",
    whyItMatters:
      "The practice has paid a second setup fee. The duplicate subscription bills $0 a month until a plan starts, but it holds the card and should be cancelled.",
    steps: [
      "Open the clinic's Billing tab and read the Plan card: it shows the plan the clinic has, but not which Stripe subscription carries it.",
      "Find the clinic's customer in Stripe's Dashboard: the duplicate is the newer of its two subscriptions, and the Billing tab cannot tell you which that is. Do not cancel the older one, which the clinic's account runs on.",
      "Ask the owner before any money moves: cancelling the newer subscription and refunding its setup fee is the owner's call. Nothing on the Billing tab cancels or refunds a subscription the account does not record.",
      "Check Stripe shows one subscription for the customer. You are done when it does and the Billing tab's Plan card is unchanged.",
    ],
  },
  // lib/billing/events.ts, after the third failure of one Stripe event: it
  // is parked, Stripe is answered 200 and does not resend. A failed replay
  // (lib/ops/billing.ts opReplayBillingEvent) leaves it listed as failed
  // with the new error; nothing retries it by itself.
  billing_event_dead_lettered: {
    title: "A Stripe event could not be applied and is parked",
    headline: "A Stripe billing event[ about {clinicName}] failed[ {failures:time}] and is parked",
    whatHappened:
      "A Stripe billing event[ about {clinicName}] failed[ {failures:time}] and is parked. Stripe told us something about a clinic's billing, and applying it failed on every try, so nothing tries it again by itself. Stripe has been answered, so it will not resend it.",
    whyItMatters:
      "Until it is applied, our record of the clinic's billing may be wrong: a payment, a failed charge or a cancellation Stripe knows about and we do not.",
    steps: [
      "Open the clinic's Billing tab if this alert names a clinic, and find the event under Parked Stripe events: its type, its failures and a short reason are on its row. If it names none, open the System page: Stripe events parked under Requires your attention counts it, with how long the oldest has waited, though nothing there replays it. Tell the owner today, since only the owner can look into an event that names no clinic.",
      "Press Replay on the row. The event is applied again from the start; if it fails again, it stays listed as failed with the new reason, and nothing retries it by itself.",
      "Tell the owner today if the replay fails again, with the reason the row under Parked Stripe events shows.",
      "Check Parked Stripe events on the Billing tab again. You are done when the event is gone from the list.",
    ],
  },
  // lib/billing/requests.ts settle (every attempt used, or a permanent
  // failure), and lib/billing/reconcile.ts when the hourly check re-arms a
  // dead letter after a day's rest (`status: "rearmed"`). `status` is not an
  // allow-listed word, so the re-armed case is described in prose rather
  // than a conditional clause. `kind` is plan_start, step_up, cancel_now or
  // close_setup; `code` the last Stripe error.
  billing_request_dead_lettered: {
    title: "A billing change failed at Stripe after every retry",
    headline: "{clinicName}'s billing change failed at Stripe[: {status}]",
    whatHappened:
      "{clinicName}'s billing change failed at Stripe on every try. For a plan start or a price step-up still owed, the hourly check puts it back for one more try a day later and tells you again; anything else is not retried unless someone presses Retry.",
    whyItMatters:
      "Until it goes through, what Stripe bills and what the clinic has do not match: a plan start not charged, a channel not billed, a cancellation or a closure not carried out.",
    steps: [
      "Open the clinic's Billing tab and find the change under Billing requests: its kind, its attempts and the last error are on its row. If the row already reads pending with a next attempt, the hourly check has just put it back for another try: do not press Retry, and check the row in an hour.",
      "Read the last error on the row under Billing requests. If it says the card was refused or the subscription has ended, nothing here fixes it: ask the owner what to do before pressing anything.",
      "Press Retry on the row once the cause is fixed, or if the error reads like a passing fault. It is picked up within a minute while the billing-requests row on the Jobs page under System reads on; if that row reads off, ask the owner before pressing Turn on, which carries out every waiting billing change for every clinic.",
      "Check the row under Billing requests an hour later. You are done when it reads done.",
    ],
  },
  // lib/billing/reconcile.ts, once per request: pending for more than a day
  // (STUCK_AFTER_MS), which the Billing tab marks STUCK. A setup closure held
  // by its own switch is waiting by design and is not counted.
  billing_request_stuck: {
    title: "A billing change has waited at Stripe for over a day",
    headline: "{clinicName}'s billing change[ ({kind})] has waited over a day",
    whatHappened:
      "{clinicName}'s billing change has waited over a day without finishing. It is marked STUCK on the clinic's Billing tab.",
    whyItMatters:
      "Until it goes through, what Stripe bills and what the clinic has do not match. A change this late usually means nothing is carrying changes out at all.",
    steps: [
      "Open the Jobs page under System and check whether the billing-requests row reads on. If it reads off, ask the owner before pressing Turn on: it carries out every waiting billing change for every clinic, plan starts that charge cards included. Billing requests not done under Requires your attention on the System page counts every clinic's waiting change, so a count much above one means it is not this clinic alone.",
      "Open the clinic's Billing tab and find the row marked STUCK under Billing requests. Its attempts and last error say whether it is being tried or only waiting.",
      "Press Retry on the row if it shows no attempt for an hour while the job is on. If the last error says the card was refused or the subscription has ended, ask the owner instead.",
      "Check the row under Billing requests an hour later. You are done when it reads done.",
    ],
  },
  // lib/billing/requests.ts closeSetupWorker: a close_setup request found a
  // live channel in the billing group and was skipped, once per request.
  setup_closure_skipped_live_channel: {
    title: "A setup closure was skipped: a channel is live",
    headline: "{clinicName} stays open: its setup closure was skipped because a channel is live",
    whatHappened:
      "{clinicName} stays open: its setup closure was skipped because a channel is live. It reached the end of its setup window with a channel already live, so the closure that would have cancelled its subscription was skipped and nothing was changed.",
    whyItMatters:
      "This is the right outcome: a clinic that is answering is not closed. Its plan starts, and billing begins, the first time AYA answers a patient, which happens by itself.",
    steps: [
      "Open the clinic's Billing tab and look under Billing requests: the Setup closure row reads skipped. Do not press Retry on it; it would only be skipped again.",
      "Check Plan started on the Plan card of the same tab: it fills in by itself the first time AYA answers. Leave Close the unfinished setup alone, since it is refused while a channel is live. You are done once you have checked the row.",
    ],
  },
  // lib/billing/stripe-actions.ts finishLocationSetup (the add's own
  // attempt) and lib/billing/reconcile.ts (the hourly resume), once per
  // request: the charge is recorded and the location is still not active.
  // `count` is the location's number, as the Billing tab names it.
  location_charged_not_created: {
    title: "An extra location could not be set up",
    headline: "{clinicName} added an extra location[ (location {count})] that is still not set up",
    whatHappened:
      "{clinicName} added an extra location[ (location {count})] that is still not set up. Either its charge was recorded and making it active failed, or the hourly check could not settle with Stripe whether it was charged at all. The location is not answering yet, and a charge that was taken stands.",
    whyItMatters:
      "If the charge was taken, the clinic is paying for a location that does not exist yet. The hourly check tries to finish it on its own; if it cannot, this waits until someone retries it.",
    steps: [
      "Open the clinic's Billing tab: the Needs attention box names the location and the day it was charged, and A location waiting to be set up shows it.",
      "Press Retry the location setup under A location waiting to be set up. It finishes the location, or clears a request that never charged; it never charges again.",
      "Tell the owner the same day if Retry the location setup fails again, with this alert's code: the location then needs a hand on our side, and whether the clinic is owed a refund or a credit is the owner's call.",
      "Check the Billing tab again. You are done when the Needs attention box no longer names the location.",
    ],
  },
  // lib/billing/connect-events.ts, after the third failure of one event from
  // the clinic's own Stripe account: a deposit session, or the clinic
  // deauthorizing our application (applying that switches deposits off and
  // closes open links, lib/billing/connect.ts applyDeauthorization; parked,
  // it does neither). `clinicId` is null when the event never resolved to a
  // clinic.
  connect_event_dead_lettered: {
    title: "A deposit or disconnect event from Stripe is parked",
    headline: "A deposit or disconnect event[ for {clinicName}] could not be applied and is parked",
    whatHappened:
      "A deposit or disconnect event[ for {clinicName}] could not be applied and is parked. Stripe told us something about a clinic's own Stripe account: a deposit payment link's outcome (paid, failed or expired), or the clinic disconnecting our access to it. Applying it failed on every try, so it is parked, and nothing tries it again on its own.",
    whyItMatters:
      "A deposit itself is in the clinic's own Stripe account either way, but our record of it may be wrong: a booking may still show its deposit unpaid, or a payment link open. If the clinic disconnected its account, deposits stay switched on here and payment links may still be offered on an account we can no longer use.",
    steps: [
      "Open the clinic's Billing tab if this alert names a clinic, and find the event under Parked Stripe events, marked Connect: its type, its failures and a short reason are on its row. If it names none, open the System page: Stripe Connect events parked under Requires your attention counts it, with how long the oldest has waited, though nothing there replays it. Tell the owner today, since the event shows on no Billing tab.",
      "Press Replay on the row. The event is fetched again from the clinic's own Stripe account and applied; if that fails, it stays listed as failed with the new reason, and nothing retries it by itself.",
      "Check Deposits and Stripe Connect on the same tab if the event's type says the application was deauthorized: the clinic revoked our access. Ask the owner whether to press Disconnect Stripe there, which switches deposits off and closes open payment links, and tell the owner today if the replay fails again.",
      "Check Parked Stripe events on the Billing tab again. You are done when the event is gone from the list.",
    ],
  },
  // lib/billing/annual-overage.ts, once per clinic, month and failure: the
  // invoice for a closed month's overage could not be made in Stripe. The
  // annual-overage-invoice job (05:00 UTC daily, lib/scheduler/tick.ts)
  // retries every pending or failed month while it is on and alerts each
  // failure; a declined card is not one (the invoice is left open for
  // dunning). `windowStart` is the month's first day.
  overage_invoice_failed: {
    title: "An annual clinic's overage could not be invoiced",
    headline: "{clinicName}'s extra usage[ for the month starting {windowStart}] could not be invoiced",
    whatHappened:
      "{clinicName}'s extra usage[ for the month starting {windowStart}] could not be invoiced. It is on an annual plan and used more than its allowance, and making the invoice for that extra in Stripe failed. The job that invoices overage tries again every day at 05:00 UTC while it is on, and tells you after each failure.",
    whyItMatters:
      "The clinic has used more than it paid for and has not been billed for it. This is Stripe refusing to make the invoice at all; a declined card is not this failure, since a declined card leaves the invoice open for Stripe to chase.",
    steps: [
      "Open the clinic's Billing tab and find the month under Annual overage invoices: its amount, its status and a short reason are on its row.",
      "Check the annual-overage-invoice row on the Jobs page under System reads on. If it reads off, nothing retries this month by itself.",
      "Press Retry the invoice on the row to try now rather than wait for tomorrow's run. It picks up any invoice the first attempt left in Stripe rather than making a second one.",
      "Tell the owner the same day if Retry the invoice fails again, with the reason on the row: the fix is on our side or in Stripe's settings, not the clinic's.",
      "Check the row under Annual overage invoices again. You are done when it reads invoiced.",
    ],
  },
  // lib/billing/stripe-actions.ts setAutoRenew: auto-renew turned off inside
  // the first-period refund window (FIRST_PERIOD_REFUND_DAYS, 14). The
  // cancel_scheduled email promised the clinic we would write by the next
  // business day to arrange the refund.
  first_period_refund_due: {
    title: "A clinic is owed its first-period refund",
    headline: "{clinicName} turned auto-renew off and is owed its first period back",
    whatHappened:
      "{clinicName} turned auto-renew off and is owed its first period back. Auto-renew went off within fourteen days of the plan starting, so under the Terms its first period's fee is due back in full, and the email it received promises we will write by the next business day to arrange it.",
    whyItMatters:
      "A promise with a day on it. The refund also cancels the plan at once, so it must be the clinic's settled choice, and money is the owner's call.",
    steps: [
      "Open the clinic's Billing tab: the Needs attention box says the refund is due and the day its window closes.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and confirm it wants to leave. If it wants to stay, press Turn auto-renew on, on the Billing tab, and no refund is due.",
      "Ask the owner for the go-ahead before refunding anything: the refund under Refund under Terms § 5 moves real money and cannot be undone.",
      "Press Preview the amount under Refund under Terms § 5 with First period, plan cancelled selected, type the amount shown to confirm it, give a reason and press the button naming the amount. It pays the first period back and cancels the plan at once; the setup fee is never refunded.",
      "Email the clinic from hello@ by the promised day to say what was done. You are done when the Plan card shows Refunded under § 5.",
    ],
  },
  // lib/billing/requests.ts planStart: the start went through while the
  // subscription was set to cancel at the period's end (R5). Both stand: one
  // period is charged, then the account closes.
  plan_start_after_cancel: {
    title: "A plan started while set to cancel",
    headline: "{clinicName} was charged its first period on a plan already set to cancel",
    whatHappened:
      "{clinicName} was charged its first period on a plan already set to cancel. Its plan started while its subscription was set to cancel at the end of that period. Both stand: it pays for one period, then the account closes.",
    whyItMatters:
      "If the clinic meant to leave, the first period may be due back under the Terms, within fourteen days of the start. If it meant to stay, auto-renew needs turning back on before the period ends.",
    steps: [
      "Open the clinic's Billing tab: the Plan card shows auto-renew off and the day the account closes.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask which it wants: to stay, or to leave at the end of the period.",
      "Press Turn auto-renew on, on the Billing tab, if it wants to stay. Nothing else is needed.",
      "Ask the owner for the go-ahead on a first-period refund if it wants to leave and the Billing tab shows the refund window open. You are done when auto-renew is on, or the clinic has confirmed it is leaving and any refund is settled.",
    ],
  },
  // lib/billing/answering.ts, once per location: its billing clinic is in
  // another practice, which the answer gate treats as no billing at all.
  // There is no console control for the pointer; it is a data change.
  billing_pointer_outside_practice: {
    title: "A location is billed to another practice",
    headline: "{clinicName} is billed to another practice, so AYA is not answering for it",
    whatHappened:
      "{clinicName} is billed to another practice, so AYA is not answering for it. Its record says its bills go to a clinic in a different practice, which AYA treats as no billing at all: it does not answer this location's calls or messages, and passes them to the clinic instead.",
    whyItMatters:
      "Patients reaching this location get the clinic's own line or its contact form, not AYA, until the record is corrected. No charge is wrong; the pointer is.",
    steps: [
      "Open the clinic's Billing tab: the line at the top names the clinic it is billed on, with a link to that clinic's billing.",
      "Open that clinic from the Clinics page. If it is not part of the same practice, this location's billing clinic is wrong.",
      "Tell the owner today: there is no button for this on the Billing tab or anywhere else in the console. Which clinic a location is billed on is a data change the owner makes.",
      "Check the Billing tab after the change. You are done when it names a clinic of the same practice, and AYA answers the location again.",
    ],
  },
  // lib/billing/stripe-actions.ts commitRefund, kind first_period_cancel:
  // the refund was made and the cancellation recorded, but the job that
  // carries cancellations out (billing-requests) is switched off, on
  // purpose: turning it on runs every waiting billing change for every
  // clinic. A subscription cancelled by hand in Stripe leaves the Cancel now
  // row pending while the job is off.
  refund_cancel_job_off: {
    title: "A refunded plan is still billing",
    headline: "{clinicName} was refunded, but its plan still bills: the cancellation job is off",
    whatHappened:
      "{clinicName} was refunded, but its plan still bills: the cancellation job is off. Its first period was refunded and its cancellation recorded, but the job that carries cancellations out is switched off, so its subscription is still active in Stripe and will bill again.",
    whyItMatters:
      "The clinic was told its plan is cancelled. Every period that passes with the switch off charges it for a plan it no longer has.",
    steps: [
      "Ask the owner which to do, since both need the owner's say. Pressing Turn on for the billing-requests row on the Jobs page under System runs this cancellation within a minute, without proration, but also carries out every waiting billing change for every clinic, plan starts that charge cards included.",
      "Cancel this one subscription in Stripe's Dashboard yourself, without proration, if the owner says to leave the job off. The Cancel now row under Billing requests then stays pending while the job is off, which is expected.",
      "Check the clinic's Billing tab. You are done when the Plan card's title reads Plan — canceled.",
    ],
  },
  // The hourly location-quantity check (lib/billing/location-quantity.ts),
  // once per episode: Stripe's quantity on the package item is not what the
  // account should pay for, its active locations plus one being added whose
  // charge is recorded (expectedLocations). The Plan card's Locations row is
  // entitlements.locations (lib/ops/billing.ts), a third number, recorded at
  // the last change. `windowStart` is when the episode was first seen.
  location_quantity_drift: {
    title: "Stripe bills a different number of locations",
    headline: "{clinicName} is billed for {billedCount:location}[, not the {locationCount} it should be]",
    whatHappened:
      "{clinicName} is billed for {billedCount:location}[, not the {locationCount} it should be]. Stripe's count differs from what the account should pay for: its active locations, plus one being added whose charge is recorded. Nothing was changed: the hourly check only reads[, and first saw this on {windowStart}].",
    whyItMatters:
      "Too many billed means the clinic is overcharged and may be owed a refund; too few means it answers for a location it does not pay for. Either way the next invoice is wrong.",
    steps: [
      "Open the clinic's Billing tab: the Needs attention box says whether a location is still being added. Locations on the Plan card is the count the account recorded at its last change, which can differ from both numbers above.",
      "Wait for the next hourly check if the Needs attention box says a location is still being added: the two counts are allowed to differ for the minutes that takes.",
      "Check the subscription's quantity in Stripe's Dashboard against the count this alert says the clinic should pay for, and decide which side is wrong. Ask the owner before changing the quantity in Stripe or refunding anything: both are the owner's call, and the Billing tab changes neither.",
      "Check the Billing tab after the fix: a second alert says when Stripe's count matches again. You are done when it arrives, and any refund or credit for the time it lasted is settled.",
    ],
  },
  // The same check, once per episode, the first hour the two counts agree
  // again. `windowStart` is the episode's start, so it names the alert it closes.
  location_quantity_agrees: {
    title: "Stripe's location count matches again",
    headline: "{clinicName}'s location count in Stripe matches again[: {locationCount:location}]",
    whatHappened:
      "{clinicName}'s location count in Stripe matches again[: {locationCount:location}]. Stripe now bills it for the number of locations it should pay for.[ The mismatch first seen on {windowStart} has ended.]",
    whyItMatters:
      "This closes the earlier alert. Nothing is left to do unless the clinic was overcharged while the two disagreed.",
    steps: [
      "Check the clinic's Billing tab: Locations on the Plan card is what the account recorded at its last change, which can still differ from what Stripe bills.",
      "Ask the owner whether a refund or a credit is owed for the time the counts disagreed, if Stripe billed too many. Press Record in the Touch log on the clinic's Care tab to note the answer. You are done once that is settled, or if nothing was overcharged.",
    ],
  },
  // lib/agreements/termination.ts, once per billing clinic: the practice
  // ended its agreement for a reason the agreement refunds (BAA 1.3.0 clause
  // 17 ¶3). tests/ops-alert-wording.test.ts pins two phrases below: "Confirm
  // it before the practice's data is destroyed" and "by hand in the Stripe
  // Dashboard".
  agreement_refund_due: {
    title: "A terminated practice is owed a refund",
    headline: "{clinicName}'s agreement ended for a reason that refunds any fees paid past the end",
    whatHappened:
      "{clinicName} is owed a refund for the time after its agreement ended. Its subscription is already being cancelled.",
    whyItMatters:
      "Confirm it before the practice's data is destroyed, at the earliest 29 days after the termination: destruction removes the billing records the console refunds from, and after it the refund has to be made by hand in the Stripe Dashboard.",
    steps: [
      "Open the clinic's Care tab and read the Offboarding card: it names the day the data is destroyed, which is your deadline.",
      "Ask the owner for the go-ahead before refunding anything: the refund under Refund under Terms § 5 moves real money and cannot be undone.",
      "Press Preview the amount under Refund under Terms § 5 on the clinic's Billing tab, with Agreement terminated selected: it shows the fees paid for time after the agreement ended.",
      "Check the amount Preview the amount shows, type it to confirm, give a reason and press the button naming the amount. If the preview also lists money to settle by hand, that part was paid outside card payments and is refunded in Stripe's Dashboard, with the owner's go-ahead for that part too.",
      "Check the Billing tab again: a repeat is refused once the refund is recorded. You are done when the refund is recorded, before the destruction day.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
