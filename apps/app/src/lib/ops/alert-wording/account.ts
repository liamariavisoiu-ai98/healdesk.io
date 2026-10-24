import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "account" section of docs/on-call.md's alert runbook. The Account tab
 * (apps/web app/admin/clinics/[clinicId]/account) shows the one address, every
 * address change with why it closed, and the two acts, each behind a call
 * back and a fresh authenticator code. The security log has no console page,
 * so the sign-in help steps read hello@'s structured email instead.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/sign-in/address-change.ts applyChange: Stripe not configured, or it
  // refused the new email. Hourly while it lasts.
  address_change_stalled: {
    title: "A clinic's address change is waiting on Stripe",
    whatHappened:
      "{clinicName} is changing the one address on its account. The change is confirmed and its 72 hours are up, but Stripe would not take the new email for the clinic's customer, or Stripe is not set up on this host. Nothing has moved yet; it is tried again every hour, and this alert repeats each hour while it lasts.",
    whyItMatters:
      "Until it goes through, the clinic's sign-in, invoices and agreement notices still go to the old address, which the clinic may no longer have.",
    steps: [
      "Open the clinic's Account tab and read The clinic's address: the open change shows the new address and when it was due to take effect.",
      "Open System and then Map and check the Stripe key is present on the app host. If it is missing, tell the owner: only the owner pastes it.",
      "Check the clinic's customer in Stripe if the key is present: another customer may already use the new email, or the customer may be gone. Put it right there, and the next hourly run applies the change; watch The clinic's address on the Account tab.",
      "Press Stop this change on the Account tab only if the clinic no longer wants it. You are done when The clinic's address shows the new address as applied.",
    ],
  },
  // The same file, failChange and resolveFailed: address_taken or
  // sign_in_changed, both closed for good.
  address_change_failed: {
    title: "A clinic's address change was closed without effect",
    whatHappened:
      "{clinicName} asked to change the one address on its account, and the change could not take effect, so it was closed. Either the new address already signs in to healdesk for another account, or the sign-in's address had moved some other way since.",
    whyItMatters:
      "The clinic still signs in, is billed and gets notices at the address it has now, which it may be trying to leave. Nothing retries: a person has to agree a new address with the clinic.",
    steps: [
      "Open the clinic's Account tab and read The clinic's address: the closed change is listed with why it failed, and the address the account has today.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and agree the address it wants. If that address is another account's sign-in, it needs a different one.",
      "Use Change the address on the Account tab to enter the agreed address, with a fresh code from your authenticator, only after that call: both addresses are told, and it takes effect in 72 hours.",
      "Check The clinic's address on the Account tab. You are done when the new change is listed and moving, or the clinic decides to keep its address.",
    ],
  },
  // lib/sign-in/help.ts: once a UTC day per clinic and code, for an address
  // that is an account's. `code` is not printable; hello@'s email says why.
  sign_in_help_unmatched: {
    title: "Someone asked for sign-in help and got no link",
    whatHappened:
      "Someone used the I can't get in page with {clinicName}'s address[ on {windowStart}], and no link was sent. The billing detail they gave did not match the account, the account has nothing to check it against yet, or Stripe could not be asked. The page answers everyone the same way, so they were not told; this is today's first such request for this clinic.",
    whyItMatters:
      "It may be the clinic's own staff locked out, or someone else trying the clinic's address. A sign-in link may only ever go to the address on the account, and only after a call back to the clinic's published number.",
    steps: [
      "Read the email hello@ received from the I can't get in page about this clinic: it says why no link went and whether the clinic name typed matched. Then open the clinic's Account tab and read The clinic's address.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask whether someone there is trying to get in. Do not send anything before that call.",
      "Tell the clinic, if it was them, to ask for a sign-in link at the sign-in page with the address shown under The clinic's address: that is the normal way in.",
      "Use Change the address on the Account tab if the clinic has lost that address, or Send a link to add a device if it has lost every device, each with a fresh code from your authenticator.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic is in, or has confirmed nobody there asked.",
    ],
  },
  // The same file, sendAccessRequest: the day's cap on I3 emails to hello@.
  // No clinic, so no console link.
  access_requests_capped: {
    title: "Sign-in help reached its daily cap of requests to us",
    whatHappened:
      "The I can't get in page has sent hello@ as many access requests as it may in one day.[ The cap is {count:request} a day.][ Today is {windowStart} (UTC).] Further unmatched requests today reach nobody by email until tomorrow; each is still recorded in the security log.",
    whyItMatters:
      "The cap keeps a flood from the form from using up the day's emails that sign-in links and urgent alerts need. Reaching it means several clinics locked out at once, or someone trying many addresses.",
    steps: [
      "Read today's alerts titled Someone asked for sign-in help and got no link: each names its clinic. Then open each clinic's Account tab and read The clinic's address.",
      "Phone each clinic on its published number, shown under Phone line on its Setup tab, and ask whether its staff are locked out. Help the genuine ones as that alert's steps say.",
      "Tell the owner if the requests are not from the clinics: a flood from one place is an incident to consider, opened from a clinic's Care tab with Open incident and start the clock.",
      "Press Record in the Touch log on each clinic's Care tab to note the calls. You are done when every clinic that asked is in, or the owner has decided about the flood; the cap resets tomorrow.",
    ],
  },
  // lib/billing/reconcile.ts and requests.ts: once per account, ever.
  // `count` is the account's locations; `channel` is not printable.
  step_up_phone_held: {
    title: "Phone is held off a plan with more than one location",
    whatHappened:
      "{clinicName} has phone answering, or due to join its price, and its account has more than one location, or one being added[ ({count} on its plan)]. Phone is billed per location and each location needs its own AYA number, which is not built yet, so phone was not added to the price and nothing was charged for it.",
    whyItMatters:
      "The clinic gets phone without paying for it until phone per location exists. Nothing in the console lifts the hold; a person decides what happens meanwhile.",
    steps: [
      "Open the clinic's Billing tab and read Plan: Locations says how many, and Billed says what the price covers today. Channels shows phone in service.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and explain phone cannot be added to its price while it has more than one location. Agree whether phone stays on meanwhile.",
      "Tell the owner what was agreed, naming the clinic's Billing tab: whether phone stays on unbilled, or the clinic switches phone off in its own Settings, is the owner's call. Do not change the plan in Stripe by hand.",
      "Press Record in the Touch log on the clinic's Care tab to note the decision. You are done when the owner has decided and the clinic knows.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
