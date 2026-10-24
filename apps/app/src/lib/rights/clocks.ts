import { BACKUP_RETENTION_DAYS } from "@healdesk/catalog";

import {
  RIGHTS_KINDS,
  RIGHTS_STATUSES,
  RIGHTS_VERIFICATIONS,
  type RightsKind,
  type RightsStatus,
  type RightsVerification,
} from "@/db/schema";
import { addBusinessDays } from "@/lib/incidents/reporting-rules";

export {
  RIGHTS_KINDS,
  RIGHTS_STATUSES,
  RIGHTS_VERIFICATIONS,
  type RightsKind,
  type RightsStatus,
  type RightsVerification,
};

/**
 * The patient-rights clocks, written once (ops automation lane P6c; design
 * E6 item 16). Each kind's days are business days after the day the request
 * reached us, counted as `addBusinessDays` counts them: Monday to Friday in
 * UTC, with no public holidays (lib/incidents/reporting-rules.ts; the erasure
 * and incident clocks count the same way, and docs/handover.md, "Deletion
 * requests", step 5, says "Monday to Friday, counted in UTC").
 *
 *   - erasure, 10: BAA 1.3.0 and later, clause 4(c), and the DPA's item c
 *     (docs/handover.md, "Deletion requests": "within ten business days");
 *     ERASURE_DEADLINE_BUSINESS_DAYS in lib/patient-rights/erasure.ts is the
 *     same number, for the deletion and every subcontractor step;
 *   - amendment and correction, 10: BAA 1.5.1's patient-rights clause
 *     (clause 14), item b, "within ten business days of being asked"
 *     (handover, "Amendments", step 4). A correction is a contact's details
 *     corrected in our own copy, which item b names beside the amendment;
 *   - export, 10: the same clause, item a (access): healdesk makes the
 *     information available "within ten business days of being asked". The
 *     handover states no clock for an export; the agreement does, so the
 *     tracker uses it;
 *   - patient_request, 5: the same clause's last paragraph, "pass the
 *     request to Practice within five business days" (PASS_ON_BUSINESS_DAYS
 *     in lib/patient-rights/patient-requests.ts, which counts its reply-by
 *     day from the clinic-local day instead; the tracker shows that stored
 *     day for a request recorded on the host).
 *
 * An erasure also has a fact that is not a deadline: a backup taken before
 * the deletion holds the person for BACKUP_RETENTION_DAYS (35) calendar days
 * after it, and the reply to the practice says so (handover, step 6).
 */
export const RIGHTS_CLOCKS: Readonly<Record<RightsKind, { businessDays: number; source: string }>> = {
  erasure: { businessDays: 10, source: "BAA clause 4(c); handover, Deletion requests, step 5" },
  amendment: { businessDays: 10, source: "BAA 1.5.1 clause 14(b); handover, Amendments, step 4" },
  correction: { businessDays: 10, source: "BAA 1.5.1 clause 14(b): a contact's details corrected" },
  export: { businessDays: 10, source: "BAA 1.5.1 clause 14(a); the handover states none" },
  patient_request: { businessDays: 5, source: "BAA 1.5.1 clause 14, last paragraph; handover, A request a patient makes to us" },
};

/** Two business days or fewer left is due soon. */
export const DUE_SOON_BUSINESS_DAYS = 2;

/** How long a backup can still hold an erased person, in calendar days after the deletion. */
export const ERASURE_BACKUP_DAYS = BACKUP_RETENTION_DAYS;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a value is a real calendar day, YYYY-MM-DD. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** The UTC calendar day of a moment. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `days` business days after a calendar day, as a calendar day. */
export function businessDaysAfter(day: string, days: number): string {
  return utcDay(addBusinessDays(new Date(`${day}T12:00:00Z`), days));
}

/** The due day of a request of this kind received on this day. */
export function dueOnFor(kind: RightsKind, receivedOn: string): string {
  return businessDaysAfter(receivedOn, RIGHTS_CLOCKS[kind].businessDays);
}

function isWeekday(day: Date): boolean {
  const dow = day.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * Business days from `today` to `due`: the weekdays after today up to and
 * including the due day, so 0 on the due day itself (or a weekend before a
 * Monday due day), and negative once it has passed (the weekdays after the
 * due day up to and including today).
 */
export function businessDaysLeft(today: string, due: string): number {
  const from = new Date(`${today}T12:00:00Z`);
  const to = new Date(`${due}T12:00:00Z`);
  const sign = to.getTime() >= from.getTime() ? 1 : -1;
  const [start, end] = sign === 1 ? [from, to] : [to, from];
  let n = 0;
  for (let d = new Date(start.getTime() + DAY_MS); d.getTime() <= end.getTime(); d = new Date(d.getTime() + DAY_MS)) {
    if (isWeekday(d)) n += 1;
  }
  return n === 0 ? 0 : sign * n;
}

export type RightsClockState = "on_time" | "due_soon" | "overdue";

/** The clock alone: past the due day is overdue, two business days or fewer due soon. */
export function clockState(today: string, due: string): RightsClockState {
  if (today > due) return "overdue";
  return businessDaysLeft(today, due) <= DUE_SOON_BUSINESS_DAYS ? "due_soon" : "on_time";
}

/** The last day a backup can still hold an erased person: the deletion's UTC day plus 35. */
export function backupExpiresOn(erasedAt: Date): string {
  return utcDay(new Date(erasedAt.getTime() + ERASURE_BACKUP_DAYS * DAY_MS));
}
