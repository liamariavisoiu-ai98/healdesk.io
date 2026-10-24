import { notFound, permanentRedirect } from "next/navigation";

import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";

/**
 * /admin/ops/[id]/account became /admin/clinics/[id]/account in the admin redesign
 * (23 October 2026). Alert emails and Slack lines sent before then, and
 * runbooks, still carry this address, so it redirects forever (a 308) rather
 * than 404. Ids only: anything that is not a clinic id is not found.
 */
export const dynamic = "force-dynamic";

export default async function OldPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  permanentRedirect(clinicTabPath(clinicId, "account"));
}
