import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { missedPath } from "@/lib/channels/answer-notices";
import { readMissedContacts } from "@/lib/portal/missed-contacts";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";

import { PatientPageGuard } from "../PatientPageGuard";
import { PortalShell } from "../PortalShell";
import { MissedRow } from "./MissedRow";

export const metadata: Metadata = { title: "Missed calls and chats · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * The calls and chats AYA could not answer in the last 30 days
 * (missed_contacts; lib/portal/missed-contacts.ts), so the clinic can follow
 * up: when, which channel, where it went, the caller's number when it was
 * known, and "Called back". Reached from Home's "Needs your attention" card
 * and from the emails about AYA missing calls (L18, L21). A patient page:
 * requirePatientPage first, and the open writes its access row naming the
 * passkey. Nothing anyone said is here: healdesk keeps none of it.
 */
export default async function MissedContactsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await requirePatientPage(slug, { returnTo: missedPath(slug) });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "home");
  const contacts = await readMissedContacts(page, now);
  const clinicSlug = page.portal.clinicSlug;

  return (
    <PortalShell {...shell}>
      <p>
        <a href={`/c/${clinicSlug}`} className="inline-flex min-h-11 items-center text-sm font-semibold underline">
          Home
        </a>
      </p>
      <PatientPageGuard {...patientGuardProps(page)}>
        <h1 className="text-2xl font-semibold">Missed calls and chats</h1>
        <p className="text-muted mt-2">
          Calls and chats AYA couldn&rsquo;t answer in the last 30 days. Tick each one once you&rsquo;ve called them
          back. healdesk deletes each one 30 days after it came in.
        </p>
        {contacts.length === 0 ? (
          <p className="mt-6">Nothing missed in the last 30 days.</p>
        ) : (
          <ul className="mt-6 grid gap-3">
            {contacts.map((c) => (
              <MissedRow key={c.id} contact={c} slug={clinicSlug} timeZone={shell.timeZone} now={now} />
            ))}
          </ul>
        )}
      </PatientPageGuard>
    </PortalShell>
  );
}
