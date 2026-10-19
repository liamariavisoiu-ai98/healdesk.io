import {
  agreementKindOfVersion,
  agreementKindSufficient,
  CURRENT_BAA_VERSION,
  emptyOnboarding,
  type AgreementKind,
  type OnboardingState,
  type RegulatoryRegime,
} from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { ForwardingTestObservation } from "@/db/schema";
import { agreementTemplateReleased } from "@/lib/agreements/kind";

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
  // Which calls reach AYA is clinic_settings.coverage_mode, a tenant row this
  // cross-clinic read cannot see; the onboarding view reads it in the
  // clinic's own tenant (lib/ops/api.ts). clinics.call_routing is not read
  // here. When the operator confirmed it is.
  callRoutingConfirmedAt: Date | null;
  carrier: string | null;
  assistantNumberE164: string | null;
  openingHoursPresent: boolean;
  onboarding: OnboardingState;
  agentApprovedAt: Date | null;
  wentLiveAt: Date | null;
  offboardingStartedAt: Date | null;
  exportDeliveredAt: Date | null;
  destroyAfter: Date | null;
  destroyedAt: Date | null;
  // Phase 8 (0035): the forwarding test and the Connect account. Configuration.
  publishedPhoneE164: string | null;
  forwardingTestUntil: Date | null;
  forwardingTestObserved: ForwardingTestObservation | null;
  stripeConnectAccountId: string | null;
  stripeConnectConnectedAt: Date | null;
  metaFrontDoorEnabled: boolean;
  // 0040 (§A.14): booking mode, the direct-booking election, the confirmed
  // time zone and the booking requirement set. Configuration. (0041 dropped
  // the call-back switch and the Synthflow callback agent id.)
  bookingMode: "desk_confirms" | "direct";
  directBookingElectedAt: Date | null;
  directBookingWithdrawnAt: Date | null;
  timezoneConfirmedAt: Date | null;
  /** Catalogue ids, or null when the specialty defaults apply. */
  bookingRequirements: string[] | null;
  bookingRequirementsConfirmedAt: Date | null;
  bookingRequirementsSource: "practice" | "operator" | "defaults" | null;
  // 0043: the clinic whose subscription this location is billed on (null: its
  // own billing clinic), and when its Stripe Connect account was disconnected.
  billingClinicId: string | null;
  stripeConnectDisconnectedAt: Date | null;
  /**
   * 0048: the version of the agreement in effect (app_agreement_in_effect),
   * or null when none is bound and unterminated. Contract metadata, never
   * patient data. Read outside a tenant, as every caller here does; inside
   * one, RLS hides every other organisation's agreement and this reads null.
   */
  baaVersion: string | null;
  /**
   * 0058: the version of the agreement the clinic was bound to when its
   * service ended (app_agreement_at_end), terminated since or not, or null
   * while it is not offboarding or held none then. The destruction rule is
   * read from it (destructionPlan in lib/offboarding). Contract metadata.
   */
  destructionAgreementVersion: string | null;
  /**
   * 0090: the agreement gate's two columns (0051), the regime of the
   * clinic's specialty at provisioning and the kind of agreement it records,
   * so the card can say an agreement does not cover the practice before
   * go-live refuses it. Null on a clinic created before 0051.
   */
  regulatoryRegime: RegulatoryRegime | null;
  agreementKind: AgreementKind | null;
};

/** Something an operator has to act on before this clinic can go live. */
export type ClinicBlocker = { level: "blocked" | "attention"; message: string };

export async function listClinics(): Promise<ClinicOverview[]> {
  const result = await unsafeDb.execute(
    sql`select id, slug, name, timezone, specialty, plan,
               attribution_mode, data_classification,
               is_covered_entity, baa_signed_at, created_at,
               phone_system_type, call_routing_confirmed_at,
               carrier, assistant_number_e164, opening_hours_present,
               onboarding, agent_approved_at, went_live_at,
               offboarding_started_at, export_delivered_at, destroy_after, destroyed_at,
               published_phone_e164, forwarding_test_until, forwarding_test_observed,
               stripe_connect_account_id, stripe_connect_connected_at, meta_front_door_enabled,
               booking_mode, direct_booking_elected_at, direct_booking_withdrawn_at,
               timezone_confirmed_at,
               booking_requirements, booking_requirements_confirmed_at, booking_requirements_source,
               billing_clinic_id, stripe_connect_disconnected_at,
               baa_version, destruction_agreement_version,
               regulatory_regime, agreement_kind
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
    callRoutingConfirmedAt: row.call_routing_confirmed_at
      ? new Date(row.call_routing_confirmed_at as string)
      : null,
    carrier: (row.carrier as string | null) ?? null,
    assistantNumberE164: (row.assistant_number_e164 as string | null) ?? null,
    openingHoursPresent: Boolean(row.opening_hours_present),
    onboarding: { ...emptyOnboarding(), ...((row.onboarding as OnboardingState | null) ?? {}) },
    agentApprovedAt: row.agent_approved_at ? new Date(row.agent_approved_at as string) : null,
    wentLiveAt: row.went_live_at ? new Date(row.went_live_at as string) : null,
    offboardingStartedAt: row.offboarding_started_at ? new Date(row.offboarding_started_at as string) : null,
    exportDeliveredAt: row.export_delivered_at ? new Date(row.export_delivered_at as string) : null,
    destroyAfter: row.destroy_after ? new Date(row.destroy_after as string) : null,
    destroyedAt: row.destroyed_at ? new Date(row.destroyed_at as string) : null,
    publishedPhoneE164: (row.published_phone_e164 as string | null) ?? null,
    forwardingTestUntil: row.forwarding_test_until ? new Date(row.forwarding_test_until as string) : null,
    forwardingTestObserved: (row.forwarding_test_observed as ForwardingTestObservation | null) ?? null,
    stripeConnectAccountId: (row.stripe_connect_account_id as string | null) ?? null,
    stripeConnectConnectedAt: row.stripe_connect_connected_at ? new Date(row.stripe_connect_connected_at as string) : null,
    metaFrontDoorEnabled: Boolean(row.meta_front_door_enabled),
    bookingMode: row.booking_mode === "direct" ? "direct" : "desk_confirms",
    directBookingElectedAt: row.direct_booking_elected_at ? new Date(row.direct_booking_elected_at as string) : null,
    directBookingWithdrawnAt: row.direct_booking_withdrawn_at ? new Date(row.direct_booking_withdrawn_at as string) : null,
    timezoneConfirmedAt: row.timezone_confirmed_at ? new Date(row.timezone_confirmed_at as string) : null,
    bookingRequirements: Array.isArray(row.booking_requirements)
      ? (row.booking_requirements as unknown[]).filter((v): v is string => typeof v === "string")
      : null,
    bookingRequirementsConfirmedAt: row.booking_requirements_confirmed_at
      ? new Date(row.booking_requirements_confirmed_at as string)
      : null,
    bookingRequirementsSource: (["practice", "operator", "defaults"] as const).find((s) => s === row.booking_requirements_source) ?? null,
    billingClinicId: (row.billing_clinic_id as string | null) ?? null,
    stripeConnectDisconnectedAt: row.stripe_connect_disconnected_at
      ? new Date(row.stripe_connect_disconnected_at as string)
      : null,
    baaVersion: (row.baa_version as string | null) ?? null,
    destructionAgreementVersion: (row.destruction_agreement_version as string | null) ?? null,
    regulatoryRegime: (["hipaa", "hipaa-if-covered", "non-hipaa"] as const).find((r) => r === row.regulatory_regime) ?? null,
    agreementKind: (["baa", "dpa"] as const).find((k) => k === row.agreement_kind) ?? null,
  }));
}

/**
 * What's standing between this clinic and handling real patient data, as the
 * clinic list shows it.
 *
 * Ordered by severity, and worded as the action to take rather than the state
 * observed — "sign the BAA" is more useful on a dashboard than "baa_signed_at
 * is null". Go-live is automatic (lib/onboarding/go-live.ts) and the whole
 * of what it waits on is on the clinic's onboarding page, read in the
 * clinic's tenant; this list, read across clinics from the overview, says
 * what the overview alone can: the agreement and the covered status.
 */
export function blockersFor(clinic: ClinicOverview): ClinicBlocker[] {
  const blockers: ClinicBlocker[] = [];
  const live = clinic.dataClassification === "production";

  if (live && !clinic.baaSignedAt) {
    blockers.push({
      level: "blocked",
      message:
        "Marked production with no signed BAA — the database is refusing all patient data.",
    });
  }

  if (clinic.baaVersion !== null && !agreementTemplateReleased(clinic.baaVersion)) {
    // Before the covered-entity line on purpose: when nothing is blocked the
    // clinic card shows the first item, and on a synthetic clinic this one
    // decides whether it can go live at all (app_mark_clinic_production
    // refuses it). Not "blocked": a live clinic keeps running under the
    // agreement it signed while the practice accepts the current one.
    const dpa = agreementKindOfVersion(clinic.baaVersion) === "dpa";
    blockers.push({
      level: "attention",
      message: dpa
        ? `The data protection agreement ${clinic.baaVersion} is not released: the practice can't go live under it until it is.`
        : live
          ? `Live under BAA v${clinic.baaVersion}, which has been superseded: have the practice accept v${CURRENT_BAA_VERSION}.`
          : `BAA v${clinic.baaVersion} has been superseded: the practice accepts v${CURRENT_BAA_VERSION} before go-live.`,
    });
  }

  if (
    clinic.baaVersion !== null &&
    clinic.regulatoryRegime !== null &&
    !agreementKindSufficient(
      clinic.regulatoryRegime,
      agreementKindOfVersion(clinic.baaVersion),
      clinic.isCoveredEntity,
    )
  ) {
    // The PHI gate refuses a production clinic's data in this state
    // (app_clinic_accepts_phi, 0051), and go-live refuses a synthetic one.
    blockers.push({
      level: live ? "blocked" : "attention",
      message: live
        ? "Its agreement no longer covers the practice, so the database refuses its patient data: move it to a business associate agreement."
        : "Its agreement does not cover the practice: it signs a business associate agreement before go-live.",
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

  if (!live) {
    blockers.push({
      level: "attention",
      message:
        "Synthetic only — not yet accepting real patient data. It goes live by itself once everything go-live asks holds; its onboarding page lists what is left.",
    });
  }

  return blockers;
}
