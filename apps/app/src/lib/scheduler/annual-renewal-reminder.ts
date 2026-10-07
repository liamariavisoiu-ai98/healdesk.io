import { annualTotalUsd, getPlan } from "@healdesk/catalog";

import type { Entitlements } from "@/db/schema";
import { getEntitlementsForUpdate } from "@/lib/billing/entitlements";
import { enqueueNotice } from "@/lib/billing/notices";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { JOB_ANNUAL_RENEWAL_REMINDER, runJob } from "./jobs";

/**
 * The renewal notices the terms of service promise an annual plan (BD17,
 * R32): `renewal_upcoming`, 30 days and again 21 days before the renewal.
 *
 * This job is their only producer. It queues outbox notices, which the email
 * platform delivers to the clinic's one address in daytime hours (the kind's
 * quiet hours); it sends nothing itself. The version it replaces mailed the
 * report recipients from inside a tenant transaction, and read the renewal
 * from `current_period_end`, which on an annual plan is the monthly allowance
 * window: switched on, it would have announced a renewal every month.
 *
 * The renewal is `paid_through`, the end of the period the last plan invoice
 * paid for, which only a plan that has started has: the $0 placeholder's
 * months set none, so nothing is announced before the plan starts (R37). The
 * amount is the annual price of the package billed, times the locations. A
 * clinic whose cancellation is scheduled (`cancel_at`, or `canceling`) is not
 * renewing, and one that has ended (`canceled`, `purged`) has nothing to
 * renew.
 *
 * ## Windows, not days
 *
 * Each notice has a window rather than a single day, so a run missed (the
 * worker down at 09 UTC, the job switched on late) is caught up by the next
 * one, and the dedupe key (`renewal:<renewsOn>:<noticeDays>`, R22) keeps each
 * to one email per renewal. The 30-day notice is due from 31 days before the
 * renewal and the 21-day one from 22 days before, because the job runs once a
 * day: the first run inside each window is then at least 30 (or 21) days
 * ahead, which is what the notice promises. The 30-day window closes where
 * the 21-day one opens, so a clinic first reached inside 22 days gets the
 * 21-day notice alone rather than a late "30 days" one.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The notices, latest first, each due from `fromDays` before the renewal. */
const NOTICES = [
  { noticeDays: 21, fromDays: 22 },
  { noticeDays: 30, fromDays: 31 },
] as const;

type NoticeDays = (typeof NOTICES)[number]["noticeDays"];

/** Which notice is due at `now` for a renewal at `renewsAt`, or null for none. Pure. */
export function renewalNoticeDue(renewsAt: Date, now: Date): NoticeDays | null {
  const left = renewsAt.getTime() - now.getTime();
  if (left <= 0) return null;
  for (const notice of NOTICES) {
    if (left <= notice.fromDays * DAY_MS) return notice.noticeDays;
  }
  return null;
}

function isRenewing(row: Entitlements): boolean {
  if (row.billingInterval !== "year" || row.paidThrough === null) return false;
  if (row.cancelAt !== null) return false;
  return row.status !== "canceling" && row.status !== "canceled" && row.status !== "purged";
}

export type RenewalRun = { considered: number; queued: number; skipped: number; failed: number };

export async function sendRenewalReminders(now: Date): Promise<RenewalRun> {
  const out: RenewalRun = { considered: 0, queued: 0, skipped: 0, failed: 0 };
  const actor = { type: "service", serviceName: "annual-renewal-reminder" } as const;

  for (const clinic of await listClinics()) {
    // A location is billed through its billing clinic, which holds the row.
    if (clinic.billingClinicId !== null) continue;
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
        // Locked, so a renewal is not announced in the same moment auto-renew
        // goes off: the cancellation's transaction waits, or this one does.
        const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
        if (!row || !isRenewing(row) || !row.paidThrough) return "skipped" as const;
        const noticeDays = renewalNoticeDue(row.paidThrough, now);
        if (noticeDays === null) return "skipped" as const;
        const plan = getPlan(row.planCode);
        if (!plan) return "skipped" as const;
        const renewsOn = row.paidThrough.toISOString().slice(0, 10);
        const dedupeKey = `renewal:${renewsOn}:${noticeDays}`;
        const queued = await enqueueNotice(tx, "renewal_upcoming", dedupeKey, {
          renewsOn,
          amountCents: annualTotalUsd(plan) * 100 * row.locations,
          planName: plan.name,
          locations: row.locations,
          noticeDays,
        });
        return queued ? ("queued" as const) : ("skipped" as const);
      });
      out.considered += 1;
      out[outcome] += 1;
    } catch (error) {
      out.failed += 1;
      log.error("renewal reminder failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return out;
}

export async function runAnnualRenewalReminderJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_ANNUAL_RENEWAL_REMINDER,
    async () => {
      const r = await sendRenewalReminders(now);
      return (
        `Considered ${r.considered}: ${r.queued} queued, ${r.skipped} skipped` +
        (r.failed ? `, ${r.failed} failed` : "") +
        "."
      );
    },
    now,
  );
}
