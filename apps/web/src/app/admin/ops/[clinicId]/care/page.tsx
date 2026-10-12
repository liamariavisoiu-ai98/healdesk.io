import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import type { ErasureRequester } from "@/lib/admin/erasure-requesters";
import { requireOperator } from "@/lib/admin/operator";
import {
  addReportRecipient as addRecipientUpstream,
  amendContact as amendContactUpstream,
  amendRecord as amendRecordUpstream,
  erasePerson as erasePersonUpstream,
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
 * over, and that the voice vendor's copy was deleted. Three forms here take
 * a patient's details: a deletion request, and the practice's two kinds of
 * amendment. Each passes through its server action to apps/app in the signed
 * request and is kept nowhere on this side, and what the page shows
 * afterwards is who asked, the dates and the counts.
 */

export const metadata: Metadata = { title: "Care" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CarePage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) notFound();

  const view = await fetchClinicCare(clinicId);
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
  // The person's number and address pass through this action to apps/app in
  // the signed request and are kept nowhere on this side.
  async function erasePerson(input: {
    phone?: string;
    email?: string;
    requestedBy: ErasureRequester;
    receivedAt?: string;
  }) {
    "use server";
    const result = await erasePersonUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function markErasureVendorDeleted(erasureId: string, step: string, how: string) {
    "use server";
    const result = await erasureVendorUpstream(clinicId, erasureId, step, how);
    revalidatePath(path);
    return result;
  }
  // The amendment's words and a contact's corrected details pass through
  // these actions to apps/app in the signed request and are kept nowhere on
  // this side.
  async function amendRecord(input: {
    targetKind: "booking_request" | "conversation" | "appointment";
    targetId: string;
    amendment: string;
    requestedBy: string;
    requestedAt?: string;
  }) {
    "use server";
    return amendRecordUpstream(clinicId, input);
  }
  async function amendContact(input: {
    contactId: string;
    fullName?: string;
    phone?: string;
    email?: string;
    /** Fields the practice says to clear, by name: an empty value is never sent. */
    clear?: ("fullName" | "phone" | "email")[];
    requestedBy: string;
  }) {
    "use server";
    return amendContactUpstream(clinicId, input);
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
        erasePerson,
        markErasureVendorDeleted,
        amendRecord,
        amendContact,
      }}
    />
  );
}
