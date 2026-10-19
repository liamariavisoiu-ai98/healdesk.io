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
    evidence: "docs/counsel/state-disclosure.md decision 2",
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
    left: "Countersign the business associate agreements with the model provider, Retell and the database host before the first real patient.",
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
    left: "The agreement is drafted and marked not released (isDpaReleased() is false), so every practice signs the business associate agreement today. Release it, as you released the business associate agreement versions, and checkout offers it by specialty.",
    evidence: "packages/catalog/src/dpa.ts, packages/catalog/src/agreement-kind.ts",
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
      "Each further location is added to the same plan from Billing, at the plan's price again plus its own setup fee, renewing on the same date",
    where:
      "Pricing (Prices are per location), Get AYA's package step and Review and pay, terms (More than one location), the portal's Billing (Add a location)",
    status: "building",
    left: "healdesk-io-58's Package C: addLocation is written, but createLocationClinic is a stub and LOCATION_CLINICS_READY is false, so addLocation refuses, and no path, the ops console's included, can add a location to a plan yet. Billing's Add a location card states the price and that locations are added from Billing, and offers its button only once the flag is on. It moves to On in the commit that flips the flag, once that release is deployed. One location works without it, so it does not hold go-live.",
    evidence:
      "apps/app/src/lib/location-clinic.ts (LOCATION_CLINICS_READY), apps/app/src/lib/billing/stripe-actions.ts (addLocation), apps/app/src/app/c/[slug]/billing/page.tsx",
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
