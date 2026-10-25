import type { Channel } from "@healdesk/catalog";

/**
 * The incident assistant's closed lists (ops automation Phase 6, lane P6i;
 * design E6 §3 item 17; docs/incident-response.md). Pure data, no imports
 * but a type, so db/schema.ts can build its CHECKs from them.
 *
 * ## Who can report an incident to us, and what of ours they carry
 *
 * docs/incident-response.md, "Notices from our vendors": a subcontractor's
 * notice is ours to pass on, and the mapping from its window to our clinics
 * is ours. The vendors are the ones the BAA chain needs
 * (lib/compliance/subjects.ts PLATFORM_VENDORS: anthropic, database_host,
 * aws, retell) and Meta, which signs none but is handled the same way when
 * an incident there is reported (the same section, point 4). Stripe is left
 * out on purpose: it sees an amount, a generic descriptor and an opaque
 * reference, never a conversation, so no conversation count can say which
 * clinic an incident there reached; an incident at Stripe is opened by hand
 * on the clinic's Care tab.
 *
 * Which channels each vendor carries, from the code: Retell runs the voice
 * agent only (lib/voice); Anthropic writes every reply on every channel (one
 * brain, four adapters); the database host and AWS hold everything the
 * service stores and send the transcript emails (SES), so every channel; Meta
 * carries the Instagram, Messenger and WhatsApp conversations only.
 *
 * The channels are the catalog's (packages/catalog CHANNELS: voice, web,
 * meta), counted from what the service keeps of a conversation, never its
 * words (./scope.ts says where each count comes from).
 */

export const SCOPE_VENDORS = ["retell", "anthropic", "database_host", "aws", "meta"] as const;
export type ScopeVendor = (typeof SCOPE_VENDORS)[number];

export const SCOPE_CHANNELS = ["voice", "web", "meta"] as const satisfies readonly Channel[];
export type ScopeChannel = (typeof SCOPE_CHANNELS)[number];

export const VENDOR_CHANNELS: Readonly<Record<ScopeVendor, readonly ScopeChannel[]>> = {
  retell: ["voice"],
  anthropic: ["voice", "web", "meta"],
  database_host: ["voice", "web", "meta"],
  aws: ["voice", "web", "meta"],
  meta: ["meta"],
};

/** What a scope is read by: a vendor's notice, or one of our own channels. */
export const SCOPE_SOURCES = ["vendor", "channel"] as const;
export type ScopeSource = (typeof SCOPE_SOURCES)[number];

/** The classes an incident batch may open: the three an agreement's reporting clause covers. */
export const BATCH_CLASSES = ["breach", "security_incident", "improper_use_or_disclosure"] as const;
export type BatchClass = (typeof BATCH_CLASSES)[number];

/**
 * The procedure's steps (docs/incident-response.md, "The procedure"), each
 * ticked once per incident on its checklist, never typed: contain, open the
 * incident, preserve the ids, investigate, notify the clinic by email and,
 * separately, by phone (the template says "confirmed by phone"), record the
 * list of who it affected (the tick keeps how many, read from the incident,
 * never who), help the clinic notify, resolve.
 */
export const CHECKLIST_STEPS = [
  "contain",
  "open",
  "preserve_ids",
  "investigate",
  "notify_email",
  "notify_phone",
  "affected_list_recorded",
  "help_clinic",
  "resolve",
] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

/** The widest window a scope may read: a vendor's notice names days, not years. */
export const MAX_SCOPE_WINDOW_DAYS = 400;

export function isScopeVendor(value: unknown): value is ScopeVendor {
  return typeof value === "string" && (SCOPE_VENDORS as readonly string[]).includes(value);
}

export function isScopeChannel(value: unknown): value is ScopeChannel {
  return typeof value === "string" && (SCOPE_CHANNELS as readonly string[]).includes(value);
}

export function isBatchClass(value: unknown): value is BatchClass {
  return typeof value === "string" && (BATCH_CLASSES as readonly string[]).includes(value);
}

export function isChecklistStep(value: unknown): value is ChecklistStep {
  return typeof value === "string" && (CHECKLIST_STEPS as readonly string[]).includes(value);
}

/** The channels a scope covers: a vendor's, or the one channel asked for. */
export function channelsOf(source: ScopeSource, value: ScopeVendor | ScopeChannel): readonly ScopeChannel[] {
  return source === "vendor" ? VENDOR_CHANNELS[value as ScopeVendor] : [value as ScopeChannel];
}
