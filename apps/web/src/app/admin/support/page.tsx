import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchSupportCases, fetchSupportReplyApprovals } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { CaseList } from "./CaseList";

/**
 * /admin/support, the Support console (ops automation Phase 7, lane P7d;
 * design E5 §2.5): every support case across clinics, from the portal chat's
 * escalations today and inbound email once that slice lands, in the order
 * the owner works them. Home's support rows and the support alerts open it;
 * each row opens its case at /admin/support/<case id>, where the facts, the
 * draft and every control are.
 *
 * Until 23 October 2026 this address listed the chat's escalations with a
 * "Mark replied" button; that list moved to Queues › Support in the admin
 * redesign and stays there, for the chat's dated promises (L25) and their
 * mark. This page is the cases.
 *
 * Two reads: the cases (listSupportCases, `all`: every open case and the
 * ones closed in the last 30 days, demo clinics' cases only when asked), and
 * the replies waiting in the approval inbox (fetchSupportReplyApprovals), so
 * a row can say its reply waits for the owner's Send. The host in standby
 * fails both the same way, so one notice stands in for the page; a read
 * that fails says so, never a zero.
 */

export const metadata: Metadata = { title: "Support" };
export const dynamic = "force-dynamic";

/** apps/app's cap on one list (lib/support/cases.ts SUPPORT_CASES_LIST_MAX). */
const LIST_MAX = 200;

export default async function SupportPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { demo } = await searchParams;
  const includeDemo = demo === "1";
  const [cases, waiting] = await Promise.all([
    fetchSupportCases({ state: "all", limit: LIST_MAX, includeDemo }),
    fetchSupportReplyApprovals({ status: "waiting" }),
  ]);
  const standby = isHostUnreachable(cases);

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">Support</h1>
      <p className="text-muted mt-2 max-w-[68ch] text-[15.6px]">
        Every support case across clinics: what a clinic asked through its portal chat, as fields from fixed lists, with the
        draft reply waiting for your Send. Open a case for its facts, its draft and the controls.
      </p>
      {standby ? (
        <HostStandbyNotice what="The support cases" />
      ) : (
        <>
          <p className="text-muted mt-2 text-sm">
            {includeDemo ? (
              <a href="/admin/support" className="underline">
                Hide demo clinics&apos; cases
              </a>
            ) : (
              <a href="/admin/support?demo=1" className="underline">
                Show demo clinics&apos; cases
              </a>
            )}
          </p>
          <CaseList cases={cases} waiting={waiting} />
        </>
      )}
    </main>
  );
}
