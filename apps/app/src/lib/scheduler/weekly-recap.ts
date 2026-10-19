import { and, eq, gte, sql } from "drizzle-orm";

import { billingNotices, clinics, clinicSettings } from "@/db/schema";
import { readChannelStates } from "@/lib/channels/state";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { listClinics } from "@/lib/ops/clinics";
import { publicUrl } from "@/lib/public-url";
import { claimsPayload, readClaims } from "@/lib/reporting/claims";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { earliest, hoursOf, ON_ITS_WAY, queuedAlready } from "./daily-summary";
import { JOB_WEEKLY_RECAP, runJob, type JobOutcome } from "./jobs";
import { isoWeekOf, lastWeek, localClock, mondayOf } from "./summary-clock";

/**
 * L14, "Your week with AYA" (Annex X5), alone: last week's claims, on the
 * clinic's Monday, only while no daily summary can carry them. While the
 * summary goes, the week's first one carries this recap
 * (lib/scheduler/daily-summary.ts) and nothing goes from here (X3,
 * "Designed merges"). No summary can carry it while the clinic's Daily
 * summary switch is off, or while no opening hours are on file to send one
 * at.
 *
 * Retargeted onto the outbox (Annex X6): it used to mail every
 * report_recipients address itself, through getTransport, with its own
 * ledger rows. Now it is one `weekly_recap` notice to the clinic's one
 * address, resolved by the sender at send time (lib/email/outbox.ts), and
 * report_recipients is not read here at all.
 *
 * Hourly from the tick, behind its switch (seeded off, drizzle/0034): the
 * first run on the clinic's Monday from 08:00 its time, and before 20:00,
 * queues the recap of the Monday-to-Sunday week before, once
 * (`weekly_recap:<that week>`). It goes for a production clinic with a
 * channel that was live during that week, and never for a week with no
 * conversations at all: an email saying zero is worse than silence. What it
 * may claim is the claims function's (lib/reporting/claims.ts): never
 * revenue, never "collected" outside deposits collected, never "recovered".
 */

const ACTOR = { type: "service", serviceName: "weekly-recap" } as const;

/** The local hour on Monday from which the recap may be queued. */
export const RECAP_FROM_HOUR = 8;
const RECAP_UNTIL_HOUR = 20;

export type WeeklyRecapOutcome =
  "queued" | "already_queued" | "not_live" | "not_due" | "in_summary" | "empty";

/** Queue last week's recap for one clinic, if it is due and no summary carries it. */
export async function queueWeeklyRecapFor(
  clinicId: string,
  now: Date,
): Promise<WeeklyRecapOutcome> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        slug: clinics.slug,
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        dataClassification: clinics.dataClassification,
        offboardingStartedAt: clinics.offboardingStartedAt,
        destroyedAt: clinics.destroyedAt,
        dailySummary: clinicSettings.dailySummary,
      })
      .from(clinics)
      .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (
      !clinic ||
      clinic.dataClassification !== "production" ||
      clinic.offboardingStartedAt ||
      clinic.destroyedAt
    ) {
      return "not_live";
    }
    const clock = localClock(now, clinic.timezone);
    if (clock.day !== "mon" || clock.hour < RECAP_FROM_HOUR || clock.hour >= RECAP_UNTIL_HOUR) {
      return "not_due";
    }
    const week = lastWeek(clock.date, clinic.timezone);
    const states = await readChannelStates(tx.db, tx.clinicId, now);
    const liveSince = earliest(states.map((s) => s.liveAt));
    if (!liveSince || liveSince.getTime() >= week.to.getTime()) return "not_live";

    // No settings row reads as the default, which is on.
    const summaryOn = clinic.dailySummary !== false;
    const hoursKnown = hoursOf(clinic.openingHours) !== null;
    if (summaryOn && hoursKnown) return "in_summary";
    // A summary this week already carried it (it went at opening, and the
    // switch was turned off after).
    if (await summaryCarriedRecap(tx, mondayOf(clock.date))) return "in_summary";

    const dedupeKey = `weekly_recap:${isoWeekOf(week.startOn)}`;
    if (await queuedAlready(tx, "weekly_recap", dedupeKey)) return "already_queued";

    const claims = await readClaims(tx, { from: week.from, to: week.to }, "weekly_recap");
    if (claims.handled === 0) return "empty";

    const queued = await enqueuePlanNotice(tx.db, tx.clinicId, "weekly_recap", dedupeKey, {
      weekStartOn: week.startOn,
      weekEndOn: week.endOn,
      weekClaims: claimsPayload(claims),
      isSummaryOff: !summaryOn,
      homeUrl: publicUrl(`/c/${clinic.slug}`),
      settingsUrl: publicUrl(
        summaryOn ? `/c/${clinic.slug}/knowledge#hours` : `/c/${clinic.slug}/settings#alerts`,
      ),
    });
    return queued ? "queued" : "already_queued";
  });
}

/** Whether a daily summary on its way this week carried last week's recap. */
async function summaryCarriedRecap(tx: TenantTx, monday: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, "daily_summary"),
        gte(billingNotices.dedupeKey, `daily_summary:${monday}`),
        sql`jsonb_typeof(${billingNotices.payload} -> 'weekClaims') = 'object'`,
        ON_ITS_WAY,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function runWeeklyRecapJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_WEEKLY_RECAP,
    async () => {
      const counts: Partial<Record<WeeklyRecapOutcome | "failed", number>> = {};
      for (const clinic of await listClinics()) {
        if (clinic.destroyedAt || clinic.offboardingStartedAt) continue;
        if (clinic.dataClassification !== "production") continue;
        let outcome: WeeklyRecapOutcome | "failed";
        try {
          outcome = await queueWeeklyRecapFor(clinic.id, now);
        } catch (error) {
          outcome = "failed";
          log.error("weekly recap failed for a clinic", {
            clinicId: clinic.id,
            error: describeError(error),
          });
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
      return (
        `${counts.queued ?? 0} recap(s) queued, ${counts.in_summary ?? 0} in the daily summary, ` +
        `${counts.empty ?? 0} empty, ${counts.failed ?? 0} failed.`
      );
    },
    now,
  );
}
