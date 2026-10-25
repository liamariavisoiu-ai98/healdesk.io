import { createHash } from "node:crypto";

import {
  INCIDENT_REPORT_MAX_COUNT,
  isIncidentInformationType,
  isIncidentMitigation,
  isIncidentPatientStep,
  isIncidentRecommendation,
  isIncidentReportEvent,
  type IncidentInformationType,
  type IncidentMitigation,
  type IncidentPatientStep,
  type IncidentRecommendation,
  type IncidentReportEvent,
} from "@healdesk/catalog";

import type { BatchClass, ScopeSource } from "./vocab";

/**
 * The L29 report the assistant drafts (design E6 §3 item 17): the same
 * fixed fields the Incidents page's Send report takes
 * (lib/notices/operator-notices.ts readIncidentReportFields), pre-filled
 * from what the incident already says, and edited only by choosing from the
 * catalog's lists (packages/catalog operator-notices.ts). There is no field
 * a person can type into, and no deadline anywhere in it: the report states
 * none (the template's rule), and healdesk's 24-hour target is internal and
 * never quoted to a clinic (owner, 12 October 2026).
 *
 * The pre-fill guesses nothing it cannot read:
 *   - what happened: "A subcontractor reported an incident" when the
 *     incident was opened from a vendor's scope, "used or disclosed for a
 *     purpose the agreement doesn't permit" for that class; otherwise left
 *     empty, and the report cannot go until the owner picks one;
 *   - when it happened: the first day of the vendor's window, when it is
 *     not after the discovery; otherwise empty ("not yet established");
 *   - the information involved: empty, because the count of each kind is a
 *     finding of the investigation, never a guess;
 *   - what we did: "We're still investigating", which is true of every
 *     report until the owner changes it;
 *   - what we recommend: keeping the report, and for a breach, deciding
 *     whether the law requires notifying the people affected;
 *   - no steps for the people affected, and no law enforcement delay.
 */

export type ReportFields = {
  event: IncidentReportEvent | null;
  occurredOn: string | null;
  info: { type: IncidentInformationType; count: number }[];
  mitigations: IncidentMitigation[];
  steps: IncidentPatientStep[];
  recommendations: IncidentRecommendation[];
  delayedByLawEnforcement: boolean;
  delayEndedOn: string | null;
};

export const REPORT_FIELD_KEYS = [
  "delayEndedOn",
  "delayedByLawEnforcement",
  "event",
  "info",
  "mitigations",
  "occurredOn",
  "recommendations",
  "steps",
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20;

export type PrefillSource = {
  incidentClass: BatchClass;
  discoveredOn: string;
  /** The scope the incident was opened from by an approved batch, if it was. */
  batch: { source: ScopeSource; fromDay: string } | null;
};

export function prefillReport(source: PrefillSource): ReportFields {
  const event: IncidentReportEvent | null =
    source.batch?.source === "vendor"
      ? "subcontractor_incident"
      : source.incidentClass === "improper_use_or_disclosure"
        ? "impermissible_use"
        : null;
  const occurredOn = source.batch && source.batch.fromDay <= source.discoveredOn ? source.batch.fromDay : null;
  return {
    event,
    occurredOn,
    info: [],
    mitigations: ["investigating"],
    steps: [],
    recommendations: source.incidentClass === "breach" ? ["assess_notice_duty", "keep_record"] : ["keep_record"],
    delayedByLawEnforcement: false,
    delayEndedOn: null,
  };
}

function codes<T extends string>(raw: unknown, is: (v: unknown) => v is T): T[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return null;
  if (!raw.every(is)) return null;
  const unique = [...new Set(raw as T[])];
  return unique.length === raw.length ? unique : null;
}

function day(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || !DAY.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : undefined;
}

/**
 * The fields exactly as the lists allow them, or null: every key named and
 * no other, every code one the catalog lists, each once, every count a whole
 * number from 1, every date a real day. A string where a code goes, a key
 * the report does not have, or a sentence anywhere makes it null. Whether
 * the choices fit the incident (a breach-only recommendation, the delay's
 * day) is the sender's own check, run again before anything is approved.
 */
export function parseReportFields(raw: unknown): ReportFields | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (Object.keys(f).sort().join(",") !== REPORT_FIELD_KEYS.join(",")) return null;
  if (f.event !== null && !isIncidentReportEvent(f.event)) return null;
  const occurredOn = day(f.occurredOn);
  if (occurredOn === undefined) return null;
  if (!Array.isArray(f.info) || f.info.length > MAX_ROWS) return null;
  const info: ReportFields["info"] = [];
  for (const entry of f.info) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "count,type") return null;
    if (!isIncidentInformationType(e.type)) return null;
    if (typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 1 || e.count > INCIDENT_REPORT_MAX_COUNT) {
      return null;
    }
    if (info.some((r) => r.type === e.type)) return null;
    info.push({ type: e.type, count: e.count });
  }
  const mitigations = codes(f.mitigations, isIncidentMitigation);
  const steps = codes(f.steps, isIncidentPatientStep);
  const recommendations = codes(f.recommendations, isIncidentRecommendation);
  if (!mitigations || !steps || !recommendations) return null;
  if (typeof f.delayedByLawEnforcement !== "boolean") return null;
  const delayEndedOn = day(f.delayEndedOn);
  if (delayEndedOn === undefined) return null;
  return {
    event: f.event as IncidentReportEvent | null,
    occurredOn,
    info,
    mitigations,
    steps,
    recommendations,
    delayedByLawEnforcement: f.delayedByLawEnforcement,
    delayEndedOn,
  };
}

/** The fields in one fixed order, so the same choices always hash the same. */
export function canonicalFields(fields: ReportFields): string {
  return JSON.stringify({
    event: fields.event,
    occurredOn: fields.occurredOn,
    info: fields.info.map((r) => ({ type: r.type, count: r.count })),
    mitigations: fields.mitigations,
    steps: fields.steps,
    recommendations: fields.recommendations,
    delayedByLawEnforcement: fields.delayedByLawEnforcement,
    delayEndedOn: fields.delayEndedOn,
  });
}

export function fieldsHash(fields: ReportFields): string {
  return createHash("sha256").update(canonicalFields(fields), "utf8").digest("hex");
}

/** The fields as the sender's input takes them (lib/notices/operator-notices.ts IncidentReportInput). */
export function senderInput(fields: ReportFields): Record<string, unknown> {
  return {
    event: fields.event,
    occurredOn: fields.occurredOn,
    info: fields.info.map((r) => ({ type: r.type, count: r.count })),
    mitigations: [...fields.mitigations],
    steps: [...fields.steps],
    recommendations: [...fields.recommendations],
    ...(fields.delayedByLawEnforcement ? { delayedByLawEnforcement: true } : {}),
    ...(fields.delayEndedOn ? { delayEndedOn: fields.delayEndedOn } : {}),
  };
}
