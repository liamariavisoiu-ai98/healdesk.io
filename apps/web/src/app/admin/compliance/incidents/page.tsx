import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchIncidentRegister,
  markIncidentNotReportable as notReportableUpstream,
  sendIncidentReport as sendReportUpstream,
  type IncidentReportFields,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { IncidentsBoard } from "./IncidentsBoard";

/**
 * /admin/compliance/incidents (until 23 October 2026 /admin/incidents): every practice's incidents on one page (WP7; plan Part
 * K), each with the deadline its agreement promises and healdesk's internal
 * target beside it, and ops' decision: "Send report", which emails the
 * practice an L29 report built from fixed fields only, or "Not reportable",
 * which records the reason. Nothing reaches a practice unless ops sends it.
 *
 * Incidents are opened, notified and resolved from each practice's care
 * page, as before; this page is where they are decided. Everything goes
 * through the ops envelope: the report's fields are the catalog's codes,
 * counts and a date, and the reason is scanned by apps/app for anything that
 * looks like a patient's details. The list of people affected is never
 * emailed and never typed here.
 */

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance/incidents";

export default async function IncidentsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const register = await fetchIncidentRegister();
  if (isHostUnreachable(register)) return <HostStandbyPage title="Incidents" />;

  async function sendReport(clinicId: string, incidentId: string, fields: IncidentReportFields) {
    "use server";
    const result = await sendReportUpstream(clinicId, incidentId, fields);
    revalidatePath(PATH);
    return result;
  }
  async function notReportable(clinicId: string, incidentId: string, reason: string) {
    "use server";
    const result = await notReportableUpstream(clinicId, incidentId, reason);
    revalidatePath(PATH);
    return result;
  }

  return (
    <IncidentsBoard
      register={register}
      now={new Date().toISOString()}
      actions={{ sendReport, notReportable }}
    />
  );
}
