import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinicLifecycle, lifecycleWaves, type LifecycleStage } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupLastDay, setupWindowStart } from "@/lib/clinic/setup-window";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { raiseOpsAlertKeyed } from "@/lib/ops/notify";
import { JOB_LIFECYCLE_WATCH, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { channelNextStep } from "@/lib/setup/channels";
import { stepsLeft, wizardFinished } from "@/lib/setup/screens";
import { readSetupState } from "@/lib/setup/state";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { isLifecycleIgnored } from "./ignore";
import { clinicWavesOf, readLedger } from "./ledger";
import {
  channelsWaitingOnClinic,
  firstSeenStageSince,
  lifecycleStage,
  windowDay,
  type StageChannel,
} from "./stage";
import { dueWaves, targetsOf, type DueWave, type WaveFacts } from "./waves";

/**
 * The lifecycle watch (design E2 of the ops automation plan, steps 3 and 4;
 * owner decisions D4 to D7, 23 October 2026). Hourly from the tick, behind
 * its switch, seeded off: for each billing clinic,
 *
 *   1. its stage (lib/lifecycle/stage.ts), what it still owes and when it
 *      last made progress, upserted into clinic_lifecycle. A setup deadline
 *      later than the one last seen was extended (extendSetupDeadline), and
 *      the decision becomes `extended`;
 *   2. every setup reminder the setup-reminders job queued, recorded in the
 *      ledger (lifecycle_waves) when the watch sees its notice. The watch
 *      sends nothing to a clinic and changes nothing that job sends: it reads
 *      the outbox, never writes it;
 *   3. the ops waves due (lib/lifecycle/waves.ts), each raised once by its
 *      own key (raiseOpsAlertKeyed) and recorded under Slack, and for an
 *      escalation under the ops address too. A wave whose alert could not be
 *      recorded is left for the next hour.
 *
 * healdesk's demo clinic is never watched: its billing row's status is
 * `demo`, which no paying clinic's can be (app_clinic_is_demo, drizzle/0057,
 * needs it too). Every other billing clinic is, `synthetic` or not, since a
 * paying clinic is classed synthetic until it goes live. Before an account
 * exists there is no clinic to watch; the ops watch's own alerts cover a
 * paid order with no account (lib/ops/watch.ts), and nothing here repeats
 * them.
 *
 * A clinic on the ignore list (./ignore.ts: healdesk's own test accounts) is
 * not observed at all: no stage row moves, no reminder is recorded, no wave
 * is raised. Its row, if it had one, is left as it was, and readLifecycleRow
 * hides it from the watch's other consumers.
 */

const ACTOR = { type: "service", serviceName: "lifecycle-watch" } as const;
/** The stages the setup window still closes: setup itself, and waiting on us. */
const WINDOWED_STAGES: ReadonlySet<LifecycleStage> = new Set([
  "not_started",
  "in_setup",
  "waiting_on_us",
]);
/** An address problem already alerted for the clinic carries an undelivered reminder's wave. */
const ADDRESS_EVENTS = [
  "clinic_address_bounced",
  "clinic_address_complained",
  "clinic_address_suppressed",
];
const DAY_MS = 86_400_000;

export type WatchedClinic = {
  stage: LifecycleStage;
  recorded: number;
  due: DueWave[];
};

function latest(dates: readonly (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
}

/**
 * Steps 1 and 2 and the waves due, in the clinic's tenant. Null for a clinic
 * with no billing row of its own (a location) or a demo account.
 */
async function observe(tx: TenantTx, now: Date): Promise<WatchedClinic | null> {
  const state = await readSetupState(tx, { userId: null, now });
  // healdesk's demo clinic is the one billing row with status `demo`. Every
  // other clinic is real, synthetic or not: a paying clinic stays
  // `synthetic` until it goes live (app_mark_clinic_production).
  if (!state?.billing || state.billing.status === "demo") return null;
  const { billing, clinic } = state;

  const finished = wizardFinished(state.screens, state.progress);
  const channels: StageChannel[] = state.channels.map((c) => ({
    status: c.status,
    nextStep: channelNextStep(c, finished),
    liveAt: c.liveAt,
  }));
  const steps = stepsLeft(state.screens, state.progress);
  const waiting = channelsWaitingOnClinic(channels);
  const stage = lifecycleStage({
    billingStatus: billing.status,
    offboarding: clinic.offboardingStartedAt !== null,
    channels,
    wizardFinished: finished,
    stepsLeft: steps,
    anyProgress: state.progress.size > 0,
  });
  // The clinic's own last act: a screen answered or skipped, a channel live.
  const progressAt = latest([
    ...[...state.progress.values()].map((p) => p.at),
    ...state.channels.map((c) => c.liveAt),
  ]);

  const [prev] = await tx.db
    .select()
    .from(clinicLifecycle)
    .where(eq(clinicLifecycle.clinicId, tx.clinicId))
    .for("update")
    .limit(1);

  const deadline = billing.setupDeadlineAt;
  const lastProgressAt = latest([prev?.lastProgressAt, progressAt]);
  // An extension moves the window's last day later; a time-zone correction
  // moves the deadline's instant and keeps its last day, so it is not one.
  const lastDay = deadline ? setupLastDay(deadline, clinic.timezone) : null;
  const extended = prev?.lastDay != null && lastDay !== null && lastDay > prev.lastDay;
  const row = {
    stage,
    stageSince:
      prev && prev.stage === stage
        ? prev.stageSince
        : prev
          ? now
          : firstSeenStageSince(stage, {
              firstPaidAt: billing.firstPaidAt,
              createdAt: clinic.createdAt,
              lastProgressAt,
              liveAts: state.channels.flatMap((c) => (c.liveAt ? [c.liveAt] : [])),
              now,
            }),
    stepsLeft: steps,
    channelsWaiting: waiting,
    lastProgressAt,
    deadlineAt: deadline,
    lastDay,
    updatedAt: now,
    ...(extended
      ? { decision: "extended" as const, decidedBy: "setup deadline extended", decidedAt: now }
      : {}),
  };
  if (prev) {
    await tx.db.update(clinicLifecycle).set(row).where(eq(clinicLifecycle.clinicId, tx.clinicId));
  } else {
    await tx.db.insert(clinicLifecycle).values({ clinicId: tx.clinicId, ...row, createdAt: now });
  }

  // Step 2: the spec reminders the setup-reminders job queued, recorded once.
  const recorded = await tx.db.execute(sql`
    insert into lifecycle_waves (clinic_id, stage, wave, target, notice_id, queued_at)
    select n.clinic_id, ${stage}, n.dedupe_key, 'clinic_email', n.id, n.created_at
      from billing_notices n
     where n.clinic_id = ${tx.clinicId}
       and n.kind = 'setup_reminder'
       and n.dedupe_key ~ '^[a-z0-9_]+(:[A-Za-z0-9_.:+-]{1,60})?$'
       and not exists (select 1 from lifecycle_waves w
                        where w.clinic_id = n.clinic_id and w.notice_id = n.id)
    on conflict do nothing
  `);

  const ledger = await readLedger(tx);
  const facts: WaveFacts = {
    stage,
    stageSince: row.stageSince,
    now,
    windowDay:
      deadline && WINDOWED_STAGES.has(stage)
        ? windowDay(
            setupWindowStart(deadline, clinic.timezone),
            clinicLocalDate(now, clinic.timezone),
          )
        : null,
    lastDay,
    stepsLeft: steps,
    channelsWaiting: waiting,
    answeredAScreen: state.progress.size > 0,
    lastProgressAt,
    decision: extended ? "extended" : (prev?.decision ?? "none"),
    snoozedUntil: prev?.snoozedUntil ?? null,
    clinicWaves: clinicWavesOf(ledger),
    recorded: new Set(
      ledger.filter((w) => w.target !== "clinic_email").map((w) => `${w.wave}|${w.target}`),
    ),
  };
  return { stage, recorded: recorded.rowCount ?? 0, due: dueWaves(facts) };
}

/** An address alert already raised for the clinic since the reminder went, or null. */
async function addressAlertFor(clinicId: string, since: Date): Promise<string | null> {
  const result = await unsafeDb.execute<{ id: string }>(sql`
    select id from ops_alerts
     where event in (${sql.join(
       ADDRESS_EVENTS.map((e) => sql`${e}`),
       sql`, `,
     )})
       and fields->>'clinicId' = ${clinicId}
       and raised_at >= ${since}
     order by raised_at
     limit 1
  `);
  return result.rows[0]?.id ?? null;
}

/** Step 3 for one wave: raise (or find) its alert, then record it. False when left for the next hour. */
async function fireWave(
  clinicId: string,
  stage: LifecycleStage,
  wave: DueWave,
  now: Date,
): Promise<boolean> {
  let alertId: string | null = null;
  if (!wave.skip) {
    if (wave.event === "lifecycle_reminder_undelivered") {
      alertId = await addressAlertFor(
        clinicId,
        wave.noticeSentAt ?? new Date(now.getTime() - 30 * DAY_MS),
      );
    }
    alertId ??= await raiseOpsAlertKeyed(
      wave.event,
      { clinicId, ...wave.fields },
      { key: `${clinicId}:${wave.wave}`, email: wave.escalated },
    );
    if (!alertId) return false;
  }
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    for (const target of targetsOf(wave)) {
      await tx.db
        .insert(lifecycleWaves)
        .values({
          clinicId,
          stage,
          wave: wave.wave,
          target,
          opsAlertId: alertId,
          queuedAt: now,
          escalated: wave.escalated,
          ...(wave.skip ? { delivery: "skipped" as const, error: wave.skip } : {}),
        })
        .onConflictDoNothing();
    }
  });
  return true;
}

export type LifecycleWatchResult = {
  clinics: number;
  recorded: number;
  raised: number;
  skipped: number;
  deferred: number;
  /** Clinics on the ignore list, left out. */
  ignored: number;
  failures: number;
};

/** One pass at `now`, without the job's switch: exported so a test drives it. */
export async function watchLifecycles(now: Date = new Date()): Promise<LifecycleWatchResult> {
  const result: LifecycleWatchResult = {
    clinics: 0,
    recorded: 0,
    raised: 0,
    skipped: 0,
    deferred: 0,
    ignored: 0,
    failures: 0,
  };
  for (const clinic of await listClinics()) {
    if (clinic.billingClinicId || clinic.destroyedAt) continue;
    try {
      const seen = await withTenant({ clinicId: clinic.id, actor: ACTOR }, async (tx) =>
        (await isLifecycleIgnored(tx)) ? ("ignored" as const) : observe(tx, now),
      );
      if (seen === "ignored") {
        result.ignored += 1;
        continue;
      }
      if (!seen) continue;
      result.clinics += 1;
      result.recorded += seen.recorded;
      for (const wave of seen.due) {
        if (!(await fireWave(clinic.id, seen.stage, wave, now))) result.deferred += 1;
        else if (wave.skip) result.skipped += 1;
        else result.raised += 1;
      }
    } catch (error) {
      result.failures += 1;
      log.error("lifecycle watch failed for a clinic", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return result;
}

/** The hourly job, behind the `lifecycle-watch` switch. */
export async function runLifecycleWatchJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_LIFECYCLE_WATCH,
    async () => {
      const r = await watchLifecycles(now);
      const note =
        `${r.clinics} clinics, ${r.recorded} reminders recorded, ${r.raised} waves raised, ` +
        `${r.skipped} muted, ${r.deferred} left for the next hour, ${r.ignored} not watched (internal), ` +
        `${r.failures} failed.`;
      if (r.failures > 0 && r.clinics === 0) throw new Error(note);
      return note;
    },
    now,
  );
}

/**
 * The clinic's lifecycle row, in its tenant, as the watch's consumers read it
 * (the digest's Lifecycle block among them): null for a clinic on the ignore
 * list, as for one never watched. The console's own list passes
 * `includeIgnored` and says the clinic is not watched.
 */
export async function readLifecycleRow(tx: TenantTx, options: { includeIgnored?: boolean } = {}) {
  if (!options.includeIgnored && (await isLifecycleIgnored(tx))) return null;
  const [row] = await tx.db
    .select()
    .from(clinicLifecycle)
    .where(eq(clinicLifecycle.clinicId, tx.clinicId))
    .limit(1);
  return row ?? null;
}
