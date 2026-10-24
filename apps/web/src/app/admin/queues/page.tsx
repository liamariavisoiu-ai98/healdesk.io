import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { APPROVALS_JOB } from "@/components/admin/approval-words";
import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import { requireOperator } from "@/lib/admin/operator";
import { fetchApprovalHistory, fetchApprovals, fetchJobs, type ApproveReason, type RejectReason } from "@/lib/admin/ops-client";
import { probeLiveness } from "@/lib/host/state";

import AgreementChecksSection from "./AgreementChecksSection";
import { ApprovalsSection } from "./ApprovalsSection";
import RecordingsSection from "./RecordingsSection";
import ReviewsSection from "./ReviewsSection";
import SetupRequestsSection from "./SetupRequestsSection";
import SiteReadsSection from "./SiteReadsSection";
import SupportSection from "./SupportSection";

/**
 * /admin/queues: the five small queues that each had a nav slot, on one page
 * with sections and counts (E1 §2): Reviews, Agreement checks, Support,
 * Retell deletions, Site reads, Setup requests. Each section is the old
 * page's body minus its heading prose, in its own file with its own server
 * actions, so its page test moved with it. The old addresses redirect here
 * forever, to the section (`#support`).
 *
 * Each section's form comes back with its outcome in its own query key
 * (`?support=marked`, `?retell=deleted`, `?setup=sent`), never a shared
 * `result`, because two sections' outcome words overlap ("already",
 * "not_found") and a message under the wrong section is a lie.
 *
 * Approvals (ops automation Phase 6, lane P6b) is the one section whose
 * controls do not post a form: a decision needs the fresh code from the
 * operator's authenticator and comes back with the operation's own sentence
 * (a re-armed request, a Stripe invoice, a replayed event), which no closed
 * query word could carry, so it uses the Setup tab's step-up pattern: a
 * client section calling the `decide` action below, which enters through
 * lib/admin/approval-decide.ts (the session, then the code, then the signed
 * request) and shows the outcome in place. Its two reads happen only when
 * the host answers, with the others.
 *
 * One liveness probe first: with the AWS host in standby every apps/app read
 * fails the same way, and five standby notices would say one thing five
 * times. The Sheet-backed Setup requests section does not need the host and
 * still shows. The guard is on this page and in each section: a layout is
 * not a security boundary.
 */

export const metadata: Metadata = { title: "Queues" };
export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "approvals", label: "Approvals" },
  { id: "reviews", label: "Reviews" },
  { id: "agreement-checks", label: "Agreement checks" },
  { id: "support", label: "Support" },
  { id: "retell-deletions", label: "Retell deletions" },
  { id: "site-reads", label: "Site reads" },
  { id: "setup-requests", label: "Setup requests" },
] as const;

type Query = { support?: string; retell?: string; setup?: string };

export default async function QueuesPage({ searchParams }: { searchParams: Promise<Query> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const query = await searchParams;
  const liveness = await probeLiveness();
  const standby = liveness === "unreachable";
  const now = new Date().toISOString();
  // The approval inbox's reads, settled together; one that fails costs its
  // tab, never the page. The jobs are read for one switch, the approvals
  // job's: an empty list with that job off means nothing is being proposed,
  // which the empty line then says. A failed jobs read says nothing extra.
  const [approvals, history, jobs] = standby
    ? [null, null, null]
    : await Promise.all([fetchApprovals(), fetchApprovalHistory(), fetchJobs()]);
  const proposerOn = jobs?.ok ? (jobs.data.find((job) => job.name === APPROVALS_JOB)?.enabled ?? null) : null;

  // A decision on the approval inbox: the ids and the reason come from the
  // card the page drew, and the wrapper checks each (a uuid, approve or
  // reject, a reason from the closed list) before the code and the request.
  // Revalidated so the decided item leaves the waiting list on the refresh.
  async function decide(approvalId: string, action: "approve" | "reject", reasonCode: ApproveReason | RejectReason, code: string) {
    "use server";
    const result = await decideApprovalWithCode(approvalId, action, reasonCode, code);
    revalidatePath("/admin/queues");
    return result;
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">Queues</h1>
      <nav aria-label="Queues" className="mt-4 flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors">
            {s.label}
          </a>
        ))}
      </nav>

      {standby ? (
        <HostStandbyNotice what="Every queue but the setup requests" />
      ) : (
        <>
          {approvals && history ? <ApprovalsSection approvals={approvals} history={history} proposerOn={proposerOn} now={now} onDecide={decide} /> : null}
          <ReviewsSection />
          <AgreementChecksSection />
          <SupportSection searchParams={Promise.resolve({ result: query.support })} />
          <RecordingsSection searchParams={Promise.resolve({ result: query.retell })} />
          <SiteReadsSection />
        </>
      )}
      <SetupRequestsSection searchParams={Promise.resolve({ result: query.setup })} />
    </main>
  );
}
