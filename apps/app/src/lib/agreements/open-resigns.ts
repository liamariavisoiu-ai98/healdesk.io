import { CURRENT_BAA_VERSION } from "@healdesk/catalog";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { agreementResigns, clinicChannels, reportDeliveries, type AgreementResignReason } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { TENANT_GUC, withTenant, type TenantTx } from "@/lib/tenant";

import { agreementInEffect } from "./in-effect";
import { organisationOpenResigns } from "./resign-pause";
import { RESIGN_LINK_TTL_MS, resignOpenToPractice } from "./resign";

/**
 * The open re-signs across clinics, as facts (ops automation lane P6f; design
 * E6 §3 item 14): the cross-clinic list the owner chases from
 * (`listOpenResigns`), and the facts the BAA chase's packet, proposer and
 * executor read for one re-sign. Ids, versions, dates, counts and closed
 * words; never a person, never a link.
 *
 * Read-only. Each re-sign is read in its own clinic's tenant, through the
 * definer app_open_agreement_resigns() for the list of ids, as the hourly
 * job (lib/agreements/resign.ts runAgreementResignsJob) reads it.
 */

const DAY_MS = 86_400_000;

/** A re-sign's L22 ledger key: `resign:<id>:<0|3|7>` (resign.ts claimResignEmail). */
const L22_KEY = /^resign:[0-9a-f-]{36}:(0|3|7)$/;

export type ResignFacts = {
  resignId: string;
  clinicId: string;
  reason: AgreementResignReason;
  startedAt: Date;
  /** Whole days since it opened. */
  daysOpen: number;
  /** The version of the agreement in force it replaces (a DPA's or an older BAA's). */
  fromVersion: string | null;
  /** The version it asks for: the current BAA. */
  toVersion: string;
  /** Whether go-live still accepts the version in force. A DPA re-sign's DPA: false. */
  fromVersionAcceptable: boolean;
  /** A BAA version re-sign whose version in force go-live no longer accepts: phone the practice. */
  belowFloor: boolean;
  /** Chased and shown to the practice now: a BAA version re-sign only while its switch is on. */
  openToPractice: boolean;
  /** When the latest L22 email was sent, from the ledger. */
  lastL22SentAt: Date | null;
  /** Whether L22's day-7 reminder has been sent: its automatic chasing is spent. */
  daySevenSent: boolean;
  /** When the latest link mailed for it stops working: the latest L22 or chase sent, plus 14 days. */
  linkExpiresAt: Date | null;
  /** The latest owner's chase sent or attempted (lane P6f), from the ledger. */
  lastChaseAt: Date | null;
  /** Whether AYA answers on any channel of this clinic. */
  isAnswering: boolean;
};

/**
 * Whether AYA answers on any channel at any location of the clinic's
 * organisation (app_organisation_clinics): the agreement is the
 * organisation's, and so is what a re-sign pauses. Each location is read in
 * its own tenant inside the caller's transaction (clinic_channels forces
 * row-level security), and the caller's tenant is set back after.
 */
export async function organisationAnswering(tx: TenantTx): Promise<boolean> {
  const rows = await tx.db.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_organisation_clinics(${tx.clinicId}::uuid)`,
  );
  const ids = rows.rows.map((r) => r.clinic_id);
  if (!ids.includes(tx.clinicId)) ids.unshift(tx.clinicId);
  let answering = false;
  try {
    for (const clinicId of ids) {
      await tx.db.execute(sql`select set_config(${TENANT_GUC}, ${clinicId}, true)`);
      const live = await tx.db
        .select({ channel: clinicChannels.channel })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, clinicId), eq(clinicChannels.enabled, true), isNotNull(clinicChannels.liveAt)))
        .limit(1);
      if (live.length > 0) {
        answering = true;
        break;
      }
    }
  } finally {
    await tx.db.execute(sql`select set_config(${TENANT_GUC}, ${tx.clinicId}, true)`);
  }
  return answering;
}

/** One re-sign's facts, inside its clinic's tenant; null when it is not this clinic's or not open. */
export async function resignFactsIn(tx: TenantTx, resignId: string, now: Date): Promise<ResignFacts | null> {
  const [row] = await tx.db
    .select({
      id: agreementResigns.id,
      status: agreementResigns.status,
      reason: agreementResigns.reason,
      startedAt: agreementResigns.startedAt,
    })
    .from(agreementResigns)
    .where(and(eq(agreementResigns.id, resignId), eq(agreementResigns.clinicId, tx.clinicId)))
    .limit(1);
  if (!row || row.status !== "open") return null;
  const org = (await organisationOpenResigns(tx)).find((r) => r.resignId === row.id);
  const sends = await tx.db
    .select({
      kind: reportDeliveries.kind,
      periodKey: reportDeliveries.periodKey,
      status: reportDeliveries.status,
      sentAt: reportDeliveries.sentAt,
      attemptedAt: reportDeliveries.attemptedAt,
    })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.clinicId, tx.clinicId),
        sql`${reportDeliveries.kind} in ('agreement_to_sign', 'baa_resign_chase')`,
        sql`starts_with(${reportDeliveries.periodKey}, ${`resign:${row.id}:`})`,
      ),
    );
  const l22 = sends.filter((s) => s.kind === "agreement_to_sign" && L22_KEY.test(s.periodKey));
  const latest = (dates: (Date | null)[]) =>
    dates.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastL22SentAt = latest(l22.filter((s) => s.status === "sent").map((s) => s.sentAt));
  const chases = sends.filter((s) => s.kind === "baa_resign_chase");
  const lastChaseAt = latest(chases.map((s) => s.sentAt ?? s.attemptedAt));
  const lastLink = latest([lastL22SentAt, latest(chases.filter((s) => s.status === "sent").map((s) => s.sentAt))]);
  const isAnswering = await organisationAnswering(tx);
  const fromVersion = org?.fromVersion ?? (await agreementInEffect(tx))?.documentVersion ?? null;
  const fromVersionAcceptable = org?.fromVersionAcceptable === true;
  return {
    resignId: row.id,
    clinicId: tx.clinicId,
    reason: row.reason,
    startedAt: row.startedAt,
    daysOpen: Math.max(0, Math.floor((now.getTime() - row.startedAt.getTime()) / DAY_MS)),
    fromVersion,
    toVersion: CURRENT_BAA_VERSION,
    fromVersionAcceptable,
    belowFloor: row.reason === "baa_version" && !fromVersionAcceptable,
    openToPractice: resignOpenToPractice(row.reason),
    lastL22SentAt,
    daySevenSent: l22.some((s) => s.status === "sent" && s.periodKey.endsWith(":7")),
    linkExpiresAt: lastLink ? new Date(lastLink.getTime() + RESIGN_LINK_TTL_MS) : null,
    lastChaseAt,
    isAnswering,
  };
}

/** Every open re-sign, each read in its own tenant; a clinic that cannot be read is counted, not thrown. */
export async function readOpenResigns(input: {
  actor: ActorContext;
  request?: RequestContext;
  now: Date;
}): Promise<{ resigns: ResignFacts[]; unread: number }> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_open_agreement_resigns()`,
  );
  const resigns: ResignFacts[] = [];
  let unread = 0;
  for (const row of result.rows) {
    try {
      const facts = await withTenant({ clinicId: row.clinic_id, actor: input.actor, request: input.request }, (tx) =>
        resignFactsIn(tx, row.id, input.now),
      );
      if (facts) resigns.push(facts);
    } catch {
      unread += 1;
    }
  }
  return { resigns, unread };
}

/** The chase's own rule (design E6 §3 item 14): days of rest between two chases of one re-sign. */
export const CHASE_EVERY_DAYS = 7;

/** From this many whole days open, with L22's day-7 reminder sent, a chase may be proposed. */
export const CHASE_FROM_DAY = 8;

/**
 * Why a re-sign cannot be chased by the owner now, or null when it can: a
 * BAA version re-sign (a DPA re-sign pauses AYA, and L22 says so), open to
 * the practice, past day 7 with L22's reminders spent, and no chase in the
 * last seven days.
 */
export function chaseBlocked(
  facts: ResignFacts,
  now: Date,
): "not_baa_version" | "switched_off" | "too_early" | "chased_recently" | null {
  if (facts.reason !== "baa_version") return "not_baa_version";
  if (!facts.openToPractice) return "switched_off";
  if (facts.daysOpen < CHASE_FROM_DAY || !facts.daySevenSent) return "too_early";
  if (facts.lastChaseAt && now.getTime() - facts.lastChaseAt.getTime() < CHASE_EVERY_DAYS * DAY_MS) {
    return "chased_recently";
  }
  return null;
}

/** Which seven-day round of chasing a day falls in: 1 from day 8, 2 from day 15. */
export function chaseRound(daysOpen: number): number {
  return Math.max(1, Math.floor((daysOpen - 1) / CHASE_EVERY_DAYS));
}
