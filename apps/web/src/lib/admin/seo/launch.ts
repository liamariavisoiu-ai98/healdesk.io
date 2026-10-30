/**
 * What the public copy promises that is not yet on, and what is left to turn
 * it on.
 *
 * The owner's rule of 19 October 2026: client-facing copy states a feature as
 * on before it is switched on (phrased as design where a page describes
 * behaviour, "AYA is designed to ..."), never the other way round, and this
 * list is how the gap is tracked. No clinic goes live while an item here that
 * blocks go-live is open: go-live is automatic (WP2) and waits on the
 * platform's `launch_promises` attestation, which /admin/compliance refuses
 * to enter while one is open (lib/admin/platform-compliance.ts), and which
 * should be withdrawn there when an item that blocks go-live is added.
 * /admin/seo shows it; update an item in the commit that changes what it
 * describes, and move it to `on` only when the code does it in production.
 *
 * Pure data: client components import it.
 */

export type LaunchStatus = "on" | "building" | "off" | "owner";

export type LaunchPromise = {
  id: string;
  /** The promise as the public copy makes it. */
  promise: string;
  /** Where it is made. */
  where: string;
  status: LaunchStatus;
  /** What stands between the promise and production, in one or two sentences. */
  left: string;
  /** Where in the repo the truth of it lives. */
  evidence: string;
  blocksGoLive: boolean;
};

export const STATUS_LABEL: Record<LaunchStatus, string> = {
  on: "On",
  building: "Being built",
  off: "Off",
  owner: "Needs you",
};

export const LAUNCH_PROMISES: readonly LaunchPromise[] = [
  {
    id: "direct-booking",
    promise: "AYA books into the clinic's Google Calendar during the conversation",
    where: "Homepage, pricing, terms section 2, How AYA is built to behave",
    status: "building",
    left: "The booking engine is wired into calls and website chat and is designed to be offered only when three things are true: the switch is on in the task environment, the owner's release of the direct-booking addendum (28 October 2026) is in the running build, and the addendum version matches. Left: the infra.yml apply, then deploy-app.yml after it (which rolls voice and needs the owner's word that no call is running or planned), and one live-verified booking. The switch and the release are set in Terraform (direct_booking_enabled, direct_booking_on_voice, direct_booking_addendum_released) and the catalog. The booking card in a clinic's Setup shows the three ticks live. Until the deploy has rolled, every channel takes booking requests for staff.",
    evidence:
      "apps/app/src/lib/booking/engine.ts, apps/app/src/lib/assistant/booking-tools.ts, apps/app/src/lib/assistant/prompt.ts, infra/aws/variables.tf (direct_booking_enabled), infra/aws/locals.tf (direct_booking_environment), docs/design/launch-readiness-2026-10-27/db-1-direct-booking-switch.md",
    blocksGoLive: true,
  },
  {
    id: "deposit-link-chat",
    promise: "In website chat AYA sends the clinic's own deposit link",
    where: "Homepage, pricing, terms section 2",
    status: "building",
    left: "The deposit link exists and is being sent from website chat after a booking.",
    evidence: "apps/app/src/lib/booking/deposit-gate.ts, apps/app/src/lib/billing/deposit-link.ts",
    blocksGoLive: true,
  },
  {
    id: "deposit-link-meta",
    promise:
      "On Instagram, Messenger and WhatsApp AYA is designed to send the clinic's own deposit link",
    where: "The demo call (Aya's description of what she does and where healdesk sits), terms sections 2 and 9, privacy section 12, How AYA is built to behave",
    status: "building",
    left: "Built: after staff confirm a Meta request inside its window, the clinic's link is sent as fixed text (lib/meta/deposit-link.ts). Waits, as deposit-link-chat does, on Stripe Connect in production (STRIPE_CONNECT_CLIENT_ID), so no clinic can connect yet. Moves to on in the commit after Connect is configured and a live test on the demo clinic sends a link.",
    evidence:
      "apps/app/src/lib/meta/deposit-link.ts, apps/app/src/lib/meta/booking-requests.ts (decideWithin, decideBookingRequest), apps/app/src/lib/meta/front-door.ts, apps/app/src/lib/voice/demo-facts.ts (DEPOSIT_CLAIM)",
    blocksGoLive: true,
  },
  {
    id: "web-chat-on-paste",
    promise: "You paste one line on your website, and AYA is designed to start answering there",
    where: "Set-up wizard and welcome email (website chat)",
    // On by the owner's word of 29 October 2026, in the commit that makes
    // production do it: it does so once migration 0138 is deployed.
    status: "on",
    left: "The line confirms itself: two opens of the chat bubble from the clinic's own website (the site, www or any subdomain), at least five minutes apart, count website chat's step as done, and so does an operator's tick on the clinic's Setup tab, which stays as the fallback with the console asked on the first open. The portal says which confirmed it. Live still waits on setup, the audit, the platform's attestations and go-live; until then the bubble tells visitors to call the practice. Takes effect in production with migration 0138's deploy; not yet tried on a real clinic's website.",
    evidence:
      "apps/app/src/widget/v1.js, apps/app/src/lib/channels/widget-sighting.ts (noteWidgetSighting, readWidgetSighting), apps/app/drizzle/0138_web_widget_sightings.sql (app_web_widget_seen), apps/app/src/lib/channels/events.ts (confirmWidgetOnSite), apps/app/tests/channel-events.test.ts (WEBCHAT-2), apps/app/tests/setup-pages.test.tsx",
    blocksGoLive: false,
  },
  {
    id: "urgent-alert",
    promise: "An urgent message goes at once to the contact the clinic names",
    where: "Terms section 2",
    status: "on",
    left: "Queued with the urgent screen's own writes and sent in-process right after commit, on calls, website chat and Meta, to the clinic's account address. Like every email, the first send included, it goes only while the billing-notices job is on and the host's email key is set: the alert-sender item below.",
    evidence:
      "apps/app/src/lib/notices/booking-alerts.ts, apps/app/src/lib/email/outbox.ts (deliverCriticalAfterCommit), apps/app/tests/live-alerts.test.ts",
    blocksGoLive: true,
  },
  {
    id: "alert-sender-on",
    promise: "Every alert AYA promises the clinic reaches it, the urgent one included",
    where: "Terms section 2, AYA's urgent reply (\"I've told the team\")",
    status: "owner",
    left: "Switch on the billing-notices job (System › Jobs, /admin/system/jobs) and set RESEND_API_KEY on the host before the first clinic goes live: every booking alert waits on both, and while they are off AYA still tells an urgent caller the team has been told. Go-live does not check the switch itself, and nothing stops it being switched off later. If an urgent alert cannot be queued at all, you are emailed at once to phone the clinic, and neither the call nor website chat says the team was told.",
    evidence:
      "apps/app/src/lib/email/outbox.ts, apps/app/src/lib/notices/booking-alerts.ts (URGENT_ALERT_DELIVERED), apps/app/src/lib/scheduler/jobs.ts (JOB_BILLING_NOTICES)",
    blocksGoLive: true,
  },
  {
    id: "never-say-meta",
    promise: "The clinic's never-say list applies on every channel",
    where: "Settings, How AYA is built to behave",
    status: "on",
    left: "Built: Instagram, Messenger and WhatsApp read the same list as calls and website chat (the defaults, then the clinic's own, approved script or not), list it in the prompt, and refuse a reply containing an entry with the same matcher (neverSayIn). The Meta QA gate (npm run qa:meta) passed live on 22 October 2026 (13 of 13, one sample) and the code is deployed. Moved to On on 28 October 2026 on your word that this evidence is enough: the block on a reply is code, not the prompt, and one live sample is the evidence behind it.",
    evidence:
      "apps/app/src/lib/meta/front-door.ts, apps/app/src/lib/assistant/guard.ts, apps/app/tests/meta-screen-and-greeting.test.ts",
    blocksGoLive: true,
  },
  {
    id: "failure-direct-line",
    promise: "Every failure ends with calls going to a direct clinic line",
    where: "Terms, portal behaviour screens, CLAUDE.md",
    status: "owner",
    left: "Inside our endpoint every failure transfers to the direct line wherever the line can be known, a database outage included, and never to a line that forwards back to AYA (the clinic's published or AYA number), which counts as none; with none known the caller hears a closing line. Left for you: paste the Retell key (HEALDESK_RETELL_API_KEY, once Retell's agreement is signed), so the hourly sync gives each AYA number the clinic's direct line as Retell's fallback; confirm the plan has Retell's outage mode, the step for our endpoint being down, and make one test call on a made-up clinic with it on. Retell itself being down still means each clinic removing its forwarding by hand.",
    evidence:
      "apps/app/src/lib/voice/retell.ts, apps/app/src/lib/voice/fallback-line.ts, apps/app/src/lib/voice/retell-fallback-sync.ts, apps/app/src/lib/billing/answering.ts (patientDataRefused), docs/on-call.md",
    blocksGoLive: true,
  },
  {
    id: "no-audio",
    promise: "healdesk keeps no call audio, and the voice provider holds a call for a day at most",
    where: "Opening line on every call, privacy page, How AYA is built to behave",
    status: "building",
    left: "Each clinic's Retell agent is being created in code with Retell's storage on and a one-day limit, and the backstop deletes the call at Retell once healdesk has the transcript, so the promise does not depend on the Retell console. That agent code (lib/voice/retell-agent.ts) runs only from automatic provisioning, which is off (voice_provision_enabled is false in infra/aws/production.tfvars), so today the agents are made by hand. The wording on the opening line, the terms and privacy pages, the support chat and the guides now says this (22 October 2026); the opening line, the Spanish line and the written notice change in code with this wording, so the item stays building until the agent code is called and a test call proves the deletion.",
    evidence:
      "docs/counsel/state-disclosure.md decision 2, written for no audio kept, which the owner reversed on 21 October 2026: Retell now keeps each call's transcript and recording until the call has been processed. apps/app lib/voice/retell-agent.ts (agents written and read back with data_storage_setting everything and data_storage_retention_days 1, Retell's own deletion a day later; not yet called), lib/voice/backstop.ts and lib/voice/recording-alerts.ts (once the call and its sealed transcript are committed here, the backstop job deletes the call at Retell, retried; a call still at Retell 30 minutes after it ended is one alert on /admin/recordings, with a Delete at Retell button), tests/recording-alerts.test.ts and tests/voice-backstop.test.ts. lib/voice/agent-storage.ts (27 October 2026): before each delete the backstop reads back, GET only, the agent the call ran on at that version and raises voice_agent_storage when its retention is not one day or its storage setting is not everything, so an agent made by hand in Retell's console is checked on every call too (tests/agent-storage.test.ts); the owner's deletion check is docs/design/launch-readiness-2026-10-27/no-audio-run-sheet.md. The promise is now worded as: healdesk keeps no call audio, and the voice provider holds a call's transcript and recording only until healdesk has the transcript, and for no more than a day (22 October 2026, owner-approved); counsel has not reviewed it.",
    blocksGoLive: true,
  },
  {
    id: "forwarding-codes",
    promise: "Onboarding gives the right call-forwarding codes for each carrier",
    where: "Setup wizard, forwarding-steps email, Settings, support chat, guide to call forwarding",
    status: "owner",
    left: "Built: the codes are corrected against each carrier's own pages and pinned by tests in the catalog and the guide, and the carrier's activation call on a Verizon home phone or a traditional AT&T landline is no longer read as lost caller ID. Left: once enable_voice is on, a test call on each carrier's line (Verizon *42 or *41, Spectrum Business Voice, AT&T's 1 for a long-distance number), and the guide's audit before it goes live; it stays a draft until then.",
    evidence:
      "packages/catalog/src/forwarding.ts, apps/web/src/lib/content/pieces/conditional-call-forwarding.ts, apps/app/src/lib/onboarding/forwarding-test.ts",
    blocksGoLive: true,
  },
  {
    id: "voice-service",
    promise: "Phone is live once call forwarding is set",
    where: "Pricing, setup",
    status: "owner",
    left: "Turn enable_voice on in the infrastructure, set the Retell secret, apply, deploy, and make one test call on the demo clinic, which may come before the agreements. Then, once every agreement in the chain is signed, turn voice_real_calls on, apply and deploy: until then the voice line answers only the demo clinic.",
    evidence:
      "infra/aws (enable_voice, voice_real_calls), apps/app/src/voice/server.ts, apps/app/src/lib/voice/test-calls.ts",
    blocksGoLive: true,
  },
  {
    id: "baa-chain",
    promise: "We sign a business associate agreement and handle patient data under it",
    where: "Every page that states it",
    status: "owner",
    left: "Countersign the business associate agreements with the model provider, Retell, the database host and AWS before the first real patient, and record each on /admin/compliance: go-live and the answer gate read all four.",
    evidence: "docs/hipaa-compliance.md, CLAUDE.md (BAA coverage)",
    blocksGoLive: true,
  },
  {
    id: "daily-summary",
    promise:
      "A summary email at the start of each working day, with every booking and booking request and every request still open; the week's first carries the weekly recap",
    where: "Settings → Alerts, the setup wizard, the spec's Daily summary switch",
    status: "owner",
    left: "Built: the summary (L13) and the recap (L14) are queued through the outbox. Switch on the daily-summary and weekly-recap jobs in /admin, with billing-notices (the sender), before the first clinic goes live: while they are off, a clinic with the summary on hears about a waiting request only when it is taken and when it expires.",
    evidence:
      "apps/app/src/lib/scheduler/daily-summary.ts, apps/app/src/lib/scheduler/weekly-recap.ts, apps/app/drizzle/0087_claims_and_summary.sql",
    blocksGoLive: true,
  },
  {
    id: "data-protection-agreement",
    promise:
      "A practice HIPAA does not cover signs a data protection agreement instead of a business associate agreement",
    where: "Is a cash-pay clinic covered by HIPAA?, How AYA is built to behave",
    status: "on",
    left: "Released by you on 20 October 2026 (dpa/1.0.0, with its calendar election form), without external counsel: checkout offers it to a veterinary practice and to a practice that answers No, provisioning binds it and go-live accepts it. Migration 0104 (dpa_release_1_0_0) is applied: the 22 October 2026 migration-state query read 112 applied, the journal's whole length then, and later deploys have run newer migrations after it. You approved moving this to On on 27 October 2026. Counsel's review before the first live DPA practice is still recommended.",
    evidence:
      "packages/catalog/src/dpa.ts, packages/catalog/src/agreement-kind.ts, apps/app/drizzle/0104_dpa_release_1_0_0.sql, docs/counsel/agreement-changes.md section 18",
    blocksGoLive: false,
  },
  {
    id: "baa-1-6-0-retention",
    promise:
      "The AI model provider's retention is as terms section 9 states it: no more than 30 days, flagged content up to two years, what the law requires for as long as it requires",
    where:
      "Terms section 9 and its annex, data deletion page, homepage FAQ, the business associate agreement signed at checkout",
    status: "building",
    left: "The owner released BAA 1.6.0 on 29 October 2026, without external counsel: BAA_1_6_0_RELEASED is true, so checkout offers 1.6.0, the floor is 1.6.0 with no overlap, and terms section 9 says \"The Business Associate Agreement states the same\" under LEGAL_VERSION 2026-10-29.5. Production does not do it yet: the release migration (apps/app/drizzle/0136_baa_release_1_6_0.sql) moves the database's go-live check to 1.6.0 only when deploy-app.yml runs it, and until then the running apps/app image still holds 1.6.0 as a draft and refuses to provision it. It moves to On in the commit that records that deploy. No clinic goes live under 1.5.1's retention clause.",
    evidence:
      "packages/catalog/src/baa.ts (BAA_1_6_0_RELEASED, template 1.6.0), apps/app/drizzle/0136_baa_release_1_6_0.sql, docs/baa-v1.6.0.txt, docs/counsel/agreement-changes.md section 17",
    blocksGoLive: true,
  },
  {
    id: "extra-locations",
    promise:
      "One AYA answers for every location of a practice, as one central assistant like a call centre, and each further location is added to the same plan from Billing, at the plan's price again plus its setup fee once, renewing on the same date",
    where:
      "Pricing (Prices are per location), Get AYA's package step and Review and pay, terms (More than one location), the portal's Billing (Add a location), the location-added email, the set-up wizard's first question",
    status: "building",
    left: "Locations are being built as rows inside one account, for the AYA Web Chat and AYA Meta Chat packages bought first (the extra-locations plan, slice 1). The account's locations table and the append-only acknowledgement table exist (drizzle/0109), every open account has its main location, and addLocation creates a pending location and records the acknowledgement before it charges anything; but AYA still knows one address and one set of hours, no conversation or booking request records a location, the acknowledgement is drafted and marked not released until its wording audit passes, and locationsReady is false for every package, so addLocation refuses and Billing's Add a location card states the price and the central model and offers no button. It moves to On in the commit that switches locations on for the chat packages, once that release is deployed. One location works without it, so it does not hold go-live.",
    evidence:
      "apps/app/src/lib/locations.ts (locationsReady), apps/app/src/lib/billing/stripe-actions.ts (addLocation), apps/app/src/app/c/[slug]/billing/page.tsx, packages/catalog/src/central-assistant-acknowledgement.ts",
    blocksGoLive: false,
  },
  {
    id: "location-phone",
    promise:
      "Each location of a practice that buys phone forwards its own line to its own AYA number, and whenever AYA is not answering, that location's calls go to that location's own direct line",
    where:
      "Terms sections 2 and 8 and the first-month guarantee (Routed to it), the central-assistant acknowledgement",
    status: "building",
    left: "The extra-locations plan's slice 2, for the three packages with phone: an AYA number per location on the account's one agent; the answer gate reading the number dialled and that location's hours, direct line and coverage mode; Retell's fallback, the line the voice process remembers for a database outage and the loop guard kept per number; and each location's forwarding proved on its own line. Then your Retell check, on a made-up clinic, that the number dialled arrives on a forwarded call, and a number bought for each added location. Until then a package with phone shows a location's price in Billing and offers no button, and an account with several locations cannot move into one. One location works without it, so it does not hold go-live.",
    evidence:
      "apps/app/src/lib/voice/fallback-line.ts, apps/app/src/lib/voice/retell-fallback-sync.ts, apps/app/src/lib/billing/answering.ts, apps/app/src/lib/voice/backstop.ts",
    blocksGoLive: false,
  },
  {
    id: "location-calendar",
    promise:
      "A location after the first takes booking requests your team confirms, and nothing about it reaches Google Calendar",
    where:
      "The central-assistant acknowledgement (its requests-only statement), the business associate agreement's calendar paragraph",
    status: "building",
    left: "The calendar guard of the extra-locations plan (step 11): booking mode, offered times, holds, the engine's bookings and the desk's confirm refuse Google for any location after the first, a confirmed booking there is recorded with no calendar so it occupies none of the first location's times, and the database's calendar write guard refuses such a row too. Until locations exist no account has a second one, so nothing is wrong today. Calendars per location, each under its own calendar election, are a later item. One location works without it, so it does not hold go-live.",
    evidence:
      "apps/app/src/lib/booking/mode.ts, apps/app/src/lib/meta/booking-requests.ts (deskSpanFree), apps/app/src/lib/booking/calendar.ts, packages/catalog/src/central-assistant-acknowledgement.ts",
    blocksGoLive: false,
  },
  {
    id: "direct-booking-addendum",
    promise: "A clinic can elect direct booking under its agreement",
    where: "Setup, agreement",
    status: "owner",
    left: "The owner released the direct-booking addendum on 28 October 2026, without external counsel as with the legal pages. Releasing it adds nothing for a clinic to sign today: no page renders an election and booking depends on the location's calendar terms plus the three-part check.",
    evidence: "packages/catalog/src/direct-booking-addendum.ts",
    blocksGoLive: true,
  },
  {
    id: "phone-flips-live",
    promise:
      "Phone goes live by itself once a call forwarded from the clinic's main line reaches AYA",
    where: "Setup wizard (phone), Settings → Channels",
    status: "owner",
    left: "Built: a call the carrier says it forwarded from the clinic's published number (its Diversion or History-Info header), with the caller's number kept, meets phone's forwarding step with no test window and no operator, and the clinic's own Test it now does the same from the wizard or Settings. Left: once enable_voice is on, check on a forwarded test call that Retell passes the carrier's Diversion or History-Info header on its numbers; where it does not, Test it now is how phone goes live.",
    evidence:
      "apps/app/src/lib/voice/forwarded-from.ts, apps/app/src/lib/onboarding/forwarding-test.ts, apps/app/src/lib/setup/forwarding-test-view.ts",
    blocksGoLive: false,
  },
  {
    id: "payment-link-text",
    promise:
      "After a call, AYA is designed to text the caller the clinic's own payment link, if the clinic turns that on",
    where: "Settings and the setup wizard (the payment-link text switch); Terms, Privacy, the checkout's Inbound only box, the demos and the support chat",
    status: "building",
    left: "Built in code on 30 October 2026, never sent. The sender is AWS End User Messaging SMS from one US toll-free number healdesk registers once (apps/app/src/lib/sms/send.ts, fixed words in PAYMENT_LINK_TEXT_TEMPLATE); after a call booking whose deposit is with the front desk, AYA is designed to offer the text, and the tool layer sends it once per booking, only after the caller's yes and their yes to the number read back, both read from her structured answer (lib/sms/payment-text.ts, the payment_link_texts ledger, drizzle/0141), through the contact policy's one-text gate (canSendPaymentLinkText). The switch unlocks, and the offer is made, only once HEALDESK_SMS_ORIGINATION_IDENTITY is set; it is __unset__ everywhere, so nothing is offered or sent. A clinic whose accepted agreement is older than BAA 1.6.0 or DPA 1.1.0 is never offered it, checked at the offer and again at the send (lib/sms/agreement.ts; DPA 1.0.0 still says no SMS). Left, in order, all the owner's: (0) ask AWS to move the account out of the SMS sandbox (production access); (1) buy the toll-free number and file its registration, sample message = the template, opt-in = the call's verbal yes, until AWS approves it (up to 15 business days); (2) apply the infra (infra.yml: the task role's sms-voice:SendTextMessage and the app/HEALDESK_SMS_ORIGINATION_IDENTITY parameter); (3) with voice_real_calls on, paste the number's phone-number id with put-external-secrets.sh and restart; (4) a real test call that receives the text, then move this item to on. Unverified until then: which identity forms SendTextMessage accepts, and whether one registration may send for many clinics.",
    evidence:
      "apps/app/src/lib/sms/send.ts, apps/app/src/lib/sms/payment-text.ts, apps/app/src/lib/sms/config.ts, apps/app/src/lib/portal/switch-rules.ts (the text's five checks), apps/app/src/lib/sms/agreement.ts, apps/app/src/lib/portal/switch-resets.ts (paymentLinkTextOffered), apps/app/src/lib/compliance/contact-policy.ts (canSendPaymentLinkText), apps/app/drizzle/0141_payment_link_texts.sql, apps/app/tests/payment-text.test.ts, infra/aws/iam.tf (SendThePaymentLinkText), packages/catalog/src/dpa.ts (DPA_1_1_0_RELEASED), apps/app/drizzle/0140_dpa_release_1_1_0.sql",
    blocksGoLive: false,
  },
  {
    id: "full-payment",
    promise:
      "A clinic can choose that AYA asks the patient to pay the full price instead of a deposit",
    where: "Settings and the setup wizard (what the assistant asks the patient to pay)",
    status: "building",
    left: "The choice is saved per clinic, needs the payment gateway, the calendar and Auto-confirm, and drops back to Deposit only (with an audit row, a notice and an email) when one is lost. fullPaymentActive() answers whether it may apply right now, but nothing calls it yet: the tool layer, the deposit link and the assistant's prompts still ask only for a deposit. Left: wire the tool layer and the prompts to it, test it on web chat and Meta, then move this item to on.",
    evidence:
      "apps/app/src/lib/portal/switch-resets.ts (fullPaymentActive), apps/app/src/lib/portal/switch-rules.ts, apps/app/src/lib/billing/deposits.ts",
    blocksGoLive: false,
  },
];
