import { CURRENT_BAA_VERSION, isBaaVersionAcceptable } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { baaOlderThanCurrent, openBaaVersionResign, sendAgreementToSign } from "./resign";

/**
 * The operator's broadcast that starts every account on an older version of
 * the business associate agreement re-signing the current one (wave 2 R11;
 * the WP7 pattern of L28 and L29: one action from /admin, idempotent per
 * practice). It is how a release that keeps the older version acceptable
 * for a while (the counsel note's "an overlap and a re-signature") moves the
 * practices before the floor does; the hourly job opens a re-sign by itself
 * only once the floor has passed a version (lib/agreements/resign.ts).
 *
 * For each account still in service whose BAA in force is older than the
 * current one: a re-sign opens (`operator`), AYA pauses with it only where
 * openResignHoldsPause's rule says she does not answer under that version,
 * and L22 goes once it has committed, with its link; the hourly job sends its
 * reminders at 3 and 7 days. An account whose re-sign is already open, of
 * either kind, is counted and left alone, so sending it again reaches only
 * the accounts that had none. Contract metadata; never a patient.
 */

export type BaaVersionResignSummary = {
  status: "started";
  /** The version every re-sign signs. */
  version: string;
  /** Re-signs opened now. */
  opened: number;
  /** Of those, how many hold AYA paused until signed (below the floor, answering patients). */
  paused: number;
  /** Of those, how many had L22 sent now (the hourly job sends any that did not go). */
  emailed: number;
  /** Accounts that already had a re-sign open. */
  alreadyOpen: number;
  /** Accounts it could not reach: a database error, logged. */
  failed: number;
};

export type BaaVersionResignRefusal = { status: "refused"; message: string };

export async function startBaaVersionResigns(input: {
  actorLabel: string;
  now?: Date;
}): Promise<BaaVersionResignSummary | BaaVersionResignRefusal> {
  const now = input.now ?? new Date();
  const label = input.actorLabel.trim().slice(0, 200);
  if (!label) return { status: "refused", message: "Who is starting it? Sign in again." };
  // The supersede binds only what app_baa_version_acceptable() accepts, so a
  // current version the database does not take yet (its release migration
  // not run) would open re-signs nobody could sign.
  const accepted = await unsafeDb.execute<{ ok: boolean | null }>(
    sql`select app_baa_version_acceptable(${CURRENT_BAA_VERSION}) as ok`,
  );
  if (!isBaaVersionAcceptable(CURRENT_BAA_VERSION) || accepted.rows[0]?.ok !== true) {
    return {
      status: "refused",
      message: `Version ${CURRENT_BAA_VERSION} isn't released for signing in the database yet: run its release migration first.`,
    };
  }

  const actor: ActorContext = { type: "service", serviceName: label };
  const summary: BaaVersionResignSummary = {
    status: "started",
    version: CURRENT_BAA_VERSION,
    opened: 0,
    paused: 0,
    emailed: 0,
    alreadyOpen: 0,
    failed: 0,
  };
  for (const clinic of await listClinics()) {
    if (
      clinic.billingClinicId !== null ||
      clinic.offboardingStartedAt !== null ||
      clinic.destroyedAt !== null ||
      clinic.baaVersion === null ||
      !baaOlderThanCurrent(clinic.baaVersion)
    ) {
      continue;
    }
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor }, (tx) =>
        openBaaVersionResign(tx, { source: "operator", requestedBy: label, now }),
      );
      if (outcome.status === "already_open") summary.alreadyOpen += 1;
      if (outcome.status !== "opened") continue;
      summary.opened += 1;
      if (outcome.paused) summary.paused += 1;
      // After commit (X1.4): the re-sign its link names exists now.
      if (
        await sendAgreementToSign({
          clinicId: clinic.id,
          resignId: outcome.resignId,
          waitingDays: 0,
        })
      ) {
        summary.emailed += 1;
      }
    } catch (error) {
      summary.failed += 1;
      log.error("agreement re-sign broadcast could not reach a clinic", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return summary;
}
