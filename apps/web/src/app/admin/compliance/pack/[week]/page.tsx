import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { weekWords } from "@/components/admin/pack-words";
import { Failure } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { fetchCompliancePack } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { addDays, isWeekStart } from "../pack-week";
import { PackView } from "./PackView";

/**
 * /admin/compliance/pack/<week>, the printable compliance pack of one week
 * (ops automation lane P6j; the pack is lane P6h's, apps/app
 * lib/ops/pack-ops.ts getCompliancePack): the week is its Monday as
 * YYYY-MM-DD, anything else is no page. A week with no stored pack says so
 * and points at the list, where "Make this week's pack" is; a read that
 * failed says so, never an empty pack. Business data about the platform's
 * promises: counts, ids, dates and closed words, never a person.
 */

export const metadata: Metadata = { title: "Compliance pack" };
export const dynamic = "force-dynamic";

export default async function CompliancePackPage({ params }: { params: Promise<{ week: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { week } = await params;
  if (!isWeekStart(week)) notFound();
  const result = await fetchCompliancePack(week);
  if (isHostUnreachable(result)) return <HostStandbyPage title="Compliance pack" back={{ href: "/admin/compliance/pack", label: "← Compliance packs" }} />;
  if (!result.ok || result.data.status === "not_found") {
    return (
      <main className="mx-auto w-full max-w-[1000px] px-4 py-10 sm:px-8">
        <a href="/admin/compliance/pack" className="text-muted text-sm underline underline-offset-2">
          ← Compliance packs
        </a>
        <h1 className="font-display mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]">Compliance pack</h1>
        <p className="mt-1 text-sm font-semibold">
          Week of {weekWords({ start: week, lastDay: addDays(week, 6), timeZone: "America/New_York", from: `${week}T00:00:00.000Z`, to: `${addDays(week, 7)}T00:00:00.000Z` })}
        </p>
        {!result.ok ? (
          <Failure failure={result} what="the compliance pack" />
        ) : (
          <p className="mt-4 text-sm">No pack is stored for this week. The list of packs offers to make one for any of the last twelve weeks that has none.</p>
        )}
      </main>
    );
  }
  return <PackView record={result.data.pack} />;
}
