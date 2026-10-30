import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import { closeRightsIntake, fetchClinics, fetchRights, recordRightsIntake } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { checkRecordInput, type RecordRequestInput } from "./record-input";
import { RecordRequestForm, type ClinicChoice } from "./RecordRequestForm";
import { RightsTable } from "./RightsTable";

/**
 * /admin/rights, the Patient rights page (ops automation lane P6b; the
 * tracker is lane P6c's, apps/app lib/ops/rights-ops.ts): every open
 * patient-rights request across clinics with its clock, from the day it
 * reached us to the day the agreement sets, and what to do about each. Home's
 * rights rows and the rights_request_* alerts open this page. Under
 * Compliance in the nav: these are the agreement's clocks.
 *
 * The page runs nothing. A request's command is the run-task.sh line the
 * owner copies and runs himself in AWS CloudShell; recording and closing a
 * request write only what the operator says, as ids, closed words and days.
 * Nothing on this page names a person, a contact id or anything typed.
 *
 * Two reads, settled together: the requests, and the clinic list for the
 * form's select (demo clinics are left out of the requests by apps/app, and
 * named synthetic in the select). The host in standby fails both the same
 * way, so one notice stands in for the page.
 */

export const metadata: Metadata = { title: "Patient rights" };
export const dynamic = "force-dynamic";

const PATH = "/admin/rights";

export default async function RightsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const [rights, clinics] = await Promise.all([fetchRights(), fetchClinics({ connectionState: false })]);
  const standby = isHostUnreachable(rights);
  const today = new Date().toISOString().slice(0, 10);
  const choices: ClinicChoice[] | null = clinics.ok
    ? clinics.data.clinics.map((c) => ({ id: c.id, name: c.name, synthetic: c.dataClassification === "synthetic" }))
    : null;

  // Record one request, once per the form's key: checked here against
  // apps/app's own rules first, so a value off a list is refused in a
  // sentence rather than as the ops client's generic "refused".
  async function record(input: RecordRequestInput) {
    "use server";
    const checked = checkRecordInput(input, new Date().toISOString().slice(0, 10));
    if (!checked.ok) return { ok: true as const, data: { status: "refused" as const, message: checked.message } };
    const result = await recordRightsIntake(checked.input);
    revalidatePath(PATH);
    return result;
  }

  // Close one intake as done, once. The ids are the row's, drawn by this page.
  async function close(clinicId: string, intakeId: string) {
    "use server";
    if (!isUuid(clinicId) || !isUuid(intakeId)) {
      return { ok: false as const, code: "refused" as const, message: "That request is not one on this page. Reload and try again." };
    }
    const result = await closeRightsIntake(clinicId, intakeId, "done");
    revalidatePath(PATH);
    return result;
  }

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-2xl leading-tight font-semibold tracking-[-0.02em]">Patient rights</h1>
      <p className="text-muted mt-2 max-w-[68ch] text-sm">
        Every open patient-rights request across clinics, demo clinics left out, with the day the agreement gives it: ten
        business days for an erasure, an amendment, a correction or an export, five to pass a patient&apos;s own request to the
        practice. Days are Monday to Friday counted in UTC, except a patient&apos;s own request, which counts the
        clinic&apos;s own day, as the host that records it does.
      </p>
      {standby ? (
        <HostStandbyNotice what="The patient-rights requests" />
      ) : (
        <>
          <RightsTable rights={rights} onClose={close} />
          <RecordRequestForm clinics={choices} today={today} onRecord={record} />
        </>
      )}
    </main>
  );
}
