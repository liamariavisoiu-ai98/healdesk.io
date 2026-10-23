import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { probeLiveness } from "@/lib/host/state";

import AgreementChecksSection from "./AgreementChecksSection";
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
 * One liveness probe first: with the AWS host in standby every apps/app read
 * fails the same way, and five standby notices would say one thing five
 * times. The Sheet-backed Setup requests section does not need the host and
 * still shows. The guard is on this page and in each section: a layout is
 * not a security boundary.
 */

export const metadata: Metadata = { title: "Queues" };
export const dynamic = "force-dynamic";

const SECTIONS = [
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
