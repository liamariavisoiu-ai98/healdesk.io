import {
  emptyOnboarding,
  ONBOARDING_LABELS,
  openRequiredSteps,
  type OnboardingState,
} from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";

/**
 * Clinic listing for ops, via the SECURITY DEFINER function.
 *
 * The runtime role genuinely cannot do this with a plain SELECT — with no
 * tenant set, `clinics` returns nothing — and the function is the entire
 * exception. Wrapped here so callers don't hand-write the SQL and quietly widen
 * the projection.
 */

export type ClinicOverview = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  specialty: string;
  plan: string | null;
  attributionMode: "estimated" | "verified";
  dataClassification: "synthetic" | "production";
  isCoveredEntity: boolean | null;
  baaSignedAt: Date | null;
  createdAt: Date;
  // Onboarding state (0033). Configuration, never patient data.
  phoneSystemType: "landline" | "voip" | "unknown";
  callRouting: "conditional" | "always";
  callRoutingConfirmedAt: Date | null;
  carrier: string | null;
  synthflowNumberE164: string | null;
  openingHoursPresent: boolean;
  onboarding: OnboardingState;
  agentApprovedAt: Date | null;
  wentLiveAt: Date | null;
  offboardingStartedAt: Date | null;
  exportDeliveredAt: Date | null;
  destroyAfter: Date | null;
  destroyedAt: Date | null;
};

/** Something an operator has to act on before this clinic can go live. */
export type ClinicBlocker = { level: "blocked" | "attention"; message: string };

export async function listClinics(): Promise<ClinicOverview[]> {
  const result = await unsafeDb.execute(
    sql`select id, slug, name, timezone, specialty, plan,
               attribution_mode, data_classification,
               is_covered_entity, baa_signed_at, created_at,
               phone_system_type, call_routing, call_routing_confirmed_at,
               carrier, synthflow_number_e164, opening_hours_present,
               onboarding, agent_approved_at, went_live_at,
               offboarding_started_at, export_delivered_at, destroy_after, destroyed_at
          from app_clinics_overview()`,
  );

  const rows =
    ((result as unknown as { rows?: unknown[] }).rows ?? result) as Record<
      string,
      unknown
    >[];

  return rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    timezone: String(row.timezone),
    specialty: String(row.specialty),
    plan: (row.plan as string | null) ?? null,
    attributionMode: row.attribution_mode as "estimated" | "verified",
    dataClassification: row.data_classification as "synthetic" | "production",
    isCoveredEntity: (row.is_covered_entity as boolean | null) ?? null,
    baaSignedAt: row.baa_signed_at ? new Date(row.baa_signed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    phoneSystemType: (row.phone_system_type as "landline" | "voip" | "unknown") ?? "unknown",
    callRouting: (row.call_routing as "conditional" | "always") ?? "conditional",
    callRoutingConfirmedAt: row.call_routing_confirmed_at
      ? new Date(row.call_routing_confirmed_at as string)
      : null,
    carrier: (row.carrier as string | null) ?? null,
    synthflowNumberE164: (row.synthflow_number_e164 as string | null) ?? null,
    openingHoursPresent: Boolean(row.opening_hours_present),
    onboarding: { ...emptyOnboarding(), ...((row.onboarding as OnboardingState | null) ?? {}) },
    agentApprovedAt: row.agent_approved_at ? new Date(row.agent_approved_at as string) : null,
    wentLiveAt: row.went_live_at ? new Date(row.went_live_at as string) : null,
    offboardingStartedAt: row.offboarding_started_at ? new Date(row.offboarding_started_at as string) : null,
    exportDeliveredAt: row.export_delivered_at ? new Date(row.export_delivered_at as string) : null,
    destroyAfter: row.destroy_after ? new Date(row.destroy_after as string) : null,
    destroyedAt: row.destroyed_at ? new Date(row.destroyed_at as string) : null,
  }));
}

/**
 * What's standing between this clinic and handling real patient data.
 *
 * Ordered by severity, and worded as the action to take rather than the state
 * observed — "sign the BAA" is more useful on a dashboard than "baa_signed_at
 * is null".
 */
export function blockersFor(clinic: ClinicOverview): ClinicBlocker[] {
  const blockers: ClinicBlocker[] = [];

  if (clinic.dataClassification === "production" && !clinic.baaSignedAt) {
    blockers.push({
      level: "blocked",
      message:
        "Marked production with no signed BAA — the database is refusing all patient data.",
    });
  }

  if (clinic.isCoveredEntity === null) {
    // Cash-pay med spas often are not covered entities, which removes the
    // HIPAA exemptions in Washington MHMDA, Texas TDPSA, Nevada SB 370 and the
    // FTC breach rule all at once. It has to be determined, not assumed.
    blockers.push({
      level: "attention",
      message:
        "Covered-entity status not determined. Until it is, we don't know which privacy regime applies.",
    });
  }

  if (clinic.dataClassification === "synthetic") {
    // What stands between this clinic and go-live, as actions. The database
    // function refuses on the same facts; this is the list before the call.
    const open = openRequiredSteps(clinic.onboarding, {
      requirePlatform: clinic.attributionMode === "verified",
    });
    if (!clinic.openingHoursPresent) {
      blockers.push({ level: "attention", message: "Confirm opening hours — after-hours recovery needs them." });
    }
    if (!clinic.callRoutingConfirmedAt) {
      blockers.push({ level: "attention", message: "Confirm call routing: does the number ring at the practice first?" });
    }
    if (!clinic.agentApprovedAt) {
      blockers.push({ level: "attention", message: "Get the agent script approved by the clinic." });
    }
    for (const step of open) {
      if (["hours_confirmed", "call_routing_chosen", "agent_script_approved"].includes(step)) continue;
      blockers.push({ level: "attention", message: `Onboarding: ${ONBOARDING_LABELS[step].title}.` });
    }
    blockers.push({
      level: "attention",
      message: "Synthetic only — not yet accepting real patient data.",
    });
  }

  return blockers;
}
