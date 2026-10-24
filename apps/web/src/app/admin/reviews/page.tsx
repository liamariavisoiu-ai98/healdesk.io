import { permanentRedirect } from "next/navigation";

/** /admin/reviews became Queues › Reviews in the admin redesign (23 October 2026); runbooks and alert emails keep this address, so it redirects forever. */
export const dynamic = "force-dynamic";

export default function OldReviewsPage() {
  permanentRedirect("/admin/queues#reviews");
}
