import { notFound, permanentRedirect } from "next/navigation";

import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { TRANSCRIPT_WINDOWS } from "@/lib/admin/transcript-status";

/**
 * /admin/ops/[id]/transcripts became the Deliveries tab,
 * /admin/clinics/[id]/deliveries, in the admin redesign (23 October 2026).
 * Alert emails sent before then still carry this address, so it redirects
 * forever (a 308), keeping a `?days=` that names one of the offered windows.
 */
export const dynamic = "force-dynamic";

export default async function OldTranscriptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  const { days } = await searchParams;
  const asked = Number(Array.isArray(days) ? days[0] : days);
  const window = TRANSCRIPT_WINDOWS.find((w) => w === asked);
  permanentRedirect(`${clinicTabPath(clinicId, "deliveries")}${window ? `?days=${window}` : ""}`);
}
