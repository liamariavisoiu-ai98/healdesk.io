import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { fetchSiteReadFailures, requestSiteReread, type SiteReadFailureRow } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { RereadButton, type Reread } from "./RereadButton";

/**
 * Queues › Site reads: the purchases whose website could not be read at
 * checkout (plan Part B, Part K). Until the admin redesign (23 October 2026)
 * this was /admin/site-reads, which redirects here.
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

async function reread(clinicId: string): ReturnType<Reread> {
  "use server";
  const result = await requestSiteReread(clinicId);
  revalidatePath("/admin/queues");
  return result;
}

function utc(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "";
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
          href={`/admin/clinics/${row.clinicId}/setup`}
          className="mt-2 inline-block font-semibold underline underline-offset-2"
        >
          Setup →
        </a>
      ) : null}
      {row.clinicId && !row.profileSince && row.website ? (
        <RereadButton clinicId={row.clinicId} reread={reread} />
      ) : null}
    </div>
  );
}

export default async function SiteReadsSection() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const result = await fetchSiteReadFailures();
  const open = result.ok ? result.data.failures.length : null;

  return (
    <Section id="site-reads" title={`Site reads that failed${open === null ? "" : ` (${open})`}`}>
      {isHostUnreachable(result) ? (
        <HostStandbyNotice what="The site reads" />
      ) : !result.ok ? (
        <Failure failure={result} what="the site reads" />
      ) : result.data.failures.length === 0 ? (
        <p className="text-muted text-sm">None. Every website given at checkout was read.</p>
      ) : (
        <>
          <ul className="grid gap-3">
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
    </Section>
  );
}
