/**
 * `platform_compliance`'s vocabulary (plan Part J and K; Gates table, "A
 * channel goes live (Gate B)"): what an operator attests about the platform
 * before any clinic answers a patient on it, and which channel needs which.
 *
 * Two kinds of subject, both platform-wide (they are about healdesk, never
 * about one clinic):
 *
 *   - **vendors** whose business associate agreement the BAA chain needs
 *     (CLAUDE.md, "Coverage means every link in the spec's chain"): the
 *     model provider, the database host and AWS for every channel, and Retell
 *     for phone. Meta and Stripe sign none and are handled by scoping, so they
 *     are not subjects;
 *   - **Gate B readiness flags**: what Gate B asks of the platform that only
 *     a person can confirm. Each channel's runtime deployed on the host and
 *     tested on a synthetic clinic; phone's pass-through test ("calls reach
 *     your direct line when AYA is off"); and the owner's rule that no clinic
 *     goes live while a LAUNCH_PROMISES item that blocks go-live is open
 *     (CLAUDE.md, "Copy first, then the switch"), which apps/web, where the
 *     list lives, refuses to attest while one is.
 *
 * What Gate B asks that is code, not a person's word (the practice questions,
 * the answer gate, the routed/answered counter), is in lib/compliance/
 * platform.ts, and named there when it is not built.
 *
 * Pure data with no imports: db/schema.ts generates the table's CHECK from
 * PLATFORM_SUBJECTS, and drizzle-kit loads it outside the app. The SQL mirror
 * of CLINIC_WIDE_SUBJECTS and CHANNEL_SUBJECTS is
 * app_platform_subjects_for() (drizzle/0090), and tests/go-live.test.ts holds
 * the two together.
 */

export const PLATFORM_VENDORS = ["anthropic", "database_host", "aws", "retell"] as const;

export const GATE_B_FLAGS = [
  "launch_promises",
  "runtime_web",
  "runtime_meta",
  "runtime_voice",
  "voice_pass_through",
] as const;

export const PLATFORM_SUBJECTS = [...PLATFORM_VENDORS, ...GATE_B_FLAGS] as const;
export type PlatformSubject = (typeof PLATFORM_SUBJECTS)[number];

/** A row attests a subject, or withdraws an earlier attestation of it. */
export const PLATFORM_ACTIONS = ["attested", "withdrawn"] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

/** Every channel needs these attested before it can go live, and a clinic before it can. */
export const CLINIC_WIDE_SUBJECTS: readonly PlatformSubject[] = [
  "anthropic",
  "database_host",
  "aws",
  "launch_promises",
];

/** What each channel needs besides. Keyed by the catalog's channel ids. */
export const CHANNEL_SUBJECTS: Readonly<
  Record<"web" | "meta" | "voice", readonly PlatformSubject[]>
> = {
  web: ["runtime_web"],
  meta: ["runtime_meta"],
  voice: ["retell", "runtime_voice", "voice_pass_through"],
};

export function isPlatformSubject(value: unknown): value is PlatformSubject {
  return typeof value === "string" && (PLATFORM_SUBJECTS as readonly string[]).includes(value);
}

export function isVendorSubject(subject: PlatformSubject): boolean {
  return (PLATFORM_VENDORS as readonly string[]).includes(subject);
}

/** A document reference's longest form: where the document is kept, never a copy of it. */
export const DOCUMENT_REF_MAX = 300;
