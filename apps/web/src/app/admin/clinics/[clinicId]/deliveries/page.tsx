import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import { fetchTranscriptDeliveries, resendTranscript as resendUpstream } from "@/lib/admin/ops-client";
import { transcriptWindow } from "@/lib/admin/transcript-status";
import { isHostUnreachable } from "@/lib/host/state";

import { TranscriptsPanel } from "./TranscriptsPanel";

/**
 * /admin/clinics/[id]/deliveries, the Deliveries tab: whether each
 * transcript reached the clinic, and "send again" for one that bounced or is
 * still waiting. Until the admin redesign (23 October 2026) this was
 * /admin/ops/[id]/transcripts, which redirects here forever; the merge of
 * the three delivery ledgers into this tab is the redesign's step 7.
 *
 * A transcript is emailed to the clinic when a conversation ends and the
 * sealed copy is deleted once SES reports it delivered; the row stays as a
 * receipt without the words (CLAUDE.md, "Email"). apps/app sends a
 * hand-written projection of those receipts: an opaque conversation id, a
 * status, two times and a count. No words, no address, no SES reason, and
 * nothing here can name where a resend goes: the engine always sends to the
 * clinic's own address.
 */

export const metadata: Metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

export default async function DeliveriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  const { days: rawDays } = await searchParams;
  const days = transcriptWindow(rawDays);

  const view = await fetchTranscriptDeliveries(clinicId, days);
  if (isHostUnreachable(view)) return <HostStandbyNotice what="Deliveries" />;
  const path = clinicTabPath(clinicId, "deliveries");

  async function resend(conversationId: string) {
    "use server";
    const result = await resendUpstream(clinicId, conversationId);
    revalidatePath(path);
    return result;
  }

  return <TranscriptsPanel clinicId={clinicId} days={days} view={view} resend={resend} />;
}
