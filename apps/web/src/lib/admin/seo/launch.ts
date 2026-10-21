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
    left: "The booking engine is being connected to calls and website chat. Then the HEALDESK_DIRECT_BOOKING_ENABLED switch is set, the infrastructure applied and the app deployed.",
    evidence: "apps/app/src/lib/booking/engine.ts, apps/app/src/lib/assistant/prompt.ts, infra/aws/locals.tf",
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
    id: "web-chat-on-paste",
    promise: "You paste one line on your website, and AYA is designed to start answering there",
    where: "Set-up wizard and welcome email (website chat)",
    status: "building",
    left: "The line now loads the chat bubble, but website chat goes live only once an operator confirms in Ops that the line is on the clinic's site, and Ops is asked only when someone first opens the bubble there. Until then the bubble tells visitors to call the practice.",
    evidence: "apps/app/src/widget/v1.js, apps/app/src/lib/channels/events.ts (noteWidgetLoaded, confirmWidgetOnSite)",
    blocksGoLive: false,
  },
  {
    id: "urgent-alert",
    promise: "An urgent message goes at once to the contact the clinic names",
    where: "Terms section 2",
    status: "on",
    left: "Queued with the urgent screen's own writes and sent in-process right after commit, on calls, website chat and Meta, to the clinic's account address. Like every email, the first send included, it goes only while the billing-notices job is on and the host's email key is set: the alert-sender item below.",
    evidence: "apps/app/src/lib/notices/booking-alerts.ts, apps/app/src/lib/email/outbox.ts (deliverCriticalAfterCommit), apps/app/tests/live-alerts.test.ts",
    blocksGoLive: true,
  },
  {
    id: "alert-sender-on",
    promise: "Every alert AYA promises the clinic reaches it, the urgent one included",
    where: "Terms section 2, AYA's urgent reply (\"I've told the team\")",
    status: "owner",
    left: "Switch on the billing-notices job (Scheduled jobs in /admin/ops) and set RESEND_API_KEY on the host before the first clinic goes live: every booking alert waits on both, and while they are off AYA still tells an urgent caller the team has been told. Go-live does not check the switch itself, and nothing stops it being switched off later. If an urgent alert cannot be queued at all, you are emailed at once to phone the clinic, and neither the call nor website chat says the team was told.",
    evidence: "apps/app/src/lib/email/outbox.ts, apps/app/src/lib/notices/booking-alerts.ts (URGENT_ALERT_DELIVERED), apps/app/src/lib/scheduler/jobs.ts (JOB_BILLING_NOTICES)",
    blocksGoLive: true,
  },
  {
    id: "never-say-meta",
    promise: "The clinic's never-say list applies on every channel",
    where: "Settings, How AYA is built to behave",
    status: "owner",
    left: "Built: Instagram, Messenger and WhatsApp read the same list as calls and website chat (the defaults, then the clinic's own, approved script or not), list it in the prompt, and refuse a reply containing an entry with the same matcher (neverSayIn). Left: run the Meta QA gate (npm run qa:meta) with the live key and deploy apps/app; it moves to On once that deployment is live.",
    evidence: "apps/app/src/lib/meta/front-door.ts, apps/app/src/lib/assistant/guard.ts, apps/app/tests/meta-screen-and-greeting.test.ts",
    blocksGoLive: true,
  },
  {
    id: "failure-direct-line",
    promise: "Every failure ends with calls going to a direct clinic line",
    where: "Terms, portal behaviour screens, CLAUDE.md",
    status: "owner",
    left: "Inside our endpoint every failure transfers to the direct line wherever the line can be known, a database outage included, and never to a line that forwards back to AYA (the clinic's published or AYA number), which counts as none; with none known the caller hears a closing line. Left for you: paste the Retell key (HEALDESK_RETELL_API_KEY, once Retell's agreement is signed), so the hourly sync gives each AYA number the clinic's direct line as Retell's fallback; confirm the plan has Retell's outage mode, the step for our endpoint being down, and make one test call on a made-up clinic with it on. Retell itself being down still means each clinic removing its forwarding by hand.",
    evidence: "apps/app/src/lib/voice/retell.ts, apps/app/src/lib/voice/fallback-line.ts, apps/app/src/lib/voice/retell-fallback-sync.ts, apps/app/src/lib/billing/answering.ts (patientDataRefused), docs/on-call.md",
    blocksGoLive: true,
  },
  {
    id: "no-audio",
    promise: "No call audio is kept",
    where: "Opening line on every call, privacy page, How AYA is built to behave",
    status: "building",
    left: "Each clinic's Retell agent is being created with recording storage off in code, so the promise does not depend on the Retell console.",
    evidence:
      "docs/counsel/state-disclosure.md decision 2, written for no audio kept, which the owner reversed on 21 October 2026: Retell now keeps each call's transcript and recording until the call has been processed. apps/app lib/voice/retell-agent.ts (agents written and read back with data_storage_setting everything and data_storage_retention_days 1, Retell's own deletion a day later; not yet called), lib/voice/backstop.ts and lib/voice/recording-alerts.ts (once the call and its sealed transcript are committed here, the backstop job deletes the call at Retell, retried; a call still at Retell 30 minutes after it ended is one alert on /admin/recordings, with a Delete at Retell button), tests/recording-alerts.test.ts and tests/voice-backstop.test.ts. The promise's wording still says no audio is kept and needs the owner and counsel.",
    blocksGoLive: true,
  },
  {
    id: "forwarding-codes",
    promise: "Onboarding gives the right call-forwarding codes for each carrier",
    where: "Setup wizard, forwarding-steps email, Settings, support chat, guide to call forwarding",
    status: "owner",
    left: "Built: the codes are corrected against each carrier's own pages and pinned by tests in the catalog and the guide, and the carrier's activation call on a Verizon home phone or a traditional AT&T landline is no longer read as lost caller ID. Left: once enable_voice is on, a test call on each carrier's line (Verizon *42 or *41, Spectrum Business Voice, AT&T's 1 for a long-distance number), and the guide's audit before it goes live; it stays a draft until then.",
    evidence: "packages/catalog/src/forwarding.ts, apps/web/src/lib/content/pieces/conditional-call-forwarding.ts, apps/app/src/lib/onboarding/forwarding-test.ts",
    blocksGoLive: true,
  },
  {
    id: "voice-service",
    promise: "Phone is live once call forwarding is set",
    where: "Pricing, setup",
    status: "owner",
    left: "Turn enable_voice on in the infrastructure, set the Retell secret, apply, deploy, and make one test call on the demo clinic, which may come before the agreements. Then, once every agreement in the chain is signed, turn voice_real_calls on, apply and deploy: until then the voice line answers only the demo clinic.",
    evidence: "infra/aws (enable_voice, voice_real_calls), apps/app/src/voice/server.ts, apps/app/src/lib/voice/test-calls.ts",
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
    evidence: "apps/app/src/lib/scheduler/daily-summary.ts, apps/app/src/lib/scheduler/weekly-recap.ts, apps/app/drizzle/0087_claims_and_summary.sql",
    blocksGoLive: true,
  },
  {
    id: "data-protection-agreement",
    promise: "A practice HIPAA does not cover signs a data protection agreement instead of a business associate agreement",
    where: "Is a cash-pay clinic covered by HIPAA?, How AYA is built to behave",
    status: "owner",
    left: "Released by you on 20 October 2026 (dpa/1.0.0, with its calendar election form), without external counsel: checkout offers it to a veterinary practice and to a practice that answers No, provisioning binds it and go-live accepts it. Left: deploy apps/app (deploy-app.yml) so the dpa_release_1_0_0 migration reaches the host, then mark this on; counsel's review before the first live DPA practice is recommended.",
    evidence: "packages/catalog/src/dpa.ts, packages/catalog/src/agreement-kind.ts, apps/app/drizzle/0104_dpa_release_1_0_0.sql, docs/counsel/agreement-changes.md section 18",
    blocksGoLive: false,
  },
  {
    id: "baa-1-6-0-retention",
    promise: "The AI model provider's retention is as terms section 9 states it: no more than 30 days, flagged content up to two years, what the law requires for as long as it requires",
    where: "Terms section 9 and its annex, data deletion page, homepage FAQ, the business associate agreement signed at checkout",
    status: "owner",
    left: "Checkout still offers BAA 1.5.1, whose Subcontractors clause gives the 30 days a purpose, keeps law-required content two years and says the service cannot run with shorter retention, and terms section 1 lets the BAA win. Release BAA 1.6.0 (or send it to counsel first): move it to BAA_TEMPLATES[0] with approvedByCounsel true, decide the floor and any overlap after reading the marketing Sheet for anyone who signed 1.5.1, add the release migration as 0081 did, then restore terms section 9's \"The Business Associate Agreement states the same\" under a new LEGAL_VERSION. No clinic goes live under 1.5.1's retention clause.",
    evidence: "packages/catalog/src/baa.ts (template 1.6.0), docs/baa-v1.6.0.txt, docs/counsel/agreement-changes.md section 17",
    blocksGoLive: true,
  },
  {
    id: "extra-locations",
    promise:
      "One AYA answers for every location of a practice, as one central assistant like a call centre, and each further location is added to the same plan from Billing, at the plan's price again plus its setup fee once, renewing on the same date",
    where:
      "Pricing (Prices are per location), Get AYA's package step and Review and pay, terms (More than one location), the portal's Billing (Add a location), the location-added email, the set-up wizard's first question",
    status: "building",
    left: "Locations are being built as rows inside one account, for the AYA Web Chat and AYA Meta Chat packages bought first (the extra-locations plan, slice 1). The account's locations table and the append-only acknowledgement table exist (drizzle/0108), every open account has its main location, and addLocation creates a pending location and records the acknowledgement before it charges anything; but AYA still knows one address and one set of hours, no conversation or booking request records a location, the acknowledgement is drafted and marked not released until its wording audit passes, and locationsReady is false for every package, so addLocation refuses and Billing's Add a location card states the price and the central model and offers no button. It moves to On in the commit that switches locations on for the chat packages, once that release is deployed. One location works without it, so it does not hold go-live.",
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
    left: "The direct-booking addendum is drafted and marked not approved by counsel; approve it, or decide to release it without counsel as with the legal pages.",
    evidence: "packages/catalog/src/direct-booking-addendum.ts",
    blocksGoLive: true,
  },
  {
    id: "phone-flips-live",
    promise: "Phone goes live by itself once a call forwarded from the clinic's main line reaches AYA",
    where: "Setup wizard (phone), Settings → Channels",
    status: "owner",
    left: "Built: a call the carrier says it forwarded from the clinic's published number (its Diversion or History-Info header), with the caller's number kept, meets phone's forwarding step with no test window and no operator, and the clinic's own Test it now does the same from the wizard or Settings. Left: once enable_voice is on, check on a forwarded test call that Retell passes the carrier's Diversion or History-Info header on its numbers; where it does not, Test it now is how phone goes live.",
    evidence: "apps/app/src/lib/voice/forwarded-from.ts, apps/app/src/lib/onboarding/forwarding-test.ts, apps/app/src/lib/setup/forwarding-test-view.ts",
    blocksGoLive: false,
  },
];
