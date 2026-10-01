import { sql } from "drizzle-orm";

import { openRequiredSteps, type OnboardingStep } from "@healdesk/catalog";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { env } from "@/lib/env";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";

/**
 * Go-live: the flip from synthetic to production.
 *
 * The database function (drizzle/0033) is the authority and refuses on its
 * own; this wrapper exists to give the operator the list of what is missing
 * BEFORE the call, in the console's words, and to write the security event
 * naming who flipped it. Both checks agree because both read the same row.
 */

export type GoLiveCheck = { ok: true } | { ok: false; missing: string[] };

export function goLivePreconditions(clinic: ClinicOverview): GoLiveCheck {
  const missing: string[] = [];
  if (clinic.isCoveredEntity === null) missing.push("Covered-entity status is undetermined.");
  if (!clinic.baaSignedAt && !clinic.wentLiveAt) {
    // baa_signed_at is set BY go-live from the bound agreement; before it the
    // precondition is the bound agreement itself, which the function checks.
  }
  if (!clinic.openingHoursPresent) missing.push("Opening hours are not on file.");
  if (!clinic.callRoutingConfirmedAt) missing.push("Call routing has not been confirmed.");
  if (!clinic.agentApprovedAt) missing.push("The agent script has not been approved.");
  // Phase two: a booking-system connection is required only for verified
  // attribution, which v1 does not offer, so in v1 go-live never waits on it.
  const open: OnboardingStep[] = openRequiredSteps(clinic.onboarding, {
    requirePlatform: env.phaseTwoAttribution() && clinic.attributionMode === "verified",
  });
  for (const step of open) missing.push(`Onboarding step open: ${step.replace(/_/g, " ")}.`);
  return missing.length ? { ok: false, missing } : { ok: true };
}

export type GoLiveResult =
  | { status: "live"; baaSignedAt: Date }
  | { status: "refused"; reason: string; missing: string[] }
  | { status: "not_found" };

export async function goLive(
  clinicId: string,
  operator: { label: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<GoLiveResult> {
  const clinic = (await listClinics()).find((c) => c.id === clinicId);
  if (!clinic) return { status: "not_found" };
  if (clinic.dataClassification === "production") {
    return { status: "refused", reason: "Already in production.", missing: [] };
  }
  const check = goLivePreconditions(clinic);
  if (!check.ok) return { status: "refused", reason: "Not ready.", missing: check.missing };

  try {
    const result = await unsafeDb.execute<{ signed: Date }>(
      sql`select app_mark_clinic_production(${clinicId}::uuid) as signed`,
    );
    const signed = (result as unknown as { rows?: { signed: Date }[] }).rows?.[0]?.signed;
    if (!signed) return { status: "refused", reason: "The database refused without a reason.", missing: [] };

    await recordSecurityEvent(unsafeDb, {
      event: "clinic_went_live",
      actorLabel: operator.label,
      ipAddress: operator.ipAddress ?? null,
      userAgent: operator.userAgent ?? null,
      // No timestamp in the metadata: the audit scanner reads a date's digit
      // run as a phone number, and the flip's time is on the clinic row.
      metadata: { clinicSlug: clinic.slug, baaSigned: true },
    });
    return { status: "live", baaSignedAt: new Date(signed) };
  } catch (error) {
    // The function's message names exactly what is missing and carries no
    // patient data; it is the honest answer for the console.
    const message = error instanceof Error ? error.message : "Refused.";
    return { status: "refused", reason: message.slice(0, 300), missing: [] };
  }
}
