import type { Channel } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import type { Queryable } from "@/db";
import { clinics } from "@/db/schema";
import { notifyOpsOnce } from "@/lib/ops/notify";
import type { TenantTx } from "@/lib/tenant";

import { readPlatformCompliance, utcDay, type PlatformStatus } from "./platform";
import type { PlatformSubject } from "./subjects";

/**
 * The vendors whose business associate agreement must be in force for AYA
 * to answer a production clinic (the owner's decision of 19 October 2026),
 * read from platform_compliance (drizzle/0090) as go-live reads it: a
 * subject counts while its latest row attests it and its recorded expiry has
 * not passed. No record means no coverage.
 *
 * Scoped by where the vendor sits on a channel's path:
 *
 *   - the host, `aws` and `database_host`: every channel, and everything
 *     that keeps patient data, so while either lapses nothing new is kept
 *     either (the answer gate's `host_agreement_lapsed`, which
 *     `patientDataRefused` names);
 *   - the assistant's own vendors, `anthropic` on every channel and
 *     `retell` on phone: AYA stops there (`vendor_agreement_lapsed`), and
 *     the fallbacks that keep no model in the loop still run.
 *
 * Meta never signs one and is handled by scoping, so it is no subject.
 * Nothing is deleted, no channel is taken offline, and answering resumes the
 * moment a renewed attestation is recorded on /admin/compliance. Platform
 * data, no clinic and no patient.
 */
export const HOST_VENDORS = ["aws", "database_host"] as const satisfies readonly PlatformSubject[];

/** The vendors AYA itself needs on a channel: the model provider, and the voice platform on phone. */
export function assistantVendorsFor(channel: Channel): readonly PlatformSubject[] {
  return channel === "voice" ? ["anthropic", "retell"] : ["anthropic"];
}

/** Every vendor the stop reads, for the watch. */
export const COVERAGE_VENDORS: readonly PlatformSubject[] = [
  ...HOST_VENDORS,
  "anthropic",
  "retell",
];

/** The vendors on a channel's path whose agreement is not in force now; empty when it is covered. */
export type VendorLapses = {
  host: readonly PlatformSubject[];
  assistant: readonly PlatformSubject[];
};

export const NO_LAPSES: VendorLapses = { host: [], assistant: [] };

/** Pure: which of a channel's vendors are not attested now. */
export function vendorLapses(status: PlatformStatus, channel: Channel): VendorLapses {
  return {
    host: HOST_VENDORS.filter((s) => !status[s].attested),
    assistant: assistantVendorsFor(channel).filter((s) => !status[s].attested),
  };
}

/**
 * Whether the host's agreements cover keeping the tenant's patient data now:
 * always on synthetic data, else AWS's and the database host's both in
 * force. For a writer that keeps something before the answer gate is asked
 * (the Meta webhook's thread), which during a host lapse keeps nothing, as
 * the gate's `host_agreement_lapsed` would have it.
 */
export async function hostCoversPatientData(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<boolean> {
  const [clinic] = await tx.db
    .select({ dataClassification: clinics.dataClassification })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || clinic.dataClassification === "synthetic") return true;
  const status = await readPlatformCompliance(tx.db, now);
  return HOST_VENDORS.every((s) => status[s].attested);
}

/** Days before a recorded expiry at which ops is warned, once each, so a renewal is entered in time. */
export const EXPIRY_WARNING_DAYS = [30, 7] as const;

const DAY_MS = 86_400_000;

/** Whole UTC days from `today` to `day`, both YYYY-MM-DD. */
function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

export type VendorWatch = { expiring: number; lapsed: number };

/**
 * The vendors' agreements, watched (the ops watch, lib/ops/watch.ts): ops is
 * warned 30 and 7 days before a recorded expiry, and told at once when one
 * has passed with no renewal, which stops AYA where that vendor serves, and
 * asks for an incident (patient data may have gone to the vendor between
 * the agreement's real end and the stop). Each alert once for its vendor,
 * phase and expiry day, so a renewal with a new expiry warns again. A
 * withdrawal is told when it is recorded (lib/compliance/platform.ts).
 * A vendor never attested is not watched: that is a platform not yet
 * launched, which go-live already holds back. The alerts never throw; a
 * read that fails fails the watch's run, which the job records.
 */
export async function watchVendorAgreements(
  db: Queryable,
  now: Date = new Date(),
): Promise<VendorWatch> {
  const status = await readPlatformCompliance(db, now);
  const today = utcDay(now);
  const out: VendorWatch = { expiring: 0, lapsed: 0 };
  for (const subject of COVERAGE_VENDORS) {
    const s = status[subject];
    const expiresOn = s.latest?.action === "attested" ? s.latest.expiresOn : null;
    if (!expiresOn) continue;
    if (s.lapsed) {
      out.lapsed += 1;
      await notifyOpsOnce("vendor_agreement_lapsed", {
        code: subject,
        phase: "expired",
        expiresOn,
      });
      continue;
    }
    const days = daysUntil(expiresOn, today);
    const warning = [...EXPIRY_WARNING_DAYS].reverse().find((d) => days <= d);
    if (warning === undefined) continue;
    out.expiring += 1;
    await notifyOpsOnce("vendor_agreement_expiring", {
      code: subject,
      phase: `${warning}_days`,
      expiresOn,
    });
  }
  return out;
}
