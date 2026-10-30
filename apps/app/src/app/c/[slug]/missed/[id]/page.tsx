import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { missedPath } from "@/lib/channels/answer-notices";
import { readMissedContact } from "@/lib/portal/missed-contacts";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";

import { PatientPageGuard } from "../../PatientPageGuard";
import { PortalShell } from "../../PortalShell";
import { MissedRow } from "../MissedRow";

export const metadata: Metadata = { title: "A missed call or chat · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * One missed contact, the page L21's "See the call" opens: as the list shows
 * it, with "Called back". A patient page: requirePatientPage first, and the
 * open writes its access row. An id this clinic does not hold, or one
 * deleted at its 30 days, is "not found".
 */
export default async function MissedContactPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const page = await requirePatientPage(slug, { returnTo: missedPath(slug, id) });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "home");
  const contact = await readMissedContact(page, id);
  if (!contact) notFound();
  const clinicSlug = page.portal.clinicSlug;

  return (
    <PortalShell {...shell}>
      <p>
        <a href={missedPath(clinicSlug)} className="inline-flex min-h-11 items-center text-sm font-semibold underline">
          All missed calls and chats
        </a>
      </p>
      <PatientPageGuard {...patientGuardProps(page)}>
        <h1 className="text-2xl font-semibold">A call or chat AYA couldn&rsquo;t answer</h1>
        <ul className="mt-6 grid gap-3">
          <MissedRow contact={contact} slug={clinicSlug} timeZone={shell.timeZone} now={now} single />
        </ul>
      </PatientPageGuard>
    </PortalShell>
  );
}
