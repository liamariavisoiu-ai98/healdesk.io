import { notFound, redirect } from "next/navigation";

import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";

/** /admin/clinics/[id] is the panel: its first tab is Setup. */
export const dynamic = "force-dynamic";

export default async function ClinicPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  redirect(clinicTabPath(clinicId, "setup"));
}
