import { permanentRedirect } from "next/navigation";

/** /admin/notices became Compliance › Notices in the admin redesign (23 October 2026); it redirects forever. */
export const dynamic = "force-dynamic";

export default function OldNoticesPage() {
  permanentRedirect("/admin/compliance/notices");
}
