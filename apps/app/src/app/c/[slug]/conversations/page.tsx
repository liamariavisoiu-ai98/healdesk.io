import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  LIST_LIMIT,
  readConversationsScreen,
  type ExportStanding,
} from "@/lib/portal/conversations";
import { portalDay } from "@/lib/portal/format";
import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";

import { FeedbackProvider } from "../feedback";
import { PatientPageGuard } from "../PatientPageGuard";
import { PortalShell } from "../PortalShell";

import { ConversationsView, ExportAll } from "./ConversationsView";

export const metadata: Metadata = { title: "Conversations · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Conversations (plan Part F4; spec, "Portal map"): every call, website chat
 * and Meta message thread, newest first, with its outcome and any booking
 * request it produced; a search by name or phone digits and the day chips;
 * and the export. A patient page: requirePatientPage first, so nothing is
 * read without this session's passkey step-up, and the list's access row is
 * written in the transaction that reads it (lib/portal/conversations.ts).
 * PatientPageGuard takes the rows off the screen when the step-up lapses.
 *
 * The words are not kept, so there are none to show or search: each call's
 * and web chat's transcript is emailed to the clinic when it ends.
 */
export default async function ConversationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await requirePatientPage(slug, { returnTo: `/c/${slug}/conversations` });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "conversations");
  const { rows, standing } = await readConversationsScreen(page, { timeZone: shell.timeZone, now });
  const address = portalPage.state.address;

  return (
    <PortalShell {...shell}>
      <FeedbackProvider>
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <p className="text-muted mt-2">
          Every call, website chat and message AYA answered, with what came of it. The words
          aren&rsquo;t kept: each call&rsquo;s and website chat&rsquo;s transcript is emailed to{" "}
          {address ?? "your clinic's address"} when it ends. Open one to see whether it arrived, or
          to send it again. Instagram, Messenger and WhatsApp keep only when each person last wrote.
        </p>
        <PatientPageGuard {...patientGuardProps(page)}>
          <ConversationsView
            slug={page.portal.clinicSlug}
            timeZone={shell.timeZone}
            initialRows={rows}
            bookingsHref={
              isBuiltSection("bookings") ? sectionPath(page.portal.clinicSlug, "bookings") : null
            }
            limit={LIST_LIMIT}
          />
          <section id="export" aria-labelledby="export-heading" className="mt-10 scroll-mt-6">
            <h2 id="export-heading" className="text-lg font-semibold">
              Export
            </h2>
            <ExportAll
              slug={page.portal.clinicSlug}
              destroyed={standing.destroyed}
              closedNote={closedNote(standing, shell.timeZone, now)}
            />
          </section>
        </PatientPageGuard>
      </FeedbackProvider>
    </PortalShell>
  );
}

/**
 * After cancellation, what a download sets in motion: one that arrives in
 * full records the export as delivered, and the agreement then says when
 * the records go.
 */
function closedNote(standing: ExportStanding, timeZone: string, now: Date): string | null {
  if (!standing.closed || standing.destroyed || !standing.deletedFromIfDownloaded) return null;
  const at = standing.deletedFromIfDownloaded;
  const when =
    at.getTime() <= now.getTime() + 60 * 60 * 1000
      ? "within the hour"
      : `on ${portalDay(at, timeZone, now)}`;
  return standing.deliveredAt
    ? `Your account has closed and your export was recorded as delivered on ${portalDay(
        standing.deliveredAt,
        timeZone,
        now,
      )}, so your records are deleted ${when}.`
    : `Your account has closed. A download that arrives in full records your export as delivered, and your records are then deleted ${when}, as your agreement says.`;
}
