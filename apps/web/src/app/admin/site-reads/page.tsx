import { permanentRedirect } from "next/navigation";

/** /admin/site-reads became Queues › Site reads in the admin redesign (23 October 2026); it redirects forever. */
export const dynamic = "force-dynamic";

export default function OldSiteReadsPage() {
  permanentRedirect("/admin/queues#site-reads");
}
