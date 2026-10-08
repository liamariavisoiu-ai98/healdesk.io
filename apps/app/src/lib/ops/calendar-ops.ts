import { issueCalendarLink } from "@/lib/connections/calendar-links";
import { disconnectGoogleCalendar } from "@/lib/connections/google-calendar";

import { actorFor, audit, clinicById, ok, stringArg, type Operator, type OpsOutcome } from "./api";

/**
 * The console's calendar operations (plan §10): mail a location's calendar
 * link, and disconnect its Google Calendar. Neither takes an address or
 * returns one: a calendar link is a capability, so it goes only to the
 * practice's own address, and its URL reaches the console only for
 * healdesk's demo clinic, for Google's verification video.
 */

export type IssueCalendarLinkState =
  | {
      status: "issued";
      expiresAt: string;
      delivery: { sent: number; failed: number; recipients: number };
      /** The demo clinic's only. */
      url?: string;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

const MAX_DAYS = 30;

export async function opIssueCalendarLink(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic)
    return ok({ status: "error", message: "No such clinic." } satisfies IssueCalendarLinkState);
  if (args.to !== undefined) {
    return ok({
      status: "error",
      message: "A calendar link goes only to the practice's own address; it takes no recipient.",
    } satisfies IssueCalendarLinkState);
  }
  const days = args.expiresInDays;
  if (
    days !== undefined &&
    (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS)
  ) {
    return ok({
      status: "error",
      message: `A calendar link lasts 1 to ${MAX_DAYS} days.`,
    } satisfies IssueCalendarLinkState);
  }
  const outcome = await issueCalendarLink(clinic.id, {
    reason: "ops",
    rule: "useful",
    ...(typeof days === "number" ? { expiresInDays: days } : {}),
    actor: actorFor(operator),
    request: operator.request,
  });
  if (outcome.status === "refused") {
    return ok({ status: "error", message: outcome.message } satisfies IssueCalendarLinkState);
  }
  const auditRecorded = await audit(operator, "calendar_link_issued", {
    clinicId: clinic.id,
    expiresInHours: Math.round((outcome.expiresAt.getTime() - Date.now()) / 3_600_000),
    recipients: outcome.delivery.recipients,
    sent: outcome.delivery.sent,
  });
  return ok({
    status: "issued",
    expiresAt: `${outcome.expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
    delivery: {
      sent: outcome.delivery.sent,
      failed: outcome.delivery.failed,
      recipients: outcome.delivery.recipients,
    },
    ...(outcome.demo ? { url: outcome.url } : {}),
    auditRecorded,
  } satisfies IssueCalendarLinkState);
}

export type DisconnectCalendarState =
  | { status: "disconnected"; revokedAtGoogle: boolean; auditRecorded: boolean }
  | { status: "not_connected" }
  | { status: "error"; message: string };

export async function opDisconnectCalendar(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic)
    return ok({ status: "error", message: "No such clinic." } satisfies DisconnectCalendarState);
  const outcome = await disconnectGoogleCalendar(clinic.id, {
    reason: "operator",
    actor: actorFor(operator),
    request: operator.request,
  });
  if (outcome.status === "not_connected") {
    return ok({ status: "not_connected" } satisfies DisconnectCalendarState);
  }
  const revokedAtGoogle =
    outcome.revokedAtGoogle === "revoked" || outcome.revokedAtGoogle === "already_invalid";
  const auditRecorded = await audit(operator, "calendar_disconnected", {
    clinicId: clinic.id,
    revoke: outcome.revokedAtGoogle,
    releasedHolds: outcome.releasedHolds,
  });
  return ok({
    status: "disconnected",
    revokedAtGoogle,
    auditRecorded,
  } satisfies DisconnectCalendarState);
}
