import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchTranscriptDeliveries, resendTranscript as resendUpstream } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { transcriptWindow } from "@/lib/admin/transcript-status";

import { TranscriptsPanel } from "./TranscriptsPanel";

/**
 * /admin/ops/[clinicId]/transcripts — whether each transcript reached the
 * clinic, and "send again" for one that bounced or is still waiting.
 *
 * A transcript is emailed to the clinic when a conversation ends and the
 * sealed copy is deleted once SES reports it delivered; the row stays as a
 * receipt without the words (CLAUDE.md, "Email"). apps/app sends a
 * hand-written projection of those receipts: an opaque conversation id, a
 * status, two times and a count. No words, no address, no SES reason, and
 * nothing here can name where a resend goes: the engine always sends to the
 * clinic's own address.
 */

export const metadata: Metadata = { title: "Transcripts" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TranscriptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) notFound();
  const { days: rawDays } = await searchParams;
  const days = transcriptWindow(rawDays);

  const view = await fetchTranscriptDeliveries(clinicId, days);
  if (isHostUnreachable(view)) {
    return <HostStandbyPage title="Transcripts" back={{ href: "/admin/ops", label: "Back to ops" }} />;
  }
  const path = `/admin/ops/${clinicId}/transcripts`;

  async function resend(conversationId: string) {
    "use server";
    const result = await resendUpstream(clinicId, conversationId);
    revalidatePath(path);
    return result;
  }

  return <TranscriptsPanel clinicId={clinicId} days={days} view={view} resend={resend} />;
}
