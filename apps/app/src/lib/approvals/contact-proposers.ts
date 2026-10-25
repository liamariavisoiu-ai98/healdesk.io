import { sql } from "drizzle-orm";

import type { OpsApproval } from "@/db/schema";
import { chaseBlocked, chaseRound, readOpenResigns } from "@/lib/agreements/open-resigns";
import { printableClinicName } from "@/lib/email/lint";
import { audienceFor } from "@/lib/email/templates/context";
import { describeError, log } from "@/lib/log";
import { isLifecycleIgnored } from "@/lib/lifecycle/ignore";
import { withTenant } from "@/lib/tenant";

import { renderContactDraft } from "./contact-drafts";
import { storableName, type ContactPayloads } from "./contact-payloads";
import { serialiseDraft } from "./drafts";
import { PROPOSER, type ApprovalKind } from "./kinds";
import { moveStatus, propose, SERVICE_ACTOR, waitingItems } from "./store";

/**
 * The one clinic-contact kind the approvals job proposes by itself (ops
 * automation lane P6f; design E6 §3 item 14): the BAA version re-sign chase.
 * The agreement question and the setup notices are proposed only by an
 * operator's button (lib/ops/resign-ops.ts, lib/ops/notice-ops.ts).
 *
 * A chase is proposed for an open `baa_version` re-sign, open to the
 * practice, from day 8 once L22's day-7 reminder has gone (its automatic
 * chasing is spent), and never within 7 days of the last chase sent
 * (open-resigns.ts chaseBlocked). One item per re-sign and seven-day round
 * (`<resign id>:<round>`): a rejection holds for its round, the next round
 * may propose again. Never for healdesk's demo clinic or a closed account.
 * The draft is rendered now, its link a placeholder (the link is minted at
 * send).
 */

const ACTOR = { type: "service", serviceName: PROPOSER } as const;

export type ChaseScan = {
  proposed: number;
  /** Every open re-sign read this run, by id: a waiting chase whose re-sign is not here has closed. */
  openResignIds: Set<string>;
  /** Whether the open re-signs were read: without it nothing is resolved. */
  read: boolean;
};

async function inService(clinicId: string): Promise<{ ok: boolean; name: string | null; audience: "patients" | "clients"; timeZone: string } | null> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const result = await tx.db.execute<{ demo: boolean; closed: boolean; name: string; specialty: string; timezone: string }>(
      sql`select app_clinic_is_demo(c.id) as demo,
                 (c.account_closed_at is not null or c.destroyed_at is not null or c.offboarding_started_at is not null) as closed,
                 c.name, c.specialty, c.timezone
            from clinics c where c.id = ${tx.clinicId}`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      // Not the demo, not closed or leaving, and not one of our own test accounts (the lifecycle ignore list).
      ok: row.demo !== true && row.closed !== true && !(await isLifecycleIgnored(tx)),
      name: storableName(printableClinicName(row.name)),
      audience: audienceFor(row.specialty),
      timeZone: row.timezone,
    };
  });
}

/** Propose each chase that is due; returns how many were proposed and which re-signs are open. */
export async function proposeChases(now: Date): Promise<ChaseScan> {
  const scan: ChaseScan = { proposed: 0, openResignIds: new Set(), read: false };
  let resigns;
  try {
    ({ resigns } = await readOpenResigns({ actor: ACTOR, now }));
    scan.read = true;
  } catch (error) {
    log.warn("approvals: the open re-signs could not be read", { error: describeError(error) });
    return scan;
  }
  for (const facts of resigns) {
    if (facts.reason !== "baa_version" || !facts.openToPractice) continue;
    scan.openResignIds.add(facts.resignId);
    if (chaseBlocked(facts, now)) continue;
    try {
      const clinic = await inService(facts.clinicId);
      if (!clinic?.ok) continue;
      const round = chaseRound(facts.daysOpen);
      // A new round's chase replaces the earlier round's still waiting: at most one item per re-sign.
      await expireEarlierRounds(facts.resignId, round, now);
      const payload: ContactPayloads["baa_resign_chase"] = {
        clinicId: facts.clinicId,
        resignId: facts.resignId,
        round,
        fromVersion: facts.fromVersion,
        toVersion: facts.toVersion,
        isAnswering: facts.isAnswering,
        note: null,
        clinicName: clinic.name,
        audience: clinic.audience,
        timeZone: clinic.timeZone,
      };
      const draft = serialiseDraft(renderContactDraft("baa_resign_chase", payload));
      const id = await propose(
        { kind: "baa_resign_chase", subjectClinicId: facts.clinicId, subjectRef: `${facts.resignId}:${round}`, payload },
        now,
        { draft },
      );
      if (id) scan.proposed += 1;
    } catch (error) {
      log.warn("approvals: a re-sign chase could not be proposed", { clinicId: facts.clinicId, error: describeError(error) });
    }
  }
  return scan;
}

/** Waiting chases of an earlier round of this re-sign, moved to expired: the new round's item stands for them. */
async function expireEarlierRounds(resignId: string, round: number, now: Date): Promise<void> {
  for (const item of await waitingItems()) {
    if (item.kind !== "baa_resign_chase") continue;
    const [id, r] = item.subjectRef.split(":");
    if (id !== resignId || Number(r) >= round) continue;
    await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "superseded_by_next_round" });
  }
}

/**
 * Whether a waiting contact item's subject is gone, as this run read it: a
 * chase whose re-sign has closed, been signed, withdrawn or switched off.
 * The operator-proposed kinds are never resolved here: their executors
 * check again before anything goes, and they leave the list by their window.
 */
export function contactResolved(item: OpsApproval, scan: ChaseScan): boolean {
  if ((item.kind as ApprovalKind) !== "baa_resign_chase" || !scan.read) return false;
  const resignId = item.subjectRef.split(":")[0] ?? "";
  return !scan.openResignIds.has(resignId);
}
