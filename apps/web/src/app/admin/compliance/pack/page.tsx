import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchCompliancePacks, generateCompliancePack } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { PackList } from "./PackList";
import { isWeekStart, recentWeeks } from "./pack-week";

/**
 * /admin/compliance/pack, the compliance packs (ops automation lane P6j; the
 * pack is lane P6h's): the last twelve weeks ending at the one now due, each
 * stored (a link to its printable page, /admin/compliance/pack/<week>) or
 * not, with "Make this week's pack" beside a week that has none, and any
 * older stored pack after them. Under Compliance in the nav: the pack is the
 * week's answer to whether the agreements' promises were kept.
 */

export const metadata: Metadata = { title: "Compliance packs" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance/pack";
const RECENT_WEEKS = 12;
/** A year of stored packs, read in one call (apps/app lists 104 at most). */
const LIST_LIMIT = 52;

export default async function CompliancePacksPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const packs = await fetchCompliancePacks(LIST_LIMIT);
  const standby = isHostUnreachable(packs);
  const weeks = recentWeeks(new Date(), RECENT_WEEKS);

  // Make one week's pack: the week is one of the Mondays this page drew.
  async function make(week: string) {
    "use server";
    if (!isWeekStart(week)) return { ok: true as const, data: { status: "refused" as const, message: "The week is its Monday, as YYYY-MM-DD." } };
    const result = await generateCompliancePack(week);
    revalidatePath(PATH);
    return result;
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <a href="/admin/compliance" className="text-muted text-sm underline underline-offset-2">
        ← Compliance
      </a>
      <h1 className="font-display mt-2 text-[28px] leading-tight font-semibold tracking-[-0.02em]">Compliance packs</h1>
      <p className="text-muted mt-2 max-w-[68ch] text-[15.6px]">
        One week&rsquo;s answer to whether we kept the agreements&rsquo; promises: incidents, re-signs, patient-rights requests, vendor
        agreements, transcript copies, access events and the approval inbox, read from the host&rsquo;s records and stored once.
      </p>
      {standby ? <HostStandbyNotice what="The compliance packs" /> : <PackList weeks={weeks} packs={packs} onMake={make} />}
    </main>
  );
}
