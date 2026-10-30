import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchJobs, toggleJob as toggleJobUpstream, type OpsResult, type ToggleJobOutcome } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { JobsTable } from "./JobsTable";

/**
 * /admin/system/jobs: every scheduled job's switch and last result, one
 * table (E1 §2). Until the admin redesign (23 October 2026) this was the
 * middle of /admin/ops. The toggle is a server action over ops-client, whose
 * session check is the only door to the ops API; the operator identity in
 * the audit row comes from the session cookie inside it, never from here.
 * The guard is on this page: a layout is not a security boundary.
 */

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

const PATH = "/admin/system/jobs";

async function toggleJob(name: string, enabled: boolean): Promise<OpsResult<ToggleJobOutcome>> {
  "use server";
  const result = await toggleJobUpstream(name, enabled);
  // Even on failure: the operator should see the list they are working from
  // refresh under them rather than wonder whether it moved.
  revalidatePath(PATH);
  return result;
}

export default async function JobsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const jobs = await fetchJobs();
  if (isHostUnreachable(jobs)) return <HostStandbyPage title="Jobs" back={{ href: "/admin/system", label: "← System" }} />;

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <a href="/admin/system" className="text-muted text-sm underline underline-offset-2">
        ← System
      </a>
      <h1 className="font-display mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]">Jobs</h1>
      <JobsTable jobs={jobs} onToggle={toggleJob} />
    </main>
  );
}
