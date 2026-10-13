import { eq } from "drizzle-orm";

import { clinics, clinicSettings, entitlements } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { getEntitlementsForUpdate, setUsageAlertsEnabled } from "@/lib/billing/entitlements";
import { stopStepsTo } from "@/lib/notices/steps-sent";
import { withTenant, type TenantTx } from "@/lib/tenant";

import type { NoticeSwitch } from "./kinds";
import type { StopTarget } from "./unsubscribe";

/**
 * The optional emails' switches (Annex X3, "Optional email"), read by the
 * sender and turned off by a stop link (lib/email/unsubscribe.ts):
 *
 *   - `usage_alerts`: the 90% and 100% allowance emails, the billing
 *     clinic's `entitlements.usage_alerts_enabled`, which Billing's switch
 *     also writes;
 *   - `daily_summary`: the morning summary, `clinic_settings.daily_summary`,
 *     which Settings → Alerts also writes;
 *   - `product_updates`: L33, M7's. No email carries it yet and it has no
 *     column, so it is always on and a stop link for it changes nothing.
 *
 * Every other email is part of the service and has no switch. O11's link
 * (`steps`) is not a clinic's switch: it stops the clinic's sent-on steps
 * reaching the one address it went to (lib/notices/steps-sent.ts).
 */

/** Whether a clinic's switch lets an optional email of this kind go. Read in the notice's own tenant. */
export async function optionalEmailAllowed(tx: TenantTx, which: NoticeSwitch): Promise<boolean> {
  switch (which) {
    case "usage_alerts": {
      // Package C queues usage alerts on the billing clinic, so this tenant
      // is the one whose row holds the switch.
      const [row] = await tx.db
        .select({ on: entitlements.usageAlertsEnabled })
        .from(entitlements)
        .where(eq(entitlements.clinicId, tx.clinicId))
        .limit(1);
      return row?.on ?? true;
    }
    case "daily_summary": {
      const [row] = await tx.db
        .select({ on: clinicSettings.dailySummary })
        .from(clinicSettings)
        .where(eq(clinicSettings.clinicId, tx.clinicId))
        .limit(1);
      return row?.on ?? true;
    }
    case "product_updates":
      return true;
  }
}

export type StopOutcome =
  /** The switch is off now (or already was). */
  | { status: "stopped"; clinicName: string }
  /** Nothing this link can stop: no clinic, or a scope no email of ours carries. */
  | { status: "nothing" };

const STOP_ACTOR: ActorContext = { type: "service", serviceName: "email-stop-link" };

/**
 * Turn an optional email off from its stop link. The link is signed for one
 * clinic and one switch (unsubscribe.ts), so this stops that one email for
 * that one clinic and signs nobody in. Idempotent: a second click, or a mail
 * client's one-click POST after the person's own, changes nothing more.
 */
export async function stopOptionalEmail(target: StopTarget): Promise<StopOutcome> {
  const { clinicId, scope } = target;
  if (scope === "steps") {
    if (!target.deliveryId) return { status: "nothing" };
    const done = await stopStepsTo(clinicId, target.deliveryId, STOP_ACTOR);
    return done ? { status: "stopped", clinicName: done.clinicName } : { status: "nothing" };
  }
  if (scope !== "usage_alerts" && scope !== "daily_summary") return { status: "nothing" };
  return withTenant({ clinicId, actor: STOP_ACTOR }, async (tx) => {
    const [clinic] = await tx.db
      .select({ name: clinics.name })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return { status: "nothing" as const };
    if (scope === "usage_alerts") {
      const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
      if (!row) return { status: "nothing" as const };
      if (row.usageAlertsEnabled) await setUsageAlertsEnabled(tx.db, tx.clinicId, false);
    } else {
      await tx.db
        .insert(clinicSettings)
        .values({ clinicId: tx.clinicId, dailySummary: false, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: clinicSettings.clinicId,
          set: { dailySummary: false, updatedAt: new Date() },
        });
    }
    tx.audit.record({
      action: "update",
      resourceType: scope === "usage_alerts" ? "entitlements" : "clinic_settings",
      resourceId: tx.clinicId,
      metadata: { field: scope, on: false, via: "stop_link" },
    });
    return { status: "stopped" as const, clinicName: clinic.name };
  });
}
