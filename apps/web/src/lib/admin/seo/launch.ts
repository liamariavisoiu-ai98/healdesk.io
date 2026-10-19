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
    where: "Terms section 2",
    status: "building",
    left: "The fixed urgent reply is live; the alert to the clinic's named contact is being sent instead of only recorded.",
    evidence: "apps/app/src/lib/notices/booking-alerts.ts",
    blocksGoLive: true,
  },
  {
    id: "never-say-meta",
    promise: "The clinic's never-say list applies on every channel",
    where: "Settings, How AYA is built to behave",
    status: "building",
    left: "Calls and website chat apply it; Instagram, Messenger and WhatsApp are being given the same list.",
    evidence: "apps/app/src/lib/meta/front-door.ts, apps/app/src/lib/assistant/guard.ts",
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
    where: "Setup wizard, forwarding-steps email, guide to call forwarding",
    status: "building",
    left: "The codes are being corrected against each carrier's own pages.",
    evidence: "packages/catalog/src/forwarding.ts",
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
    id: "direct-booking-addendum",
    promise: "A clinic can elect direct booking under its agreement",
    where: "Setup, agreement",
    status: "owner",
    left: "The direct-booking addendum is drafted and marked not approved by counsel; approve it, or decide to release it without counsel as with the legal pages.",
    evidence: "packages/catalog/src/direct-booking-addendum.ts",
    blocksGoLive: true,
  },
];
