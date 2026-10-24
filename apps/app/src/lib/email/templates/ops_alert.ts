import { alertWording, type AlertWording } from "@/lib/ops/alert-wording";
import { wordingValues } from "@/lib/ops/alert-wording/allow-list";
import { fillWording, numberedSteps } from "@/lib/ops/alert-wording/render";
import type { OpsEvent } from "@/lib/ops/notify";

import { compose, type Block } from "./compose";
import type { EmailTemplate } from "./types";

/**
 * I1 in Annex X5: one notifyOps alert, to HEALDESK_OPS_EMAIL.
 *
 * Since 23 October 2026 (lane N1) every alert reads as plain English, from
 * its AlertWording (lib/ops/alert-wording): what happened, to whom, why it
 * matters, and numbered steps naming the console page or button to use. The
 * Slack copy (lib/ops/slack.ts) prints the same sentences, filled by the same
 * function from the same allow-listed values.
 *
 * Ids, counts and categories, which the operator looks up in the ops
 * console, and the clinic's name beside its id (business data; the owner's
 * decision D2 of 23 October 2026), or a setup requester's business name.
 * Nothing here quotes an address, names a patient or carries free text, so
 * the alert is safe to read on a phone in a queue and safe in a vendor's
 * logs.
 *
 * It links to one place only (owner decision D3): the console page that owns
 * the alert (`consoleUrl`, built by opsConsoleLink in lib/ops/notify.ts), the
 * clinic panel's tab with the alert's anchor, which lib/email/lint.ts accepts
 * in this kind alone and only under /admin/ on HEALDESK_CONSOLE_ORIGIN. With
 * that origin unset it links nowhere.
 */

/** The alert's fields: ids, counts and categories, keyed as lib/log.ts keys them. */
export type OpsAlertPayload = {
  event: OpsEvent;
  [field: string]: string | number | boolean | null;
};

/** The labels a field prints under. Anything else prints under its own key. */
const LABELS: Record<string, string> = {
  clinicName: "Clinic",
  clinicId: "Clinic id",
  noticeId: "Notice id",
  appointmentId: "Appointment id",
  attemptCount: "Write attempts",
  deliveryId: "Delivery id",
  organizationId: "Organisation id",
  agreementId: "Agreement id",
  eventId: "Event id",
  requestId: "Request id",
  // A setup request (setup_request_reply_past_due): the requester's business
  // name, as the prospect typed it and checked by printableBusinessName, and
  // the day our reply was promised by.
  business: "Business",
  promisedOn: "Reply promised by",
  source: "Source",
  jobId: "Job id",
  connectionId: "Connection id",
  code: "Code",
  kind: "Email kind",
  status: "Status",
  attempts: "Attempts",
  count: "Count",
  windowStart: "Day",
  destroyAt: "Destruction due (UTC)",
  expiresOn: "Expires (UTC)",
  phase: "Phase",
  serviceEndedAt: "Service ended (UTC)",
  lateDays: "Days late",
  conversationId: "Conversation id",
  channel: "Channel",
  locationCount: "Locations active",
  billedCount: "Locations billed in Stripe",
  meter: "Meter",
  used: "Used",
  included: "Included",
  // clinic_availability_changed (lib/clinic/change-events.ts).
  section: "What changed",
  written: "Closed days added",
  deleted: "Closed days taken off",
  // The lifecycle watch (lib/lifecycle/waves.ts) and the digest's Slack line.
  setupDays: "Day of setup",
  remainingDays: "Days left",
  stepsLeftCount: "Steps left",
  noProgressDays: "Days without progress",
  waitedHours: "Hours waiting on us",
  waitedDays: "Days waiting",
  extendDays: "Extend by (days)",
  channelsWaitingCount: "Channels waiting on the clinic",
  reminderCount: "Reminders delivered",
  decision: "Decision",
  recommendation: "Recommended",
  decisionsOwedCount: "Decisions owed",
  waitingOnUsCount: "Waiting on us",
  nearCapCount: "Near allowance",
  atCapCount: "At allowance",
  slackUnpostedCount: "Alerts Slack could not take",
};

function wordingFor(payload: OpsAlertPayload): AlertWording {
  return alertWording(payload.event, payload);
}

/** The alert's title, as its email's subject prints it: the Slack copy's first line (lib/ops/slack.ts). */
export function opsAlertTitle(payload: OpsAlertPayload): string {
  return wordingFor(payload).title;
}

/** The label a field prints under, in the email and the Slack copy alike. */
export function opsFieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

export const renderOpsAlert: EmailTemplate<OpsAlertPayload> = (payload, ctx) => {
  const clinicName = typeof payload.clinicName === "string" ? payload.clinicName : null;
  const wording = fillWording(wordingFor(payload), wordingValues(payload, clinicName));
  const consoleUrl = typeof payload.consoleUrl === "string" ? payload.consoleUrl : null;
  const facts = Object.entries(payload)
    .filter(([key, value]) => key !== "event" && key !== "consoleUrl" && value !== null && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [LABELS[key] ?? key, String(value)] as const);

  const blocks: Block[] = [
    { type: "paragraph", text: wording.whatHappened },
    {
      type: "facts",
      rows: [...facts, ["Raised", `${ctx.raisedAt.toISOString().replace("T", " ").slice(0, 16)} UTC`]],
    },
    ...(wording.whyItMatters ? [{ type: "paragraph" as const, text: `Why it matters: ${wording.whyItMatters}` }] : []),
    ...(wording.steps.length > 0
      ? [{ type: "paragraph" as const, text: ["What to do:", ...numberedSteps(wording.steps)].join("\n") }]
      : []),
    // The page that owns the alert on the console (D3), behind its own sign-in.
    ...(consoleUrl ? [{ type: "action" as const, label: "Open in the console", url: consoleUrl }] : []),
    { type: "paragraph", text: `Alert code: ${payload.event}` },
  ];

  return compose({ subject: `healdesk ops: ${wording.title}`, preheader: wording.whatHappened, blocks }, ctx);
};

/** The payload the snapshot test and `npm run email:seed` render. */
export const OPS_ALERT_FIXTURE: OpsAlertPayload = {
  event: "critical_notice_undelivered",
  clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
  noticeId: "5f0e4a1b-1111-4222-8333-444455556666",
  kind: "payment_failed",
  status: "late",
  attempts: 3,
};
