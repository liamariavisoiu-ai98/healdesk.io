import { permanentRedirect } from "next/navigation";

/**
 * /admin/inbox was the approval inbox's planned address (ops automation
 * design E6); it was built as Queues › Approvals (lane P6b), so this
 * redirects forever, the way every old admin address does (owner decision
 * D11): a runbook or a note that names it still lands on the section.
 */
export const dynamic = "force-dynamic";

export default function OldInboxPage() {
  permanentRedirect("/admin/queues#approvals");
}
