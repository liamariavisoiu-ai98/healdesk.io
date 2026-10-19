import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchSiteReadFailures,
  requestSiteReread,
  type SiteReadFailureRow,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { RereadButton, type Reread } from "./RereadButton";

/**
 * /admin/site-reads: the purchases whose website could not be read at
 * checkout (plan Part B, Part K).
 *
 * The read happens in the funnel, on this app (/api/clinic-site), and a
 * failure rides on the purchase as `profileStatus: "failed"` with no profile
 * (lib/checkout/order.ts). The purchase reaches apps/app with the first paid
 * invoice, so this list is read from there through the ops envelope
 * (listSiteReadFailures): each practice's name, its public website, when it
 * bought, and whether its wizard has a profile since. Those clinics' setup
 * asked three questions instead of reading the site, and an operator can
 * look at why. A practice's public website is business data; nothing here
 * is a patient.
 *
 * A read, with links out, and "Read it again" for a clinic still without a
 * profile: apps/app queues a signed re-read (ops requestSiteReread), which
 * its site-reads job sends back to /api/clinic-site here.
 */

export const metadata: Metadata = { title: "Site reads" };
export const dynamic = "force-dynamic";

async function reread(clinicId: string): ReturnType<Reread> {
  "use server";
  const result = await requestSiteReread(clinicId);
  revalidatePath("/admin/site-reads");
  return result;
}

function utc(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "";
}

export default async function SiteReadsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const result = await fetchSiteReadFailures();
  if (isHostUnreachable(result)) return <HostStandbyPage title="Site reads" />;

  return (
    <main className="mx-auto w-full max-w-[1000px] px-5 py-12 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">
        Site reads that failed
      </h1>
      <p className="text-muted mt-3 max-w-[62ch] text-[15.6px]">
        Purchases whose website we could not read at checkout, newest first. Their setup asked three
        questions instead. The site&rsquo;s own pages may block us, need a login, or be down; open
        it and see.
      </p>
      {!result.ok ? (
        <p className="text-red-deep mt-6 font-semibold">{result.message}</p>
      ) : result.data.failures.length === 0 ? (
        <p className="text-muted mt-6">None. Every website given at checkout was read.</p>
      ) : (
        <>
          <ul className="mt-6 grid gap-3">
            {result.data.failures.map((row) => (
              <li key={row.ref}>
                <FailureRow row={row} />
              </li>
            ))}
          </ul>
          {result.data.failures.length >= result.data.limit ? (
            <p className="text-muted mt-3 text-sm">
              The newest {result.data.limit} are shown; older ones are not listed here.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

function FailureRow({ row }: { row: SiteReadFailureRow }) {
  return (
    <div className="border-line rounded-md border bg-white p-5 text-sm">
      <p className="font-semibold">{row.clinicName}</p>
      <p className="mt-1">
        {row.website ? (
          <a href={row.website} rel="noopener noreferrer" target="_blank" className="underline">
            {row.website}
          </a>
        ) : (
          "No website on the purchase"
        )}
      </p>
      <p className="text-muted mt-1">
        Read failed at checkout, {utc(row.createdAt)}
        {row.provisionedAt ? ` · paid and set up ${utc(row.provisionedAt)}` : " · not set up"}
        {row.clinicId
          ? row.profileSince
            ? " · a profile has arrived since"
            : " · still no profile"
          : ""}
      </p>
      {row.clinicId ? (
        <a
          href={`/admin/ops/${row.clinicId}/onboarding`}
          className="mt-2 inline-block font-semibold underline underline-offset-2"
        >
          Onboarding →
        </a>
      ) : null}
      {row.clinicId && !row.profileSince && row.website ? (
        <RereadButton clinicId={row.clinicId} reread={reread} />
      ) : null}
    </div>
  );
}
