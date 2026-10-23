import { permanentRedirect } from "next/navigation";

/**
 * /admin/ops became /admin/clinics (the list) and /admin/system/jobs (the
 * switches) in the admin redesign (23 October 2026). The summary alerts
 * apps/app sends across clinics link here (lib/ops/notify.ts, opsConsoleLink),
 * and so do the runbooks, so it redirects forever to the clinic list.
 */
export const dynamic = "force-dynamic";

export default function OldOpsPage() {
  permanentRedirect("/admin/clinics");
}
