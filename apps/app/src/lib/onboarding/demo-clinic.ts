import { randomUUID } from "node:crypto";

import {
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  NO_PLATFORM_ID,
  type BookingSystemId,
  type CalendarAccount,
  type SpecialtyId,
} from "@healdesk/catalog";

import {
  signAgreement,
  validateSignRequest,
  type SignAgreementRequest,
  type SignedAgreement,
} from "@/lib/agreements";
import { isDemoClinic } from "@/lib/booking/terms";
import { listClinics } from "@/lib/ops/clinics";
import {
  provisionClinic,
  validateProvisionRequest,
  type ProvisionRequest,
} from "@/lib/provisioning";
import { withTenant } from "@/lib/tenant";

/**
 * healdesk's own demo clinic: one fictional practice, allowed in production
 * by the owner (Q6, 5 October 2026), so the Google verification video can
 * show a calendar being connected and booked into before the calendar
 * documents are released (plan §2.6). scripts/demo-clinic.ts is the only
 * caller of createDemoClinic; the test fixtures use it too.
 *
 * It is made exactly as a purchase makes a clinic, by the same two calls, so
 * nothing about it is a special case downstream:
 *
 *   1. signAgreement, on the current template, with the operator as the
 *      signatory and the clinic's one address. The fictional agreement goes
 *      into the register like any other (plan risk 20).
 *   2. provisionClinic with its internal `demo` option, which no request can
 *      carry: entitlements `demo` with no Stripe ids, the clinic synthetic,
 *      the operator its one owner sign-in.
 *
 * The marker, app_clinic_is_demo(), is the database's (drizzle/0056): status
 * `demo`, no Stripe ids, still synthetic. On it, and only on it, a draft
 * calendar election counts. The clinic can never go live (ops goLive
 * refuses one), and should it ever be converted to a purchase, its drafts
 * stop counting at once. Only healdesk's own test Google accounts are ever
 * connected to it (the runbook's rule).
 */

export type DemoClinicInput = {
  /** The fictional practice's name, which the agreement and the clinic carry. */
  name: string;
  /** The operator's own address: the signatory, and the clinic's one sign-in. */
  operatorEmail: string;
  /** The operator's name, as the signature. */
  operatorName: string;
  specialty?: SpecialtyId;
  /** Default `complete`, so every channel can be shown. */
  plan?: string;
  timezone?: string;
  /** Kept on the signature for a template that reads them (1.3.0 on). */
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
};

export type DemoClinic = {
  clinicId: string;
  organizationId: string;
  clinicSlug: string;
  agreementId: string;
  agreementVersion: string;
  ownerUserId: string | null;
  /** Whether the signed agreement's PDF reached the operator, as signAgreement reports it. */
  copy: SignedAgreement["copy"]["status"];
};

const USER_AGENT = "healdesk demo-clinic script";

export async function createDemoClinic(input: DemoClinicInput): Promise<DemoClinic> {
  const specialty = input.specialty ?? "med-spa";
  const request: SignAgreementRequest = {
    clinicLegalName: input.name,
    specialty,
    signatoryName: input.operatorName,
    signatoryTitle: "healdesk operator, for the demo clinic",
    signatoryEmail: input.operatorEmail,
    // "Not sure": the answer under which every specialty HIPAA can reach
    // signs the BAA, before and after the data protection agreement's
    // release alike.
    isCoveredEntity: null,
    attributionMode: "estimated",
    platform: NO_PLATFORM_ID,
    bookingSystem: input.bookingSystem ?? "google_calendar",
    calendarAccount: input.calendarAccount ?? "workspace_no_baa",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  };
  // Exactly what the agreements endpoint would accept, checked as it checks.
  validateSignRequest(request);
  const signed = await signAgreement(request, { userAgent: USER_AGENT });

  const purchase: ProvisionRequest = {
    clinicName: input.name,
    specialty,
    platform: NO_PLATFORM_ID,
    plan: input.plan ?? "complete",
    timezone: input.timezone,
    contactName: input.operatorName,
    contactEmail: input.operatorEmail,
    agreementId: signed.agreementId,
    idempotencyKey: `demo_${randomUUID()}`,
  };
  // And what /api/provision would accept, before the one thing it cannot ask for.
  validateProvisionRequest(purchase);
  const provisioned = await provisionClinic(purchase, { userAgent: USER_AGENT }, { demo: true });

  return {
    clinicId: provisioned.clinicId,
    organizationId: provisioned.organizationId,
    clinicSlug: provisioned.clinicSlug,
    agreementId: signed.agreementId,
    agreementVersion: signed.version,
    ownerUserId: provisioned.ownerUserId ?? null,
    copy: signed.copy.status,
  };
}

/**
 * Every clinic the database calls a demo clinic. A walk of the synthetic
 * clinics, each asked inside its own tenant: entitlements are tenant rows,
 * and app_clinic_is_demo() reads them with the caller's rights. Operator
 * scale only.
 */
export async function existingDemoClinics(): Promise<{ id: string; slug: string; name: string }[]> {
  const found: { id: string; slug: string; name: string }[] = [];
  for (const clinic of await listClinics()) {
    if (clinic.dataClassification !== "synthetic") continue;
    const demo = await withTenant(
      { clinicId: clinic.id, actor: { type: "service", serviceName: "demo-clinic" } },
      (tx) => isDemoClinic(tx),
    );
    if (demo) found.push({ id: clinic.id, slug: clinic.slug, name: clinic.name });
  }
  return found;
}
