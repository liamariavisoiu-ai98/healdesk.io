import { permanentRedirect } from "next/navigation";

/**
 * /admin/agreements became Compliance › Agreements in the admin redesign
 * (23 October 2026); counsel's bookmarks and runbooks keep this address, so
 * it redirects forever, with the register's filters carried along.
 */
export const dynamic = "force-dynamic";

const FILTERS = ["q", "from", "to", "version", "status", "copy"] as const;

export default async function OldAgreementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const kept = new URLSearchParams();
  for (const key of FILTERS) {
    const value = params[key];
    const one = Array.isArray(value) ? value[0] : value;
    if (typeof one === "string" && one.length > 0 && one.length <= 200) kept.set(key, one);
  }
  const query = kept.toString();
  permanentRedirect(`/admin/compliance/agreements${query ? `?${query}` : ""}`);
}
