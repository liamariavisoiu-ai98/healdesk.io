import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import { fetchClinicBilling, fetchClinicCare, fetchLifecycleWaves, fetchTranscriptDeliveries, resendTranscript as resendUpstream } from "@/lib/admin/ops-client";
import { transcriptWindow } from "@/lib/admin/transcript-status";
import { isHostUnreachable } from "@/lib/host/state";

import { DeliveriesLedger, DeliveryFilters, deliveryKind, shows } from "./DeliveriesLedger";
import { Reminders } from "./Reminders";
import { TranscriptsPanel } from "./TranscriptsPanel";

/**
 * /admin/clinics/[id]/deliveries, the Deliveries tab: everything emailed to
 * this clinic and whether it arrived, in one ledger with a kind filter
 * (E1 step 7): the transcript receipts with "Send again", the reports and
 * alerts sent to its staff, the billing engine's emails, the lifecycle
 * watch's reminders (the clinic's six and every wave to ops), and the
 * billing status history folded in as a kind. Until the
 * admin redesign (23 October 2026) these were three ledgers on three pages,
 * and /admin/ops/[id]/transcripts, which redirects here forever.
 *
 * Three reads, settled independently: one that fails costs its ledger,
 * which says so, never the tab. Receipts without words throughout: a
 * transcript is emailed when a conversation ends and the sealed copy is
 * deleted once SES reports it delivered; the row stays as a receipt
 * (CLAUDE.md, "Email"). apps/app sends hand-written projections: an opaque
 * conversation id, a status, two times and a count. No words, no address,
 * no SES reason, and nothing here can name where a resend goes: the engine
 * always sends to the clinic's own address.
 */

export const metadata: Metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

export default async function DeliveriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ days?: string | string[]; kind?: string | string[] }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  const { days: rawDays, kind: rawKind } = await searchParams;
  const days = transcriptWindow(rawDays);
  const kind = deliveryKind(rawKind);

  const [transcripts, care, billing, waves] = await Promise.all([
    fetchTranscriptDeliveries(clinicId, days),
    fetchClinicCare(clinicId),
    fetchClinicBilling(clinicId),
    fetchLifecycleWaves(clinicId),
  ]);
  if ([transcripts, care, billing, waves].every(isHostUnreachable)) return <HostStandbyNotice what="Deliveries" />;
  const path = clinicTabPath(clinicId, "deliveries");

  async function resend(conversationId: string) {
    "use server";
    const result = await resendUpstream(clinicId, conversationId);
    revalidatePath(path);
    return result;
  }

  return (
    <div>
      <DeliveryFilters clinicId={clinicId} current={kind} days={days} />
      {shows(kind, "transcripts") ? <TranscriptsPanel clinicId={clinicId} days={days} view={transcripts} resend={resend} /> : null}
      <DeliveriesLedger filter={kind} care={care} billing={billing} />
      {shows(kind, "reminders") ? <Reminders waves={waves} /> : null}
    </div>
  );
}
