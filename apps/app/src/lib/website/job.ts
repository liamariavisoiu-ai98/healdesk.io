import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import {
  JOB_SITE_READS,
  JOB_WEBSITE_DRIFT,
  runSwitchedJob,
  type JobOutcome,
} from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { readClinicWebsite, webOrigin, type SiteReadOutcome } from "./client";
import { requestSiteReread } from "./queue";
import { claimSiteReread, recordSiteReread, siteRereadOwed, type SiteRereadRecord } from "./store";

/**
 * The signed website re-reads' jobs (plan Part B, "Re-reads"; Part F3).
 *
 * Every minute, from its own pg-boss queue, behind the `site-reads` switch:
 * each clinic's due read, one at a time per clinic. A read is claimed in one
 * transaction, sent to apps/web outside any (client.ts), and recorded in a
 * third (store.ts). Nothing is read until HEALDESK_WEB_URL names apps/web.
 *
 * Every hour, from the tick: the same, as the minute queue's backstop, and
 * the sweeps. Behind `site-reads`, a read for any clinic with a website and
 * no profile, or a profile of another website, that its own save did not
 * ask for. Behind `website-drift`, off until the owner switches it on, the
 * monthly check of each live clinic.
 */

const ACTOR = { type: "service", serviceName: "site-reads" } as const;

/** Reads per minute, at most: each can take a minute at apps/web. */
const READS_PER_FIRE = 2;
/** Drift checks asked for per hour, at most: a month's checks spread over many hours. */
const DRIFT_PER_HOUR = 25;

export type SiteReadsDeps = {
  /** The read itself; apps/web's signed route otherwise. */
  read?: (input: { clinicId: string; website: string }) => Promise<SiteReadOutcome>;
  now?: () => Date;
};

/** Reads due across every clinic, through the tenant walk (drizzle app_due_site_rereads). Ids only. */
export async function dueSiteRereads(limit: number): Promise<{ clinicId: string; id: string }[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_due_site_rereads(${limit})`,
  );
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({ clinicId: String(row.clinic_id), id: String(row.id) }));
}

/** One clinic's read, from claim to record. What it came to, or null when it was not ours to run. */
export async function runOneSiteReread(
  clinicId: string,
  id: string,
  deps: SiteReadsDeps = {},
): Promise<SiteRereadRecord | null> {
  const clock = deps.now ?? (() => new Date());
  const claimed = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    claimSiteReread(tx, id, clock()),
  );
  if (!claimed) return null;
  const outcome = await (deps.read ?? readClinicWebsite)({ clinicId, website: claimed.website });
  const recorded = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    recordSiteReread(tx, { reread: claimed, outcome, now: clock() }),
  );
  log.info("website re-read", {
    clinicId,
    rereadId: id,
    reason: claimed.reason,
    status: recorded?.status ?? "taken_over",
    code: recorded?.failure,
    count: recorded?.changes ?? 0,
  });
  return recorded;
}

/** The due reads, each clinic's in turn, up to `limit`. */
export async function runDueSiteRereads(
  deps: SiteReadsDeps = {},
  limit: number = READS_PER_FIRE,
): Promise<{ ran: number; statuses: string[] }> {
  const due = await dueSiteRereads(limit * 4);
  const seen = new Set<string>();
  const statuses: string[] = [];
  for (const { clinicId, id } of due) {
    if (statuses.length >= limit) break;
    if (seen.has(clinicId)) continue;
    seen.add(clinicId);
    try {
      const recorded = await runOneSiteReread(clinicId, id, deps);
      if (recorded) statuses.push(recorded.status);
    } catch (error) {
      log.error("website re-read threw", { clinicId, rereadId: id, error: describeError(error) });
    }
  }
  return { ran: statuses.length, statuses };
}

/**
 * Whether reads can go out: HEALDESK_WEB_URL set and well formed. A value
 * that is not an origin throws, so the job row records the failure rather
 * than a quiet "nothing to do".
 */
function readsConfigured(deps: SiteReadsDeps): boolean {
  if (deps.read) return true;
  return webOrigin() !== null;
}

const UNSET = "HEALDESK_WEB_URL is not set: nothing read.";

/** The `site-reads` queue's job, every minute. */
export async function runSiteReadsJob(deps: SiteReadsDeps = {}): Promise<JobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  return runSwitchedJob(
    JOB_SITE_READS,
    async () => {
      if (!readsConfigured(deps)) return UNSET;
      const { ran, statuses } = await runDueSiteRereads(deps);
      return `${ran} read(s)${ran ? `: ${statuses.join(", ")}` : ""}.`;
    },
    now,
  );
}

/**
 * Ask for the reads clinics are owed: behind `site-reads`, a website with no
 * baseline or one of another website; with `drift`, the monthly check, at
 * most DRIFT_PER_HOUR an hour.
 */
export async function sweepSiteRereads(input: {
  drift: boolean;
  now?: Date;
}): Promise<{ asked: number; drift: number; failures: number }> {
  const now = input.now ?? new Date();
  const out = { asked: 0, drift: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.offboardingStartedAt) continue;
    try {
      const asked = await withTenant({ clinicId: clinic.id, actor: ACTOR }, async (tx) => {
        const owed = await siteRereadOwed(tx, {
          now,
          drift: input.drift && out.drift < DRIFT_PER_HOUR,
        });
        if (!owed) return null;
        await requestSiteReread(tx, { reason: owed.reason, website: owed.website, now });
        return owed.reason;
      });
      if (asked === "drift") out.drift += 1;
      else if (asked) out.asked += 1;
    } catch (error) {
      out.failures += 1;
      log.error("website re-read sweep could not read a clinic", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return out;
}

/**
 * The tick's hour, behind `site-reads`: the missing and corrected reads owed,
 * then the due reads, as the minute queue's backstop.
 */
export async function runSiteReadsSweep(deps: SiteReadsDeps = {}): Promise<JobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  return runSwitchedJob(
    JOB_SITE_READS,
    async () => {
      const swept = await sweepSiteRereads({ drift: false, now });
      const asked = `${swept.asked} read(s) asked for${swept.failures ? `, ${swept.failures} clinic(s) unread` : ""}`;
      if (!readsConfigured(deps)) return `${asked}. ${UNSET}`;
      const { ran } = await runDueSiteRereads(deps);
      return `${asked}, ${ran} read(s) run.`;
    },
    now,
  );
}

/**
 * The tick's hour, behind `website-drift` (off until the owner switches it
 * on): the monthly check asked for of each live clinic whose last read is
 * DRIFT_INTERVAL_DAYS old. The reads themselves go from the `site-reads`
 * queue, so a check asked for here is read within the minute.
 */
export async function runWebsiteDriftJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_WEBSITE_DRIFT,
    async () => {
      const swept = await sweepSiteRereads({ drift: true, now });
      return `${swept.drift} drift check(s) and ${swept.asked} other read(s) asked for${swept.failures ? `, ${swept.failures} clinic(s) unread` : ""}.`;
    },
    now,
  );
}
