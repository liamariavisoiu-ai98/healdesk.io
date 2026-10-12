import { sql } from "drizzle-orm";

import {
  CURRENT_BAA_VERSION,
  isBaaVersionAcceptable,
  openRequiredSteps,
  type OnboardingStep,
} from "@healdesk/catalog";

import { unsafeDb } from "@/db";
import { recordSecurityEvent, type ActorContext } from "@/lib/audit";
import { env } from "@/lib/env";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

/**
 * Go-live: the flip from synthetic to production.
 *
 * The database function (drizzle/0033, last redefined in 0048) is the
 * authority and refuses on its own; this wrapper exists to give the operator
 * the list of what is missing BEFORE the call, in the console's words, and to
 * write the security event naming who flipped it. Both checks agree because
 * both read the same row, and the same agreement: `baaVersion` comes from
 * app_agreement_in_effect(), which the function reads too.
 */

export type GoLiveCheck = { ok: true } | { ok: false; missing: string[] };

/** Whether the clinic bought phone, and its direct line: what phone needs before it can go live. */
export type VoiceLine = { voiceBought: boolean; directLine: string | null };

const GO_LIVE_ACTOR: ActorContext = { type: "service", serviceName: "go-live" };

/** The clinic's phone purchase and direct line, read in its own tenant. */
export async function readVoiceLine(clinicId: string): Promise<VoiceLine> {
  return withTenant({ clinicId, actor: GO_LIVE_ACTOR }, async (tx) => {
    const result = await tx.db.execute<{ voice: boolean; line: string | null }>(
      sql`select exists (select 1 from clinic_channels
                          where clinic_id = ${clinicId}::uuid and channel = 'voice') as voice,
                 (select direct_line_e164 from clinic_settings
                   where clinic_id = ${clinicId}::uuid) as line`,
    );
    const row = result.rows[0];
    return { voiceBought: row?.voice === true, directLine: row?.line ?? null };
  });
}

/** Phone without a direct line: every call AYA can't answer has nowhere to go. */
export const NO_DIRECT_LINE =
  "Phone has no direct line on file. Every call AYA can't answer goes there, so phone can't go live without one.";

export function goLivePreconditions(clinic: ClinicOverview, voice?: VoiceLine): GoLiveCheck {
  // TODO(plan Part J "Go-live", with app_mark_clinic_production): ask whether
  // the agreement covers the clinic (agreementKindSufficient in
  // lib/agreements/kind.ts, over clinics.regulatory_regime and
  // clinics.agreement_kind, drizzle/0051). The overview does not project those
  // columns yet, and recreating app_clinics_overview() for them belongs to the
  // rewrite of both checks. Meanwhile the PHI gate refuses an uncovered
  // clinic's data on every write.
  const missing: string[] = [];
  if (clinic.isCoveredEntity === null) missing.push("Covered-entity status is undetermined.");
  // baa_signed_at is set BY go-live from the bound agreement, so before it the
  // precondition is the agreement in effect, and it must not be superseded
  // (docs/counsel/agreement-changes.md §10): an account bound to an older
  // version lacks clauses the current one has.
  if (clinic.baaVersion === null) {
    missing.push("No signed business associate agreement is in effect for this account.");
  } else if (!isBaaVersionAcceptable(clinic.baaVersion)) {
    missing.push(
      `The agreement in effect is BAA v${clinic.baaVersion}, which has been superseded. The practice must accept v${CURRENT_BAA_VERSION} before go-live.`,
    );
  }
  if (!clinic.openingHoursPresent) missing.push("Opening hours are not on file.");
  if (!clinic.callRoutingConfirmedAt) missing.push("Call routing has not been confirmed.");
  if (!clinic.agentApprovedAt) missing.push("The agent script has not been approved.");
  // CLAUDE.md, "Failure": every degradation path ends with calls forwarding
  // to a direct clinic line. The wizard lets the line be skipped, and says
  // phone can't go live without it; this is where that holds.
  if (voice?.voiceBought && !voice.directLine) missing.push(NO_DIRECT_LINE);
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
  const check = goLivePreconditions(clinic, await readVoiceLine(clinicId));
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
    return { status: "refused", reason: refusalReason(error), missing: [] };
  }
}

/**
 * The database's own refusal, not drizzle's wrapper around it.
 *
 * drizzle-orm 0.45 wraps the driver error in a `DrizzleQueryError` whose
 * message is "Failed query: select app_mark_clinic_production($1::uuid) …"
 * followed by the parameters; the RAISE text and its HINT sit on the pg
 * error at `.cause`. Until this walked the chain, every refusal the database
 * made reached the console as the failed query. Bounded depth, as
 * lib/provisioning.ts and the connect action walk it. An error with no
 * SQLSTATE anywhere in the chain (the database unreachable, say) keeps its
 * own message.
 */
export function refusalReason(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; hint?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.message === "string") {
      const hint = typeof e.hint === "string" && e.hint ? ` ${e.hint}` : "";
      return `${e.message}${hint}`.slice(0, 500);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message.slice(0, 500) : "Refused.";
}
