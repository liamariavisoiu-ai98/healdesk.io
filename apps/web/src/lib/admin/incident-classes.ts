/**
 * The incident classes, on their own so a client component can import them.
 *
 * `lib/admin/ops-client.ts` is server-only: it holds HEALDESK_PROVISION_SECRET
 * and imports next/headers, and its module scope throws in a browser. A value
 * import from it inside a "use client" file pulls the whole server module —
 * and, through the rate limiter, node built-ins — into the browser bundle,
 * which is exactly how `next build` failed on every push from 13 September
 * 2026 onwards (Turbopack: "You're importing a module that depends on
 * next/headers", "Can't resolve 'dns'"). Client code imports the constant from
 * here and only *types* from ops-client; lib/admin/client-imports.test.ts
 * keeps it that way.
 */
export type IncidentClass = "security_incident" | "improper_use_or_disclosure" | "breach" | "service_complaint";

export const INCIDENT_CLASSES: readonly IncidentClass[] = [
  "security_incident",
  "improper_use_or_disclosure",
  "breach",
  "service_complaint",
];
