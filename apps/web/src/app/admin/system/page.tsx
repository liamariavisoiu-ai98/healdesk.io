import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LiveDemoPipelineRow } from "@/components/admin/DemoPipelineRow";
import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchMachineQueues, fetchStuckCalendarWrites, fetchUndeliveredTranscripts } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { Attention, BeingWatched } from "./Attention";

/**
 * /admin/system: the pages an operator opens rarely and the owner opens on
 * purpose (E1 §2): the host and its costs, the job switches, the system map,
 * the search strategy, the commit feed, and sales (the demo builder and the
 * CRM Sheet, until the CRM session). Map and host keep their addresses: they
 * are in runbooks. One screen of links with one line each; the demo
 * pipeline strip Phase 1 built for the home sits under Sales here, so Home
 * stays one list.
 *
 * Above the links, since Phase 5 (the owner's decision of 24 October 2026),
 * the machine queues as a read-only section: what is past its patience under
 * "Requires your attention" (the queues, the calendar writes stuck across
 * clinics, the transcript copies that never reached a clinic), and the rest
 * as counts under "Being watched". Three reads, settled independently: one
 * that fails costs its part, which says so, never the page. With the AWS host
 * in standby every read fails the same way, so one notice stands in for the
 * two sections rather than three red lines saying one thing.
 */

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

const PAGES = [
  { href: "/admin/host", label: "Host", line: "Whether the AWS host is on, the switch, and what each state costs a month." },
  { href: "/admin/system/jobs", label: "Jobs", line: "Every scheduled job's switch and last result." },
  { href: "/admin/map", label: "Map", line: "Every tool, connection and key, checked live." },
  { href: "/admin/seo", label: "SEO", line: "The search and AI-visibility strategy as state." },
  { href: "/admin/system/changes", label: "Changes", line: "Every commit as it lands, and what is still queued." },
] as const;

const SALES = [
  { href: "/admin/demos", label: "Demos", line: "Build a personalised demo; what was built, held, claimed." },
  { href: "/admin/crm", label: "CRM", line: "The lead register, the marketing Sheet framed." },
] as const;

function Links({ pages }: { pages: readonly { href: string; label: string; line: string }[] }) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {pages.map((p) => (
        <li key={p.href}>
          <a href={p.href} className="border-line hover:border-line-strong block min-h-11 rounded-md border bg-white px-4 py-3 transition-colors">
            <span className="block font-semibold">{p.label}</span>
            <span className="text-muted block text-sm">{p.line}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default async function SystemPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  // Demo clinics' writes stay out here (RULES: synthetic rows behind a filter); a clinic's own Setup tab shows its own.
  const [queues, writes, transcripts] = await Promise.all([fetchMachineQueues(), fetchStuckCalendarWrites(), fetchUndeliveredTranscripts()]);
  const standby = [queues, writes, transcripts].every(isHostUnreachable);
  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">System</h1>
      {standby ? (
        <HostStandbyNotice what="The queues section" />
      ) : (
        <>
          <Attention queues={queues} writes={writes} transcripts={transcripts} />
          <BeingWatched queues={queues} />
        </>
      )}
      <h2 className="mt-10 text-sm font-bold tracking-[0.08em] uppercase">Pages</h2>
      <Links pages={PAGES} />
      <h2 className="mt-10 text-sm font-bold tracking-[0.08em] uppercase">Sales</h2>
      <Links pages={SALES} />
      <LiveDemoPipelineRow />
    </main>
  );
}
