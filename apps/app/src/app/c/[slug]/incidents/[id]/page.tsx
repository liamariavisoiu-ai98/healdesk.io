import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { phoneText } from "@/lib/portal/conversation-words";
import { portalDay } from "@/lib/portal/format";
import { affectedListWords, readAffectedList } from "@/lib/portal/incidents";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";

import { PatientPageGuard } from "../../PatientPageGuard";
import { PortalShell } from "../../PortalShell";

export const metadata: Metadata = { title: "Incident · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

const WHAT: Record<"breach" | "security_incident" | "improper_use_or_disclosure", string> = {
  breach: "A breach",
  security_incident: "A security incident",
  improper_use_or_disclosure: "A use your agreement doesn't permit",
};

/**
 * One incident's list of the people it affected (plan Annex X5, L29: "The
 * list of individuals is never emailed. It sits on a page behind step-up.";
 * wave 2 R11). Where the report's link lands. Each person by the contact's
 * id and the contact details healdesk holds, and nothing more: no
 * conversation, no booking, no words. Only once a report about the incident
 * has gone; an id this clinic does not hold, or one not reported, is "not
 * found". A patient page: requirePatientPage first, and the open writes one
 * access row naming every contact shown, in the transaction that reads them.
 */
export default async function IncidentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug, id } = await params;
  const { page: pageParam } = await searchParams;
  const page = await requirePatientPage(slug, { returnTo: `/c/${slug}/incidents/${id}` });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "home");
  const list = await readAffectedList(page, id, Number.parseInt(pageParam ?? "1", 10));
  if (!list) notFound();

  const zone = shell.timeZone;
  const person = shell.audience === "clients" ? "client" : "patient";
  const people = shell.audience === "clients" ? "clients" : "patients";
  const path = `/c/${page.portal.clinicSlug}/incidents/${list.incidentId}`;
  const sizes = affectedListWords(list, { person, people });

  return (
    <PortalShell {...shell}>
      <PatientPageGuard {...patientGuardProps(page)}>
        <h1 className="text-2xl font-semibold">Who an incident affected</h1>
        <p className="text-muted mt-3">
          {WHAT[list.class]}, discovered {portalDay(list.discoveredAt, zone, now)}, which we
          reported to you {portalDay(list.reportedAt, zone, now)}. This is the identification of
          each {person} it affected, as your agreement provides: it&rsquo;s never emailed. Each is
          named by the record healdesk holds and the contact details in it, for your own notices.
        </p>
        <p className="text-muted mt-2 text-sm">
          Opening this page is logged with the device that opened it. Don&rsquo;t copy the list
          anywhere less protected than your own {person} records.
        </p>

        {sizes.pending || (sizes.gone && list.total === 0) ? (
          <p className="border-line mt-6 rounded-md border bg-white px-4 py-3">
            {sizes.pending ?? sizes.gone}
          </p>
        ) : null}
        {list.total > 0 ? (
          <>
            <p className="mt-6 font-semibold">{sizes.heading}</p>
            {sizes.gone ? <p className="text-muted mt-2 text-sm">{sizes.gone}</p> : null}
            <div className="border-line mt-3 overflow-x-auto rounded-md border bg-white">
              <table className="w-full text-left text-sm">
                <thead className="text-muted border-line border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Phone</th>
                    <th className="px-4 py-2 font-semibold">Email</th>
                    <th className="px-4 py-2 font-semibold">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {list.people.map((p) => (
                    <tr key={p.contactId} className="border-line border-b last:border-b-0">
                      <td className="px-4 py-2">
                        {p.fullName ?? <span className="text-muted">None held</span>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {p.phone ? (
                          phoneText(p.phone)
                        ) : (
                          <span className="text-muted">None held</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {p.email ?? <span className="text-muted">None held</span>}
                      </td>
                      <td className="text-muted px-4 py-2 font-mono text-xs">{p.contactId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.pages > 1 ? (
              <nav className="mt-4 flex flex-wrap items-center gap-3 text-sm" aria-label="Pages">
                {list.page > 1 ? (
                  <a
                    href={`${path}?page=${list.page - 1}`}
                    className="inline-flex min-h-11 items-center font-semibold underline"
                  >
                    Previous
                  </a>
                ) : null}
                <span className="text-muted">
                  Page {list.page} of {list.pages}
                </span>
                {list.page < list.pages ? (
                  <a
                    href={`${path}?page=${list.page + 1}`}
                    className="inline-flex min-h-11 items-center font-semibold underline"
                  >
                    Next
                  </a>
                ) : null}
              </nav>
            ) : null}
          </>
        ) : null}

        <p className="text-muted mt-8 text-sm">
          Questions about it: reply to the report, or write to hello@healdesk.io.
        </p>
      </PatientPageGuard>
    </PortalShell>
  );
}
