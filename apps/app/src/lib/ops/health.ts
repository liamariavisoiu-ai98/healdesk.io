import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";
import { and, asc, count, desc, eq, gte, isNotNull, min } from "drizzle-orm";

import { appointments, clinicTouches, conversations, providerConnections, type Entitlements } from "@/db/schema";
import { getEntitlements } from "@/lib/billing/entitlements";
import { openWindowAt, usageSnapshot, windowEndsOn } from "@/lib/billing/usage";
import { describeError, log } from "@/lib/log";
import { listRecipients } from "@/lib/reporting/recipients";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { listClinics } from "./clinics";

/**
 * The first-two-weeks health view: which clinic to phone today, and why.
 *
 * The funnel sells with no sales call, so the only human contact in the
 * relationship is the one the operator chooses to make. This is the list
 * that makes that a decision rather than a memory: days since go-live,
 * calls handled, calls the desk would have missed, the first booking, and
 * every human touch so far. Counts and dates only — never a caller — and
 * every read goes through the tenant transaction and its audit row.
 *
 * Two states need a person today, flagged: a clinic past day seven with no
 * calls at all (the phone was never forwarded: a setup failure, not a
 * product failure), and a clinic with its first recovered booking that
 * nobody has phoned since (the moment to call and say so).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const WATCH_DAYS = 60;

export type HealthFlag = "no_calls_after_day_7" | "first_win" | "quiet_week" | "near_allowance";

export type ClinicTouch = {
  touchedAt: string;
  byLabel: string;
  kind: "call" | "email" | "note";
  summary: string;
  outcome: string | null;
};

export type ClinicHealth = {
  clinicId: string;
  slug: string;
  name: string;
  plan: string | null;
  wentLiveAt: string;
  daysLive: number;
  conversations: { total: number; last7: number };
  recovered: { total: number; last7: number };
  bookings: number;
  firstRecoveredBookingAt: string | null;
  lastConversationAt: string | null;
  recipients: number;
  forwardingTested: boolean;
  connected: boolean;
  usage: ClinicUsage | null;
  touches: ClinicTouch[];
  flags: HealthFlag[];
};

/**
 * The usage column (design E2, 23 October 2026): each meter against its
 * allowance, as the allowance emails count it (usageSnapshot), with the
 * whole percent, the day the window resets, what happens past the
 * allowance, and whether the clinic itself is emailed at the marks (its
 * Usage alerts switch). Ops is told at the marks either way.
 */
export type ClinicUsage = {
  voiceMinutesUsed: number;
  voiceMinutesIncluded: number;
  chatUsed: number;
  chatIncluded: number;
  voicePercent: number | null;
  chatPercent: number | null;
  /** The ISO day the open window ends, or null while none is open. */
  resetsOn: string | null;
  /** `allow` bills extra blocks of 100; `hard_cap` is "Stop and fall back". */
  overageMode: "allow" | "hard_cap";
  clinicEmailed: boolean;
};

export async function clinicHealth(
  now: Date = new Date(),
  actor: { type: "service"; serviceName: string } = { type: "service", serviceName: "ops-health" },
): Promise<ClinicHealth[]> {
  const out: ClinicHealth[] = [];
  for (const clinic of await listClinics()) {
    if (clinic.dataClassification !== "production" || !clinic.wentLiveAt || clinic.destroyedAt) continue;
    const daysLive = Math.floor((now.getTime() - clinic.wentLiveAt.getTime()) / DAY_MS);
    if (daysLive > WATCH_DAYS) continue;
    try {
      const row = await withTenant({ clinicId: clinic.id, actor }, (tx) => readHealth(tx, now));
      const flags: HealthFlag[] = [];
      if (daysLive >= 7 && row.conversations.total === 0) flags.push("no_calls_after_day_7");
      if (
        row.firstRecoveredBookingAt &&
        !row.touches.some((t) => t.kind === "call" && t.touchedAt >= row.firstRecoveredBookingAt!)
      ) {
        flags.push("first_win");
      }
      if (daysLive >= 14 && row.conversations.total > 0 && row.conversations.last7 === 0) flags.push("quiet_week");
      // At the clinic's own alert mark, on either meter, as ops is told.
      const percents = [row.usage?.voicePercent, row.usage?.chatPercent];
      if (percents.some((p) => typeof p === "number" && p >= USAGE_ALERT_PERCENT)) {
        flags.push("near_allowance");
      }
      out.push({
        clinicId: clinic.id,
        slug: clinic.slug,
        name: clinic.name,
        plan: clinic.plan,
        wentLiveAt: clinic.wentLiveAt.toISOString(),
        daysLive,
        forwardingTested: Boolean(clinic.onboarding.test_call_passed),
        ...row,
        flags,
      });
    } catch (error) {
      log.error("clinic health read failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return out.sort((a, b) => a.daysLive - b.daysLive);
}

async function readHealth(tx: TenantTx, now: Date) {
  const c = tx.clinicId;
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const mine = eq(conversations.clinicId, c);
  const [total] = await tx.db.select({ n: count() }).from(conversations).where(mine);
  const [last7] = await tx.db.select({ n: count() }).from(conversations).where(and(mine, gte(conversations.startedAt, weekAgo)));
  const [recoveredTotal] = await tx.db.select({ n: count() }).from(conversations).where(and(mine, isNotNull(conversations.recoveryReason)));
  const [recoveredLast7] = await tx.db
    .select({ n: count() })
    .from(conversations)
    .where(and(mine, isNotNull(conversations.recoveryReason), gte(conversations.startedAt, weekAgo)));
  const [bookings] = await tx.db.select({ n: count() }).from(appointments).where(eq(appointments.clinicId, c));
  const [firstWin] = await tx.db
    .select({ at: min(appointments.createdAt) })
    .from(appointments)
    .innerJoin(conversations, eq(appointments.conversationId, conversations.id))
    .where(and(eq(appointments.clinicId, c), isNotNull(conversations.recoveryReason)));
  const [last] = await tx.db.select({ at: conversations.startedAt }).from(conversations).where(mine).orderBy(desc(conversations.startedAt)).limit(1);
  const recipients = await listRecipients(tx);
  const [connection] = await tx.db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(eq(providerConnections.clinicId, c), eq(providerConnections.status, "active")))
    .limit(1);
  const entitlement = await getEntitlements(tx.db, c);
  const touches = await tx.db
    .select()
    .from(clinicTouches)
    .where(eq(clinicTouches.clinicId, c))
    .orderBy(desc(clinicTouches.touchedAt), asc(clinicTouches.id))
    .limit(8);

  tx.audit.record({ action: "read", resourceType: "conversation", resultCount: total?.n ?? 0, metadata: { purpose: "clinic_health" } });

  return {
    conversations: { total: total?.n ?? 0, last7: last7?.n ?? 0 },
    recovered: { total: recoveredTotal?.n ?? 0, last7: recoveredLast7?.n ?? 0 },
    bookings: bookings?.n ?? 0,
    firstRecoveredBookingAt: firstWin?.at ? new Date(firstWin.at).toISOString() : null,
    lastConversationAt: last?.at ? last.at.toISOString() : null,
    recipients: recipients.length,
    connected: Boolean(connection),
    usage: entitlement ? usageColumn(entitlement, now) : null,
    touches: touches.map((t) => ({
      touchedAt: t.touchedAt.toISOString(),
      byLabel: t.byLabel,
      kind: t.kind,
      summary: t.summary,
      outcome: t.outcome,
    })),
  };
}

/** The usage column from the entitlements row, counted as the allowance emails count it. */
export function usageColumn(row: Entitlements, now: Date): ClinicUsage {
  const [voice, chat] = usageSnapshot(row, now);
  const window = openWindowAt(row, now);
  return {
    voiceMinutesUsed: voice!.used,
    voiceMinutesIncluded: voice!.included,
    chatUsed: chat!.used,
    chatIncluded: chat!.included,
    voicePercent: voice!.percent,
    chatPercent: chat!.percent,
    resetsOn: window ? windowEndsOn(window.end) : null,
    overageMode: row.overageMode,
    clinicEmailed: row.usageAlertsEnabled,
  };
}

/** Record a human touch. The summary is the operator's prose; PHI-scanned by the caller. */
export async function recordTouch(
  tx: TenantTx,
  input: { kind: "call" | "email" | "note"; summary: string; outcome?: string | null; byLabel: string; at?: Date },
): Promise<string> {
  const [row] = await tx.db
    .insert(clinicTouches)
    .values({
      clinicId: tx.clinicId,
      kind: input.kind,
      summary: input.summary.slice(0, 2000),
      outcome: input.outcome?.slice(0, 500) ?? null,
      byLabel: input.byLabel,
      touchedAt: input.at ?? new Date(),
    })
    .returning({ id: clinicTouches.id });
  tx.audit.record({ action: "create", resourceType: "clinic_touch", resourceId: row!.id, metadata: { kind: input.kind } });
  return row!.id;
}
