import type { OpsEvent } from "@/lib/ops/notify";

import { allowedAlertFields } from "./allow-list";
import { LEGACY_WORDING } from "./index";
import { formatValue, printedKeys } from "./render";
import type { AlertWording } from "./types";

/**
 * The facts under an alert's first sentence, the same in the email and in
 * Slack (lane N1 review): the allow-listed fields, each under a label and
 * formatted as the sentences format it (a day as "1 Oct", a closed word in
 * plain English, never a time), less what the sentences already say and
 * what means nothing to an operator. Who the alert is about (the clinic, or
 * a requester's business) is printed by each renderer in its own place.
 */

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
  // name, checked by printableBusinessName, and the day our reply was promised by.
  business: "Business",
  promisedOn: "Reply promised by",
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

/** The label a field prints under, in the email and the Slack copy alike. */
export function opsFieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

/** Who the alert is about, printed apart; and fields that are ours, not the operator's. */
const NOT_FACTS = new Set(["clinicId", "clinicName", "business", "event", "consoleUrl", "source"]);

export type FactRow = readonly [label: string, value: string];

function rows(entries: [string, string | number | boolean][]): FactRow[] {
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [opsFieldLabel(key), formatValue(key, value)] as const);
}

/** The facts both renderings print: allow-listed, formatted, and not already in the sentences. */
export function sharedFacts(fields: Readonly<Record<string, unknown>>, wording: AlertWording): FactRow[] {
  const printed = printedKeys(wording);
  return rows(
    Object.entries(allowedAlertFields(fields)).filter(([key]) => !NOT_FACTS.has(key) && !printed.has(key)),
  );
}

/**
 * The email's facts: who it is about, then the shared facts. An event still
 * in its legacy wording keeps the ids and codes its paragraph points at
 * ("the request id below", "the code says why"), which Slack never carries;
 * a rewritten one prints the shared facts alone, as Slack does.
 */
export function emailFacts(
  event: OpsEvent,
  payload: Readonly<Record<string, string | number | boolean | null>>,
  wording: AlertWording,
  clinicName: string | null,
): FactRow[] {
  const allowed = allowedAlertFields(payload);
  const who: FactRow[] = [];
  if (clinicName) who.push([opsFieldLabel("clinicName"), clinicName]);
  if (typeof allowed.clinicId === "string") who.push([opsFieldLabel("clinicId"), allowed.clinicId]);
  if (typeof allowed.business === "string") who.push([opsFieldLabel("business"), allowed.business]);
  if (!LEGACY_WORDING.has(event)) return [...who, ...sharedFacts(payload, wording)];
  const printed = printedKeys(wording);
  const rest = Object.entries(payload).filter(
    (entry): entry is [string, string | number | boolean] =>
      entry[1] !== null && entry[1] !== undefined && !NOT_FACTS.has(entry[0]) && !printed.has(entry[0]),
  );
  return [...who, ...rows(rest)];
}
