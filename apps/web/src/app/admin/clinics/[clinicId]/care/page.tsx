import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { loadClinicRows } from "@/lib/admin/clinic-strip";
import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import {
  addReportRecipient as addRecipientUpstream,
  fetchClinicCare,
  markErasureVendorDeleted as erasureVendorUpstream,
  markExportDelivered as exportDeliveredUpstream,
  markIncidentNotified as notifiedUpstream,
  markVoiceVendorDataDeleted as vendorDeletedUpstream,
  openIncident as openIncidentUpstream,
  recordClinicTouch as recordTouchUpstream,
  removeReportRecipient as removeRecipientUpstream,
  resolveIncident as resolveUpstream,
  startOffboarding as offboardUpstream,
  type IncidentClass,
} from "@/lib/admin/ops-client";
import type { ErasureStepOutcome } from "@/lib/admin/patient-rights";
import { isHostUnreachable } from "@/lib/host/state";

import { CarePanel } from "./CarePanel";
import { TouchLog } from "./TouchLog";

/**
 * /admin/clinics/[id]/care, the Care tab: one clinic after go-live: who gets
 * its mail, what went wrong, the patient-rights steps, and the way out.
 * Until the admin redesign (23 October 2026) this was /admin/ops/[id]/care,
 * which redirects here forever; what was sent is on the Deliveries tab.
 *
 * Nothing on this page is a patient. The recipient list is addresses the
 * clinic gave us for its own staff; an incident is a summary the ops API
 * refused unless it was written in ids; offboarding is dates, the rule they
 * follow and two operator records. The one thing that IS a patient, the
 * export, is a script on the app host (docs/incident-response.md), and this
 * page only records that it was handed over, and that the voice vendor's
 * copy was deleted. A deletion request and the practice's amendments and
 * corrections carry a patient's details, so they are entered in apps/app's
 * own shell (npm run ops:erase-person, ops:amend-record, ops:amend-contact),
 * never here: until 12 October 2026 forms here sent them through a Vercel
 * server action, a hop through a host with no BAA. What the page shows is
 * who asked (one of three), the dates, each subcontractor step and counts.
 */

export const metadata: Metadata = { title: "Care" };
export const dynamic = "force-dynamic";

export default async function CarePage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();

  const [view, reads] = await Promise.all([fetchClinicCare(clinicId), loadClinicRows()]);
  if (isHostUnreachable(view)) return <HostStandbyNotice what="Care" />;
  const path = clinicTabPath(clinicId, "care");
  const health = reads.health.ok ? (reads.health.data.find((h) => h.clinicId === clinicId.toLowerCase()) ?? null) : null;

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
    revalidatePath("/admin/clinics");
    return result;
  }
  async function markExportDelivered(how: string) {
    "use server";
    const result = await exportDeliveredUpstream(clinicId, how);
    revalidatePath(path);
    return result;
  }
  async function markVoiceVendorDataDeleted(how: string, step: "calls" | "agent") {
    "use server";
    const result = await vendorDeletedUpstream(clinicId, how, step === "agent" ? "agent" : "calls");
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
  // The first-weeks touch log (a call, an email, a note about the clinic;
  // never a patient), so the second call knows about the first.
  async function recordTouch(input: { kind: "call" | "email" | "note"; summary: string; outcome?: string }) {
    "use server";
    const result = await recordTouchUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }

  return (
    <>
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
      <TouchLog health={health} onTouch={recordTouch} />
    </>
  );
}
