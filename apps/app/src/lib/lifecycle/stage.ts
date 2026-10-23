import { SETUP_WINDOW_DAYS } from "@healdesk/catalog";

import type { BillingStatus, LifecycleStage } from "@/db/schema";
import type { ChannelStatus } from "@/lib/channels/state";
import { isClinicAction, type ChannelNextStep } from "@/lib/setup/channels";

/**
 * Where a billing clinic stands in its life with us (design E2 of the ops
 * automation plan, 23 October 2026, step 3). Pure: the facts are read by
 * lib/lifecycle/watch.ts, and the clock is the caller's.
 *
 *   closed         the account has ended: cancelled, purged, or offboarding;
 *   live           every channel it has switched on is answering;
 *   partly_live    at least one is answering and another still is not;
 *   waiting_on_us  nothing is answering, the clinic has done every step it
 *                  can, and a channel is still being prepared on our side;
 *   not_started    nothing is answering and nobody has answered or skipped
 *                  a single setup screen;
 *   in_setup       everything else: the clinic still owes a step.
 *
 * Before an account exists there is no clinic and no stage: a paid order
 * without an account stays with the ops watch's own alerts
 * (lib/ops/watch.ts), which this does not repeat.
 */

/** One bought channel, as the setup reads it (lib/channels/state.ts, lib/setup/channels.ts). */
export type StageChannel = {
  status: ChannelStatus;
  nextStep: ChannelNextStep;
  liveAt: Date | null;
};

export type StageFacts = {
  billingStatus: BillingStatus;
  offboarding: boolean;
  channels: readonly StageChannel[];
  wizardFinished: boolean;
  /** Wizard steps with a screen nobody has answered or skipped (lib/setup/screens.ts stepsLeft). */
  stepsLeft: number;
  /** Whether any setup screen has been answered or skipped: the clinic has been in. */
  anyProgress: boolean;
};

/** Billing statuses of an account that has ended. A `demo` account is never watched. */
const ENDED: ReadonlySet<BillingStatus> = new Set<BillingStatus>(["canceled", "purged"]);

function answering(channel: StageChannel): boolean {
  return channel.status === "live" || channel.status === "paused";
}

export function lifecycleStage(facts: StageFacts): LifecycleStage {
  if (facts.offboarding || ENDED.has(facts.billingStatus)) return "closed";
  const on = facts.channels.filter((c) => c.status !== "off");
  const live = on.filter(answering);
  if (live.length > 0) return live.length === on.length ? "live" : "partly_live";
  if (!facts.anyProgress) return "not_started";
  if (facts.wizardFinished && on.length > 0 && on.every((c) => !isClinicAction(c.nextStep))) {
    return "waiting_on_us";
  }
  return "in_setup";
}

/**
 * Channels switched on, not answering, and waiting for one thing from the
 * clinic other than finishing the wizard (which `stepsLeft` already counts).
 */
export function channelsWaitingOnClinic(channels: readonly StageChannel[]): number {
  return channels.filter(
    (c) =>
      c.status !== "off" &&
      !answering(c) &&
      isClinicAction(c.nextStep) &&
      c.nextStep !== "finish_setup",
  ).length;
}

/** What the clinic still owes: wizard steps and channel actions. The day-22 rule's "steps left". */
export function owedSteps(row: { stepsLeft: number; channelsWaiting: number }): number {
  return row.stepsLeft + row.channelsWaiting;
}

const DAY_MS = 86_400_000;

/**
 * The day of the 30-day setup window `today` falls on, counted from the
 * window's start on the clinic's calendar (setupWindowStart), as the setup
 * reminders count: day 30 is the window's last day. Null before the window.
 */
export function windowDay(windowStart: string, today: string): number | null {
  const days = Math.round(
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${windowStart}T12:00:00Z`)) / DAY_MS,
  );
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

/** Days left in the window on `day`, the last day counting as zero left after it. */
export function remainingDays(day: number): number {
  return Math.max(0, SETUP_WINDOW_DAYS - day);
}

/** Whole days between two instants, rounded down; never negative. */
export function wholeDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * When a clinic first seen by the watch entered the stage it is in, from what
 * its rows already say, so switching the job on does not restart every
 * clock: the first payment for one that has not started, its last progress
 * for one in setup or waiting on us, its first channel live for a partly
 * live one and its last for a live one. Falls back to `now`.
 */
export function firstSeenStageSince(
  stage: LifecycleStage,
  facts: {
    firstPaidAt: Date | null;
    createdAt: Date;
    lastProgressAt: Date | null;
    liveAts: readonly Date[];
    now: Date;
  },
): Date {
  const sorted = [...facts.liveAts].sort((a, b) => a.getTime() - b.getTime());
  switch (stage) {
    case "not_started":
      return facts.firstPaidAt ?? facts.createdAt;
    case "in_setup":
    case "waiting_on_us":
      return facts.lastProgressAt ?? facts.firstPaidAt ?? facts.createdAt;
    case "partly_live":
      return sorted[0] ?? facts.now;
    case "live":
      return sorted[sorted.length - 1] ?? facts.now;
    case "closed":
      return facts.now;
  }
}
