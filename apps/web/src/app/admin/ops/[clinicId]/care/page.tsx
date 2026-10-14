import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import type { ErasureStepOutcome } from "@/lib/admin/patient-rights";
import {
  addReportRecipient as addRecipientUpstream,
  fetchClinicCare,
  markErasureVendorDeleted as erasureVendorUpstream,
  markExportDelivered as exportDeliveredUpstream,
  markIncidentNotified as notifiedUpstream,
  markVoiceVendorDataDeleted as vendorDeletedUpstream,
  openIncident as openIncidentUpstream,
  removeReportRecipient as removeRecipientUpstream,
  resolveIncident as resolveUpstream,
  startOffboarding as offboardUpstream,
  type IncidentClass,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { CarePanel } from "./CarePanel";

/**
 * /admin/ops/[clinicId]/care — one clinic after go-live: who gets its mail,
 * what was sent, what went wrong, and the way out.
 *
 * Nothing on this page is a patient. The recipient list and the delivery
 * ledger are addresses the clinic gave us for its own staff; an incident is
 * a summary the ops API refused unless it was written in ids; offboarding is
 * dates, the rule they follow and two operator records. The one thing that IS
 * a patient — the export — is a script on the app host
 * (docs/incident-response.md), and this page only records that it was handed
 * over, and that the voice vendor's copy was deleted. A deletion request and
 * the practice's amendments and corrections carry a patient's details, so
 * they are entered in apps/app's own shell (npm run ops:erase-person,
 * ops:amend-record, ops:amend-contact), never here: until 12 October 2026
 * forms here sent them through a Vercel server action, a hop through a host
 * with no BAA. What the page shows is who asked (one of three), the dates,
 * each subcontractor step and counts.
 */

export const metadata: Metadata = { title: "Care" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CarePage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) notFound();

  const view = await fetchClinicCare(clinicId);
  if (isHostUnreachable(view)) return <HostStandbyPage title="Care" back={{ href: "/admin/ops", label: "Back to ops" }} />;
  const path = `/admin/ops/${clinicId}/care`;

  async function addRecipient(email: string, label?: string) {
    "use server";
    const result = await addRecipientUpstream(clinicId, email, label);
    revalidatePath(path);
    return result;
  }
  async function removeRecipient(email: string) {
    "use server";
    const result = await removeRecipientUpstream(clinicId, email);
    revalidatePath(path);
    return result;
  }
  async function openIncident(input: { class: IncidentClass; summary: string; conversationId?: string; discoveredAt?: string }) {
    "use server";
    const result = await openIncidentUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function markNotified(incidentId: string, how: string) {
    "use server";
    const result = await notifiedUpstream(clinicId, incidentId, how);
    revalidatePath(path);
    return result;
  }
  async function resolve(incidentId: string, resolution: string) {
    "use server";
    const result = await resolveUpstream(clinicId, incidentId, resolution);
    revalidatePath(path);
    return result;
  }
  async function startOffboarding(reason: string) {
    "use server";
    const result = await offboardUpstream(clinicId, reason);
    revalidatePath(path);
    revalidatePath("/admin/ops");
    return result;
  }
  async function markExportDelivered(how: string) {
    "use server";
    const result = await exportDeliveredUpstream(clinicId, how);
    revalidatePath(path);
    return result;
  }
  async function markVoiceVendorDataDeleted(how: string) {
    "use server";
    const result = await vendorDeletedUpstream(clinicId, how);
    revalidatePath(path);
    return result;
  }
  // The deletion, amendments and corrections are not here: they carry a
  // patient's identifiers or words, so the operator enters them in apps/app's
  // own shell (lib/admin/patient-rights.ts names the scripts). What this page
  // sends is ids and a closed outcome.
  async function markErasureVendorDeleted(erasureId: string, step: "retell", how: ErasureStepOutcome) {
    "use server";
    const result = await erasureVendorUpstream(clinicId, erasureId, step, how);
    revalidatePath(path);
    return result;
  }

  return (
    <CarePanel
      view={view}
      actions={{
        addRecipient,
        removeRecipient,
        openIncident,
        markNotified,
        resolve,
        startOffboarding,
        markExportDelivered,
        markVoiceVendorDataDeleted,
        markErasureVendorDeleted,
      }}
    />
  );
}
