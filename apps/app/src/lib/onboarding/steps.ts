import { eq, sql } from "drizzle-orm";

import {
  emptyOnboarding,
  isOnboardingStep,
  type OnboardingState,
  type OnboardingStep,
} from "@healdesk/catalog";

import { clinics } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * The checklist on the clinic row, read and stamped inside a tenant
 * transaction. Stamping is idempotent (a step completed twice keeps its first
 * timestamp) and audited, because "who said the forwarding was tested, and
 * when" is a question the first disputed invoice asks.
 */

export async function readOnboarding(tx: TenantTx): Promise<OnboardingState> {
  const [row] = await tx.db
    .select({ onboarding: clinics.onboarding })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return { ...emptyOnboarding(), ...(row?.onboarding ?? {}) };
}

export async function completeStep(
  tx: TenantTx,
  step: OnboardingStep,
  options: { note?: string; at?: Date } = {},
): Promise<OnboardingState> {
  if (!isOnboardingStep(step)) throw new Error(`Unknown onboarding step: ${String(step)}`);
  const at = (options.at ?? new Date()).toISOString();
  // jsonb concatenation keeps a step that is already stamped: coalesce on the
  // existing value so a second completion never moves the first timestamp.
  // An open step is a JSON null (provisioning seeds every step that way, and
  // reopenStep writes one), which `->` returns as a value rather than SQL
  // NULL, so it is turned into NULL first: without that, coalesce kept the
  // JSON null and a step seeded open could never be stamped.
  await tx.db
    .update(clinics)
    .set({
      onboarding: sql`coalesce(${clinics.onboarding}, '{}'::jsonb) || jsonb_build_object(${step}::text, coalesce(nullif(${clinics.onboarding} -> ${step}::text, 'null'::jsonb), to_jsonb(${at}::text)))`,
      updatedAt: new Date(),
    })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_onboarding",
    resourceId: tx.clinicId,
    metadata: { step, remark: options.note?.slice(0, 200) },
  });
  return readOnboarding(tx);
}

/** Reopen a step — a forwarding test that later failed, a script change. */
export async function reopenStep(tx: TenantTx, step: OnboardingStep, reason: string): Promise<OnboardingState> {
  await tx.db
    .update(clinics)
    .set({
      onboarding: sql`coalesce(${clinics.onboarding}, '{}'::jsonb) || jsonb_build_object(${step}::text, null)`,
      updatedAt: new Date(),
    })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_onboarding",
    resourceId: tx.clinicId,
    metadata: { step, reopened: true, reason: reason.slice(0, 200) },
  });
  return readOnboarding(tx);
}
