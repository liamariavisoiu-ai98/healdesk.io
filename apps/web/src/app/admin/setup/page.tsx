import { permanentRedirect } from "next/navigation";

/**
 * /admin/setup became Queues › setup requests in the admin redesign (23 October
 * 2026); runbooks and alert emails keep this address, so it redirects
 * forever, carrying a form's outcome into the section's own query key.
 */
export const dynamic = "force-dynamic";

export default async function OldPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const outcome = typeof result === "string" && /^[a-z_]{1,32}$/.test(result) ? `?setup=${result}` : "";
  permanentRedirect(`/admin/queues${outcome}#setup-requests`);
}
