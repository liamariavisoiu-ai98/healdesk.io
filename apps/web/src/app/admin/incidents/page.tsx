import { permanentRedirect } from "next/navigation";

/** /admin/incidents became Compliance › Incidents in the admin redesign (23 October 2026); it redirects forever. */
export const dynamic = "force-dynamic";

export default function OldIncidentsPage() {
  permanentRedirect("/admin/compliance/incidents");
}
