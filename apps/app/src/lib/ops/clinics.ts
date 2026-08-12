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
};

/** Something an operator has to act on before this clinic can go live. */
export type ClinicBlocker = { level: "blocked" | "attention"; message: string };

export async function listClinics(): Promise<ClinicOverview[]> {
  const result = await unsafeDb.execute(
    sql`select id, slug, name, timezone, specialty, plan,
               attribution_mode, data_classification,
               is_covered_entity, baa_signed_at, created_at
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
    blockers.push({
      level: "attention",
      message: "Synthetic only — not yet accepting real patient data.",
    });
  }

  return blockers;
}
