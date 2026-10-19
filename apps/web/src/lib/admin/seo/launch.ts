/**
 * What the public copy promises that is not yet on, and what is left to turn
 * it on.
 *
 * The owner's rule of 19 October 2026: client-facing copy states a feature as
 * on before it is switched on (phrased as design where a page describes
 * behaviour, "AYA is designed to ..."), never the other way round, and this
 * list is how the gap is tracked. No clinic goes live while an item here that
 * blocks go-live is open. /admin/seo shows it; update an item in the commit
 * that changes what it describes, and move it to `on` only when the code
 * does it in production.
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
    id: "urgent-alert",
    promise: "An urgent message goes at once to the contact the clinic names",
    where: "Terms section 2, homepage FAQ, Outcomes, How AYA is built to behave, portal Settings",
    status: "owner",
    left: "Built: on calls, website chat, Instagram, Messenger and WhatsApp the urgent alert is queued in the outbox with the message and sent the moment it commits, to the clinic's one address, as a pointer into the portal; the reply says the team was told only once it is queued and the sender is on. Left: deploy apps/app, turn on the billing-notices job in the console (it also releases any queued billing emails), check RESEND_API_KEY is in Parameter Store, then send one urgent message per channel on a synthetic clinic and check the email arrives. It moves to On once that production test passes.",
    evidence: "apps/app/src/lib/notices/booking-alerts.ts, apps/app/src/lib/notices/urgent-alert-live.ts, apps/app/src/lib/email/templates/urgent.ts, apps/app/tests/booking-alerts.test.ts",
    blocksGoLive: true,
  },
  {
    id: "handover-alert",
    promise: "A request to speak to a person alerts the contact the clinic named",
    where: "Terms section on requests for a person, portal Settings",
    status: "owner",
    left: "Built: on a call or a website chat, a request for a person queues one handover alert per conversation to the clinic's one address, and the conversation stays escalated. Instagram, Messenger and WhatsApp have no handover signal and raise none; the Terms promise it for callers and website visitors. Left: deploy apps/app and turn on the billing-notices job, then test a handover on a call and a website chat in production.",
    evidence: "apps/app/src/lib/chat/web-chat.ts, apps/app/src/lib/voice/retell.ts, apps/app/src/lib/email/templates/handover.ts",
    blocksGoLive: true,
  },
  {
    id: "staff-booking-alerts",
    promise: "Booking requests, deposits to collect and calendar checks reach the clinic's staff the moment they happen",
    where: "Portal Settings (Alerts card)",
    status: "owner",
    left: "Built: every booking request from a call, a website chat, a Meta message or the booking engine, every deposit left for staff, and every booking the calendar did not confirm queue a pointer email in their own transaction, at any hour; the old desk email with its single-use link is gone. Left: deploy apps/app and turn on the billing-notices job; until the Bookings screen ships the link opens the conversation in Conversations.",
    evidence: "apps/app/src/lib/notices/booking-alerts.ts, apps/app/src/lib/email/templates/booking_request.ts, apps/app/src/lib/email/templates/deposit_to_collect.ts, apps/app/src/lib/email/templates/calendar_check.ts",
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
    status: "building",
    left: "Calls after a cancelled service, a settings failure and repeated model failures are being transferred to the direct line instead of closed.",
    evidence: "apps/app/src/lib/voice/retell.ts",
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
    left: "Turn enable_voice on in the infrastructure, set the Retell secret, apply, deploy, and make one test call on a synthetic clinic.",
    evidence: "infra/aws (enable_voice), apps/app/src/voice/server.ts",
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
    id: "baa-1-6-0-retention",
    promise: "The AI model provider's retention is as terms section 9 states it: no more than 30 days, flagged content up to two years, what the law requires for as long as it requires",
    where: "Terms section 9 and its annex, data deletion page, homepage FAQ, the business associate agreement signed at checkout",
    status: "owner",
    left: "Checkout still offers BAA 1.5.0, whose clause 13 gives the 30 days a purpose, law-required content two years and says the service cannot run with shorter retention, and terms section 1 lets the BAA win. Release BAA 1.6.0 (or send it to counsel first): move it to BAA_TEMPLATES[0] with approvedByCounsel true, decide the floor and any overlap after reading the marketing Sheet for anyone who signed 1.5.0, add the release migration as 0073 did, then restore terms section 9's \"The Business Associate Agreement states the same\" under a new LEGAL_VERSION. No clinic goes live under 1.5.0's retention clause.",
    evidence: "packages/catalog/src/baa.ts (template 1.6.0), docs/baa-v1.6.0.txt, docs/counsel/agreement-changes.md §16",
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
    id: "direct-booking-addendum",
    promise: "A clinic can elect direct booking under its agreement",
    where: "Setup, agreement",
    status: "owner",
    left: "The direct-booking addendum is drafted and marked not approved by counsel; approve it, or decide to release it without counsel as with the legal pages.",
    evidence: "packages/catalog/src/direct-booking-addendum.ts",
    blocksGoLive: true,
  },
];
