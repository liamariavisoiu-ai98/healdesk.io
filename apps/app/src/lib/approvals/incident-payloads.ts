import { parseReportFields, type ReportFields } from "@/lib/incidents/assistant/report-draft";
import {
  HOLDING_VENDORS,
  isBatchClass,
  isScopeChannel,
  isScopeReach,
  isScopeVendor,
  SCOPE_SOURCES,
  type ScopeReach,
  type BatchClass,
  type ScopeChannel,
  type ScopeSource,
  type ScopeVendor,
} from "@/lib/incidents/assistant/vocab";

/**
 * The two incident kinds' payloads (lane P6i), read back by name like the
 * billing kinds' (./kinds.ts parsePayload, which calls these): ids, closed
 * codes, times and small counts only, every key named, anything extra makes
 * the payload unreadable. Kept apart from ./kinds.ts so the incident lists
 * it needs do not load into every reader of the inbox's kinds.
 */

/** One item that opens an incident at each listed clinic, under the scope it was read from. */
export type IncidentBatchPayload = {
  source: ScopeSource;
  value: ScopeVendor | ScopeChannel;
  /** The scope's window, ISO instants. */
  from: string;
  to: string;
  incidentClass: BatchClass;
  discoveredAt: string;
  reach: ScopeReach;
  /** The clinics the scope found when it was proposed: what the owner approves, and all the executor opens. */
  clinicIds: string[];
  /** Each clinic's conversations in the window when it was proposed, in clinicIds' order: the packet shows these, never recounts. */
  counts: number[];
};

/** One incident's report (or update), pre-filled from fixed lists only. */
export type IncidentReportPayload = {
  incidentId: string;
  /** The report's number: 1, then each update. */
  report: number;
  fields: ReportFields;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/**
 * The most clinics one batch opens: more is a scope to split, not to approve
 * in one yes. Each opened incident's report is then its own item, approved
 * with its own fresh code, so 100 is already 100 decisions to follow.
 */
export const MAX_BATCH_CLINICS = 100;

function object(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function parseIncidentBatchPayload(raw: unknown): IncidentBatchPayload | null {
  const p = object(raw);
  if (!p) return null;
  if (Object.keys(p).sort().join(",") !== "clinicIds,counts,discoveredAt,from,incidentClass,reach,source,to,value") return null;
  if (!(SCOPE_SOURCES as readonly unknown[]).includes(p.source)) return null;
  if (p.source === "vendor" ? !isScopeVendor(p.value) : !isScopeChannel(p.value)) return null;
  if (!isScopeReach(p.reach)) return null;
  if (p.reach === "all_holding" && !(p.source === "vendor" && HOLDING_VENDORS.has(p.value as ScopeVendor))) return null;
  for (const key of ["from", "to", "discoveredAt"] as const) {
    if (typeof p[key] !== "string" || !ISO_INSTANT.test(p[key] as string)) return null;
  }
  if ((p.from as string) >= (p.to as string)) return null;
  if (!isBatchClass(p.incidentClass)) return null;
  const ids = p.clinicIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_CLINICS) return null;
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  const counts = p.counts;
  if (!Array.isArray(counts) || counts.length !== ids.length) return null;
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 1_000_000)) return null;
  return p as unknown as IncidentBatchPayload;
}

export function parseIncidentReportPayload(raw: unknown): IncidentReportPayload | null {
  const p = object(raw);
  if (!p) return null;
  if (Object.keys(p).sort().join(",") !== "fields,incidentId,report") return null;
  if (typeof p.incidentId !== "string" || !UUID.test(p.incidentId)) return null;
  if (typeof p.report !== "number" || !Number.isInteger(p.report) || p.report < 1 || p.report > 1000) return null;
  const fields = parseReportFields(p.fields);
  if (!fields) return null;
  return { incidentId: p.incidentId, report: p.report, fields };
}
