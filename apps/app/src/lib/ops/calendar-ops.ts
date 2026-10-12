import { GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE } from "@healdesk/catalog";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import {
  connectionLinks,
  providerConnections,
  slotHolds,
  type CalendarElectionSource,
} from "@/db/schema";
import { getClinicSettings } from "@/lib/billing/settings";
import { bookingModeFor, setAutoConfirm, type BookingModeReason } from "@/lib/booking/mode";
import type { CalendarTerms } from "@/lib/booking/terms";
import { issueCalendarLink } from "@/lib/connections/calendar-links";
import {
  disconnectGoogleCalendar,
  type GoogleCalendarConnection,
} from "@/lib/connections/google-calendar";
import { env } from "@/lib/env";
import type { TenantTx } from "@/lib/tenant";

import {
  actorFor,
  audit,
  booleanArg,
  clinicById,
  ok,
  stringArg,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The console's calendar operations (plan §10): mail a location's calendar
 * link, disconnect its Google Calendar, and switch its Auto-confirm; and the
 * `booking` part of getOnboarding. Nothing here takes an address or returns
 * one: a calendar link is a capability, so it goes only to the practice's
 * own address, and its URL reaches the console only for healdesk's demo
 * clinic, for Google's verification video.
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

export type SetAutoConfirmState =
  | {
      status: "updated";
      /** False when Auto-confirm already was where it was asked to be: nothing written or audited. */
      changed: boolean;
      autoConfirm: boolean;
      /** The booking mode it leaves, as getOnboarding's `booking` words it. */
      mode: "live" | "manual";
      reasons: BookingModeReason[];
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

/**
 * What a switch from the console says on the clinic's own screens
 * ("Auto-confirm off since …, by …"): the team, not the administrator's
 * address, as for a pause (lib/ops/billing.ts). The audit rows name the
 * operator.
 */
export const OPS_SWITCH_LABEL = "healdesk support";

/**
 * Auto-confirm on or off, through the portal's own setAutoConfirm
 * (lib/booking/mode.ts), which writes the location's audit row; this adds
 * the operator's. The kill switch is not here: it is the owner's
 * environment switch, HEALDESK_DIRECT_BOOKING_ENABLED, and no operation sets it.
 */
export async function opSetAutoConfirm(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic)
    return ok({ status: "error", message: "No such clinic." } satisfies SetAutoConfirmState);
  const on = booleanArg(args, "on");
  if (on === undefined) {
    return ok({
      status: "error",
      message: "Auto-confirm is on or off.",
    } satisfies SetAutoConfirmState);
  }
  const outcome = await setAutoConfirm(clinic.id, on, actorFor(operator), {
    request: operator.request,
    label: OPS_SWITCH_LABEL,
  });
  const auditRecorded = outcome.changed
    ? await audit(operator, "auto_confirm_set", { clinicId: clinic.id, on })
    : true;
  return ok({
    status: "updated",
    changed: outcome.changed,
    autoConfirm: outcome.autoConfirm,
    mode: outcome.mode === "direct" ? "live" : "manual",
    reasons: outcome.reasons,
    auditRecorded,
  } satisfies SetAutoConfirmState);
}

/**
 * getOnboarding's `booking` (plan §10): the location's booking mode and every
 * reason for it, Auto-confirm, the owner's kill switch, the calendar terms in
 * effect and the Google Calendar connection, for the console's booking and
 * calendar cards.
 *
 * Configuration and counts only. Never the Google account's email address,
 * its subject or account reference, or the calendar's own time zone: only
 * whether that zone is the clinic's crosses (tests/ops.test.ts).
 */
export type BookingProjection = {
  mode: "live" | "manual";
  canOfferTimes: boolean;
  reasons: BookingModeReason[];
  autoConfirm: boolean;
  autoConfirmChangedAt: string | null;
  killSwitchOn: boolean;
  demo: boolean;
  terms: {
    kind: CalendarTerms["kind"];
    source: CalendarElectionSource | null;
    clauseId: string | null;
    documentVersion: string | null;
    documentReleased: boolean | null;
    electedAt: string | null;
    /** Why no terms are in effect: `no_agreement`, or why an election is needed. Null when they are. */
    reason: string | null;
  };
  calendar: {
    connectionId: string;
    status: GoogleCalendarConnection["status"];
    accountKind: "workspace" | "personal" | null;
    hostedDomain: string | null;
    /** Whether the calendar's own zone is the clinic's; null when it was never recorded. */
    timeZoneMatches: boolean | null;
    disclosureCurrent: boolean;
    connectedAt: string | null;
    lastVerifiedAt: string | null;
    lastError: string | null;
    brokenAt: string | null;
  } | null;
  /** An unspent, unexpired calendar link exists. */
  calendarLinkOutstanding: boolean;
  /** The assistant's calendar writes not yet resolved: holds `writing` or `unknown`. */
  pendingAssistantWrites: number;
};

/** Read inside the location's tenant transaction, which getOnboarding already holds. */
export async function readBookingProjection(
  tx: TenantTx,
  clinicTimeZone: string,
): Promise<BookingProjection> {
  const booking = await bookingModeFor(tx);
  const settings = await getClinicSettings(tx);
  const { terms, connection } = booking;

  const [link] = await tx.db
    .select({ id: connectionLinks.id })
    .from(connectionLinks)
    .where(
      and(
        eq(connectionLinks.clinicId, tx.clinicId),
        eq(connectionLinks.purpose, "calendar"),
        isNull(connectionLinks.usedAt),
        gt(connectionLinks.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const [writes] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(slotHolds)
    .where(
      and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.status, ["writing", "unknown"])),
    );

  let calendar: BookingProjection["calendar"] = null;
  if (connection) {
    const [timing] = await tx.db
      .select({ lastVerifiedAt: providerConnections.lastVerifiedAt })
      .from(providerConnections)
      .where(eq(providerConnections.id, connection.id))
      .limit(1);
    const m = connection.metadata;
    calendar = {
      connectionId: connection.id,
      status: connection.status,
      accountKind:
        connection.managed === null ? null : connection.managed ? "workspace" : "personal",
      hostedDomain: connection.hostedDomain,
      timeZoneMatches:
        typeof m.calendarTimeZone === "string" ? m.calendarTimeZone === clinicTimeZone : null,
      disclosureCurrent:
        typeof m.disclosureVersion === "string" &&
        GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE.includes(m.disclosureVersion),
      connectedAt: typeof m.connectedAt === "string" ? m.connectedAt : null,
      lastVerifiedAt: timing?.lastVerifiedAt?.toISOString() ?? null,
      lastError: connection.lastError,
      brokenAt: connection.brokenAt?.toISOString() ?? null,
    };
  }

  return {
    mode: booking.mode,
    canOfferTimes: booking.canOfferTimes,
    reasons: booking.reasons,
    autoConfirm: settings.autoConfirmBookings,
    autoConfirmChangedAt: settings.autoConfirmChangedAt?.toISOString() ?? null,
    killSwitchOn: env.directBookingEnabled(),
    demo: booking.demo,
    terms:
      terms.kind === "none" || terms.kind === "needs_election"
        ? {
            kind: terms.kind,
            source: null,
            clauseId: null,
            documentVersion: null,
            documentReleased: null,
            electedAt: null,
            reason: terms.reason,
          }
        : {
            kind: terms.kind,
            source: terms.source,
            clauseId: terms.clauseId,
            documentVersion: terms.documentVersion,
            documentReleased: terms.documentReleased,
            electedAt: terms.electedAt.toISOString(),
            reason: null,
          },
    calendar,
    calendarLinkOutstanding: link !== undefined,
    pendingAssistantWrites: writes?.n ?? 0,
  };
}
