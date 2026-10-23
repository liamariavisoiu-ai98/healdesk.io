import { describe, expect, test } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { recommend, type RecommendFacts } from "@/lib/lifecycle/recommend";
import {
  channelsWaitingOnClinic,
  firstSeenStageSince,
  lifecycleStage,
  windowDay,
  type StageChannel,
  type StageFacts,
} from "@/lib/lifecycle/stage";
import type { LedgerWave } from "@/lib/lifecycle/ledger";
import { lifecycleView } from "@/lib/lifecycle/view";
import {
  businessDaysBetween,
  currentFailures,
  dueWaves,
  recommendationFor,
  LIFECYCLE_ESCALATIONS,
  LIFECYCLE_EVENTS,
  targetsOf,
  type ClinicWave,
  type WaveFacts,
} from "@/lib/lifecycle/waves";
import { OPS_EVENTS } from "@/lib/ops/notify";
import { slackFields, slackText } from "@/lib/ops/slack";

/**
 * The lifecycle watch's pure rules (design E2, steps 3 and 4; owner
 * decisions D5 to D7): the stage, the ops waves and the recommendation, each
 * a function of facts and a clock the test sets. No database, no real time.
 */

const NOW = new Date("2026-10-21T16:00:00Z"); // a Wednesday
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const waitingOnUs: StageChannel = { status: "setting_up", nextStep: "preparing", liveAt: null };
const forwarding: StageChannel = { status: "waiting", nextStep: "forwarding", liveAt: null };
const finishSetup: StageChannel = { status: "setting_up", nextStep: "finish_setup", liveAt: null };
const live: StageChannel = { status: "live", nextStep: "none", liveAt: ago(3 * DAY) };
const paused: StageChannel = { status: "paused", nextStep: "none", liveAt: ago(9 * DAY) };
const off: StageChannel = { status: "off", nextStep: "none", liveAt: null };

const base: StageFacts = {
  billingStatus: "active",
  offboarding: false,
  channels: [finishSetup],
  wizardFinished: false,
  stepsLeft: 3,
  anyProgress: true,
};

describe("the stage", () => {
  test.each<[string, Partial<StageFacts>, string]>([
    ["nobody has been in", { anyProgress: false }, "not_started"],
    ["a step is still owed", {}, "in_setup"],
    [
      "the wizard is done and a channel waits on the clinic",
      { wizardFinished: true, stepsLeft: 0, channels: [forwarding, waitingOnUs] },
      "in_setup",
    ],
    [
      "the clinic has done every step and a channel is ours to finish",
      { wizardFinished: true, stepsLeft: 0, channels: [waitingOnUs] },
      "waiting_on_us",
    ],
    [
      "a channel switched off does not hold it",
      { wizardFinished: true, stepsLeft: 0, channels: [waitingOnUs, off] },
      "waiting_on_us",
    ],
    ["one live, one waiting", { channels: [live, forwarding] }, "partly_live"],
    ["every channel on is live or paused", { channels: [live, paused, off] }, "live"],
    ["cancelled", { billingStatus: "canceled", channels: [live] }, "closed"],
    ["purged", { billingStatus: "purged" }, "closed"],
    ["offboarding", { offboarding: true, channels: [live] }, "closed"],
    ["past due is still in setup", { billingStatus: "past_due" }, "in_setup"],
  ])("%s", (_, facts, stage) => {
    expect(lifecycleStage({ ...base, ...facts })).toBe(stage);
  });

  test("moves through every stage as the facts change", () => {
    const steps: Partial<StageFacts>[] = [
      { anyProgress: false },
      { anyProgress: true },
      { wizardFinished: true, stepsLeft: 0, channels: [waitingOnUs, waitingOnUs] },
      { wizardFinished: true, stepsLeft: 0, channels: [live, forwarding] },
      { wizardFinished: true, stepsLeft: 0, channels: [live, live] },
      { wizardFinished: true, stepsLeft: 0, channels: [live, live], billingStatus: "canceled" },
    ];
    expect(steps.map((s) => lifecycleStage({ ...base, ...s }))).toEqual([
      "not_started",
      "in_setup",
      "waiting_on_us",
      "partly_live",
      "live",
      "closed",
    ]);
  });

  test("channels waiting on the clinic count actions, never the wizard or our side", () => {
    expect(channelsWaitingOnClinic([forwarding, finishSetup, waitingOnUs, live, off])).toBe(1);
  });

  test("the window's day is counted as the reminders count it, and null before it", () => {
    expect(windowDay("2026-10-01", "2026-10-23")).toBe(22);
    expect(windowDay("2026-10-01", "2026-10-31")).toBe(30);
    expect(windowDay("2026-10-24", "2026-10-23")).toBeNull();
  });

  test("a clinic first seen keeps the clock its rows already started", () => {
    const facts = {
      firstPaidAt: ago(20 * DAY),
      createdAt: ago(21 * DAY),
      lastProgressAt: ago(4 * DAY),
      liveAts: [ago(2 * DAY), ago(6 * DAY)],
      now: NOW,
    };
    expect(firstSeenStageSince("not_started", facts)).toEqual(ago(20 * DAY));
    expect(firstSeenStageSince("waiting_on_us", facts)).toEqual(ago(4 * DAY));
    expect(firstSeenStageSince("partly_live", facts)).toEqual(ago(6 * DAY));
    expect(firstSeenStageSince("live", facts)).toEqual(ago(2 * DAY));
    expect(firstSeenStageSince("closed", facts)).toEqual(NOW);
  });
});

// -----------------------------------------------------------------------------
// The waves
// -----------------------------------------------------------------------------

const setup: WaveFacts = {
  stage: "in_setup",
  stageSince: ago(10 * DAY),
  now: NOW,
  windowDay: 7,
  lastDay: "2026-11-13",
  stepsLeft: 2,
  channelsWaiting: 0,
  answeredAScreen: true,
  lastProgressAt: ago(6 * DAY),
  decision: "none",
  snoozedUntil: null,
  clinicWaves: [],
  recorded: new Set(),
};

function waves(facts: Partial<WaveFacts>) {
  return dueWaves({ ...setup, ...facts }).map((w) => ({
    wave: w.wave,
    event: w.event,
    escalated: w.escalated,
    skip: w.skip,
  }));
}

describe("the ops waves", () => {
  test("every lifecycle event is an ops event, and the escalations are E2's four and the waiting clinic's closing", () => {
    for (const event of LIFECYCLE_EVENTS) expect(OPS_EVENTS as readonly string[]).toContain(event);
    expect([...LIFECYCLE_ESCALATIONS].sort()).toEqual([
      "lifecycle_closing_waiting_on_us",
      "lifecycle_decision_due",
      "lifecycle_reminder_undelivered",
      "lifecycle_reminders_unanswered",
      "lifecycle_waiting_on_us_long",
    ]);
    expect(targetsOf({ escalated: false })).toEqual(["slack"]);
    expect(targetsOf({ escalated: true })).toEqual(["slack", "ops_email"]);
  });

  test.each<[string, Partial<WaveFacts>, ReturnType<typeof waves>]>([
    ["day 6: nothing yet", { windowDay: 6 }, []],
    [
      "day 7, no progress for six days: Slack only",
      { windowDay: 7 },
      [{ wave: "day_7", event: "lifecycle_no_progress", escalated: false, skip: null }],
    ],
    ["day 7, progress yesterday: nothing", { windowDay: 7, lastProgressAt: ago(DAY) }, []],
    [
      "day 7, never any progress: Slack only",
      { windowDay: 7, lastProgressAt: null },
      [{ wave: "day_7", event: "lifecycle_no_progress", escalated: false, skip: null }],
    ],
    [
      "day 15, stale: Slack only (D5)",
      { windowDay: 15 },
      [{ wave: "day_15", event: "lifecycle_no_progress", escalated: false, skip: null }],
    ],
    [
      "day 22, two steps left: the decision, escalated (D7)",
      { windowDay: 22 },
      [{ wave: "day_22:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "day 22, one step left and signed in: Slack only",
      { windowDay: 22, stepsLeft: 1 },
      [
        {
          wave: "day_22:2026-11-13",
          event: "lifecycle_closing_soon",
          escalated: false,
          skip: null,
        },
      ],
    ],
    [
      "day 22, one step but nobody signed in: escalated (D7)",
      { windowDay: 22, stepsLeft: 1, answeredAScreen: false },
      [{ wave: "day_22:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "day 22, one step and one channel action: two owed, escalated",
      { windowDay: 22, stepsLeft: 1, channelsWaiting: 1 },
      [{ wave: "day_22:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "day 27",
      { windowDay: 27 },
      [{ wave: "day_27:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "day 30, the last day",
      { windowDay: 30 },
      [{ wave: "day_30:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "let it close stops day 27",
      { windowDay: 27, decision: "let_close" },
      [
        {
          wave: "day_27:2026-11-13",
          event: "lifecycle_decision_due",
          escalated: true,
          skip: "let_close",
        },
      ],
    ],
    [
      "let it close stops day 30",
      { windowDay: 30, decision: "let_close" },
      [
        {
          wave: "day_30:2026-11-13",
          event: "lifecycle_decision_due",
          escalated: true,
          skip: "let_close",
        },
      ],
    ],
    [
      "let it close does not touch day 22",
      { windowDay: 22, decision: "let_close" },
      [{ wave: "day_22:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "a snooze never mutes an escalation",
      { windowDay: 22, snoozedUntil: new Date(NOW.getTime() + DAY) },
      [{ wave: "day_22:2026-11-13", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "a snooze mutes a routine wave",
      { windowDay: 7, snoozedUntil: new Date(NOW.getTime() + DAY) },
      [{ wave: "day_7", event: "lifecycle_no_progress", escalated: false, skip: "snoozed" }],
    ],
    [
      "a snooze mutes a routine day-22 wave",
      { windowDay: 22, stepsLeft: 1, snoozedUntil: new Date(NOW.getTime() + DAY) },
      [
        {
          wave: "day_22:2026-11-13",
          event: "lifecycle_closing_soon",
          escalated: false,
          skip: "snoozed",
        },
      ],
    ],
    [
      "a clinic waiting on us on day 27 is warned, escalated, snoozed or not",
      {
        stage: "waiting_on_us",
        stageSince: ago(HOUR),
        windowDay: 27,
        snoozedUntil: new Date(NOW.getTime() + DAY),
      },
      [
        {
          wave: "wait_close_27:2026-11-13",
          event: "lifecycle_closing_waiting_on_us",
          escalated: true,
          skip: null,
        },
      ],
    ],
    [
      "and on day 30",
      { stage: "waiting_on_us", stageSince: ago(HOUR), windowDay: 30 },
      [
        {
          wave: "wait_close_30:2026-11-13",
          event: "lifecycle_closing_waiting_on_us",
          escalated: true,
          skip: null,
        },
      ],
    ],
    ["but not on day 26", { stage: "waiting_on_us", stageSince: ago(HOUR), windowDay: 26 }, []],
    [
      "its own key: the in-setup day-27 wave already sent does not stand for it",
      {
        stage: "waiting_on_us",
        stageSince: ago(HOUR),
        windowDay: 28,
        recorded: new Set(["day_27:2026-11-13|slack"]),
      },
      [
        {
          wave: "wait_close_27:2026-11-13",
          event: "lifecycle_closing_waiting_on_us",
          escalated: true,
          skip: null,
        },
      ],
    ],
    [
      "letting it close while stalled does not silence the warning once the clinic waits on us",
      { stage: "waiting_on_us", stageSince: ago(HOUR), windowDay: 30, decision: "let_close" },
      [
        {
          wave: "wait_close_30:2026-11-13",
          event: "lifecycle_closing_waiting_on_us",
          escalated: true,
          skip: null,
        },
      ],
    ],
    [
      "a snooze that has ended mutes nothing",
      { windowDay: 7, snoozedUntil: ago(HOUR) },
      [{ wave: "day_7", event: "lifecycle_no_progress", escalated: false, skip: null }],
    ],
    [
      "a wave already in the ledger is not due again",
      { windowDay: 22, recorded: new Set(["day_22:2026-11-13|slack"]) },
      [],
    ],
    [
      "an extension moves the last day and re-arms day 22",
      { windowDay: 22, lastDay: "2026-11-20", recorded: new Set(["day_22:2026-11-13|slack"]) },
      [{ wave: "day_22:2026-11-20", event: "lifecycle_decision_due", escalated: true, skip: null }],
    ],
    [
      "but not day 7",
      { windowDay: 8, lastDay: "2026-11-20", recorded: new Set(["day_7|slack"]) },
      [],
    ],
    ["live: nothing", { stage: "live" }, []],
    ["closed: nothing", { stage: "closed" }, []],
  ])("%s", (_, facts, expected) => {
    expect(waves(facts)).toEqual(expected);
  });

  test("waiting on us: four hours, then one business day, then two, escalated with the days to give back", () => {
    // Since Friday 15:00 UTC: one business day is Monday 15:00, two is Tuesday.
    const since = new Date("2026-10-16T15:00:00Z");
    const at = (iso: string) =>
      waves({ stage: "waiting_on_us", stageSince: since, now: new Date(iso), windowDay: null });
    expect(at("2026-10-16T18:00:00Z")).toEqual([]);
    expect(at("2026-10-16T19:00:00Z")).toEqual([
      {
        wave: `wait_4h:${since.toISOString()}`,
        event: "lifecycle_waiting_on_us",
        escalated: false,
        skip: null,
      },
    ]);
    // The weekend is not a business day: still the four-hour band on Sunday.
    expect(at("2026-10-18T19:00:00Z")[0]!.wave).toBe(`wait_4h:${since.toISOString()}`);
    expect(at("2026-10-19T15:00:00Z")).toEqual([
      {
        wave: `wait_1bd:${since.toISOString()}`,
        event: "lifecycle_waiting_on_us",
        escalated: false,
        skip: null,
      },
    ]);
    const long = dueWaves({
      ...setup,
      stage: "waiting_on_us",
      stageSince: since,
      now: new Date("2026-10-20T15:00:00Z"),
      windowDay: null,
    });
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({
      wave: `wait_2bd:${since.toISOString()}`,
      event: "lifecycle_waiting_on_us_long",
      escalated: true,
      fields: { waitedDays: 4, recommendation: "extend", extendDays: 4 },
    });
    expect(businessDaysBetween(since, new Date("2026-10-20T15:00:00Z"))).toBe(2);
  });

  test("partly live: day 7 and day 14, only while a channel waits on the clinic", () => {
    const since = ago(8 * DAY);
    expect(
      waves({ stage: "partly_live", stageSince: since, channelsWaiting: 1, windowDay: null }),
    ).toEqual([
      {
        wave: `live_7:${since.toISOString()}`,
        event: "lifecycle_channel_waiting",
        escalated: false,
        skip: null,
      },
    ]);
    expect(
      waves({
        stage: "partly_live",
        stageSince: ago(15 * DAY),
        channelsWaiting: 1,
        windowDay: null,
      })[0]!.wave,
    ).toMatch(/^live_14:/);
    expect(
      waves({ stage: "partly_live", stageSince: since, channelsWaiting: 0, windowDay: null }),
    ).toEqual([]);
  });

  const reminder = (
    n: number,
    outcome: ClinicWave["outcome"],
    sentAt: Date | null,
    queuedAt: Date = sentAt ?? ago(DAY),
    stage: ClinicWave["stage"] = "in_setup",
  ): ClinicWave => ({
    wave: `setup_reminder:${n}`,
    noticeId: `00000000-0000-4000-8000-00000000000${n}`,
    numbered: true,
    sentAt,
    queuedAt,
    stage,
    outcome,
  });

  test("reminders that did not arrive since the last that did escalate once, keyed on that last one", () => {
    const failed = [
      reminder(1, "bounced", ago(DAY)),
      reminder(2, "failed", null),
      reminder(3, "pending", null),
    ];
    const one = dueWaves({ ...setup, windowDay: 6, clinicWaves: failed });
    expect(one.map((w) => [w.wave, w.event, w.escalated, w.noticeId])).toEqual([
      [
        "undelivered:none",
        "lifecycle_reminder_undelivered",
        true,
        "00000000-0000-4000-8000-000000000001",
      ],
    ]);
    // Already raised for that run of failures: nothing more until one arrives.
    expect(
      waves({ windowDay: 6, clinicWaves: failed, recorded: new Set(["undelivered:none|slack"]) }),
    ).toEqual([]);
    // A later reminder that arrived clears them; a failure after it is a new run.
    expect(
      waves({ windowDay: 6, clinicWaves: [...failed, reminder(4, "delivered", ago(HOUR))] }),
    ).toEqual([]);
    expect(
      waves({
        windowDay: 6,
        clinicWaves: [
          ...failed,
          reminder(4, "delivered", ago(2 * HOUR)),
          reminder(5, "bounced", ago(HOUR)),
        ],
      }).map((w) => w.wave),
    ).toEqual(["undelivered:00000000-0000-4000-8000-000000000004"]);
  });

  test("an old failure raises nothing on first switch-on; a recent one escalates whatever stage it was recorded in", () => {
    expect(
      waves({ windowDay: 6, clinicWaves: [reminder(1, "failed", null, ago(15 * DAY))] }),
    ).toEqual([]);
    // Recorded while the clinic had not started; it has since answered a screen.
    expect(
      waves({
        windowDay: 6,
        clinicWaves: [reminder(1, "bounced", ago(DAY), ago(DAY), "not_started")],
      }).map((w) => w.wave),
    ).toEqual(["undelivered:none"]);
  });

  test("the alert, the recommendation and the console count the same current failures", () => {
    const at = (clinicWaves: ClinicWave[]) => {
      const facts = { ...setup, windowDay: 6, clinicWaves };
      const ledger: LedgerWave[] = clinicWaves.map((w) => ({
        id: w.noticeId,
        stage: w.stage,
        wave: w.wave,
        target: "clinic_email",
        noticeId: w.noticeId,
        opsAlertId: null,
        queuedAt: w.queuedAt,
        sentAt: w.sentAt,
        outcome: w.outcome,
        providerId: null,
        escalated: false,
        manualBy: null,
        error: null,
      }));
      const row = {
        clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
        stage: "in_setup" as const,
        stageSince: setup.stageSince,
        stepsLeft: 2,
        channelsWaiting: 0,
        lastProgressAt: setup.lastProgressAt,
        deadlineAt: null,
        lastDay: null,
        snoozedUntil: null,
        snoozedBy: null,
        decision: "none" as const,
        decidedBy: null,
        decidedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return {
        failures: currentFailures(clinicWaves, NOW).length,
        alert: dueWaves(facts).some((w) => w.event === "lifecycle_reminder_undelivered"),
        phone: recommendationFor(facts).action === "phone_the_clinic",
        console: lifecycleView(row, ledger, "America/New_York", NOW).undeliveredCount,
      };
    };
    // A bounce two days ago: all three see it.
    expect(at([reminder(1, "bounced", ago(2 * DAY))])).toEqual({
      failures: 1,
      alert: true,
      phone: true,
      console: 1,
    });
    // An old bounce: none does, so phone_the_clinic is not pinned forever.
    expect(at([reminder(1, "bounced", ago(20 * DAY), ago(20 * DAY))])).toEqual({
      failures: 0,
      alert: false,
      phone: false,
      console: 0,
    });
    // A bounce, then one that arrived: none does.
    expect(at([reminder(1, "bounced", ago(3 * DAY)), reminder(2, "delivered", ago(DAY))])).toEqual({
      failures: 0,
      alert: false,
      phone: false,
      console: 0,
    });
  });

  test("the waiting clinic's closing warning carries the recommendation, not a fixed extend", () => {
    const [wave] = dueWaves({
      ...setup,
      stage: "waiting_on_us",
      stageSince: ago(HOUR),
      windowDay: 28,
      clinicWaves: [reminder(1, "bounced", ago(DAY))],
    }).filter((w) => w.event === "lifecycle_closing_waiting_on_us");
    expect(wave!.fields).toMatchObject({ recommendation: "phone_the_clinic" });
    expect(wave!.fields).not.toHaveProperty("extendDays");
  });

  test("after an extension, a decision is owed again only once the new window's band escalated", () => {
    const deadlineAt = new Date("2026-10-26T04:00:00Z"); // last day 25 October in New York: day 25 on the 20th
    const now = new Date("2026-10-20T16:00:00Z");
    const decidedAt = new Date("2026-10-10T16:00:00Z");
    const row = {
      clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
      stage: "in_setup" as const,
      stageSince: ago(20 * DAY),
      stepsLeft: 3,
      channelsWaiting: 0,
      lastProgressAt: ago(9 * DAY),
      deadlineAt,
      lastDay: "2026-10-25",
      snoozedUntil: null,
      snoozedBy: null,
      decision: "extended" as const,
      decidedBy: "setup deadline extended",
      decidedAt,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const band = (queuedAt: Date): LedgerWave => ({
      id: "x",
      stage: "in_setup",
      wave: "day_22:2026-10-25",
      target: "slack",
      noticeId: null,
      opsAlertId: "y",
      queuedAt,
      sentAt: null,
      outcome: "pending",
      providerId: null,
      escalated: true,
      manualBy: null,
      error: null,
    });
    expect(lifecycleView(row, [], "America/New_York", now).decisionOwed).toBe(false);
    expect(lifecycleView(row, [band(ago(DAY))], "America/New_York", now).decisionOwed).toBe(true);
    expect(
      lifecycleView(
        { ...row, decision: "none", decidedAt: null, decidedBy: null },
        [],
        "America/New_York",
        now,
      ).decisionOwed,
    ).toBe(true);
    expect(
      lifecycleView({ ...row, decision: "let_close" }, [band(ago(DAY))], "America/New_York", now)
        .decisionOwed,
    ).toBe(false);
  });

  test("two reminders delivered in a row with no progress since the first escalate; progress between them does not", () => {
    const pair = [reminder(1, "delivered", ago(11 * DAY)), reminder(2, "delivered", ago(6 * DAY))];
    expect(waves({ windowDay: 6, lastProgressAt: ago(12 * DAY), clinicWaves: pair })).toEqual([
      {
        wave: `unanswered:${ago(12 * DAY).toISOString()}`,
        event: "lifecycle_reminders_unanswered",
        escalated: true,
        skip: null,
      },
    ]);
    expect(waves({ windowDay: 6, lastProgressAt: ago(8 * DAY), clinicWaves: pair })).toEqual([]);
    // A third reminder delivered with still nothing moving raises nothing new.
    const three = [...pair, reminder(3, "delivered", ago(DAY))];
    expect(
      waves({
        windowDay: 6,
        lastProgressAt: ago(12 * DAY),
        clinicWaves: three,
        recorded: new Set([`unanswered:${ago(12 * DAY).toISOString()}|slack`]),
      }),
    ).toEqual([]);
    expect(waves({ windowDay: 6, lastProgressAt: null, clinicWaves: pair })[0]!.wave).toBe(
      "unanswered:never",
    );
    expect(waves({ windowDay: 6, lastProgressAt: ago(12 * DAY), clinicWaves: [pair[0]!] })).toEqual(
      [],
    );
  });

  test("every wave's fields pass the ops alert's allowlist, and Slack keeps the closed words", () => {
    const all = [
      ...dueWaves({ ...setup, windowDay: 22 }),
      ...dueWaves({ ...setup, windowDay: 7 }),
      ...dueWaves({ ...setup, stage: "waiting_on_us", stageSince: ago(5 * DAY), windowDay: null }),
      ...dueWaves({ ...setup, stage: "partly_live", channelsWaiting: 1, windowDay: null }),
      ...dueWaves({ ...setup, stage: "waiting_on_us", stageSince: ago(HOUR), windowDay: 27 }),
    ];
    expect(all.length).toBe(5);
    for (const w of all) {
      const fields = { clinicId: "0c1d2e3f-0000-4000-8000-000000000000", ...w.fields };
      expect(() => assertPayloadAllowed({ event: w.event, ...fields }, "ops_alert")).not.toThrow();
      expect(Object.keys(slackFields(fields)).sort()).toEqual(Object.keys(fields).sort());
    }
  });

  test("Slack opens an escalation with a siren, and a routine wave without", () => {
    const fields = {
      clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
      remainingDays: 8,
      recommendation: "extend",
      decision: "none",
    };
    const escalation = slackText({
      event: "lifecycle_decision_due",
      fields,
      clinicName: "Glow Spa",
    });
    expect(escalation.startsWith(":rotating_light: [app] *A stalled setup closes soon")).toBe(true);
    expect(escalation).toContain("Glow Spa, clinic id");
    expect(escalation).toContain("Recommended: extend");
    expect(
      slackText({ event: "lifecycle_no_progress", fields, clinicName: null }).startsWith("[app] *"),
    ).toBe(true);
    // A word off the closed lists never reaches Slack.
    expect(slackFields({ decision: "call them at home", recommendation: "toString" })).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// The recommendation
// -----------------------------------------------------------------------------

const facts: RecommendFacts = {
  stage: "in_setup",
  stepsLeft: 2,
  remainingDays: 15,
  noProgressDays: 2,
  waitingOnUsDays: 0,
  waitingOnUsBusinessDays: 0,
  partlyLiveDays: 0,
  undeliveredCount: 0,
  answeredAScreen: true,
  decision: "none",
};

describe("the recommendation", () => {
  test.each<[string, Partial<RecommendFacts>, string, number | null, RegExp]>([
    ["closed", { stage: "closed" }, "wait", null, /^The account has ended/],
    ["live", { stage: "live" }, "wait", null, /^Every channel is live/],
    [
      "a reminder did not arrive",
      { undeliveredCount: 1 },
      "phone_the_clinic",
      null,
      /^1 reminder to the clinic's address did not arrive/,
    ],
    [
      "waiting on us two business days",
      { stage: "waiting_on_us", waitingOnUsDays: 4, waitingOnUsBusinessDays: 2 },
      "extend",
      4,
      /waited on us for 4 days/,
    ],
    [
      "waiting on us a day",
      { stage: "waiting_on_us", waitingOnUsDays: 1, waitingOnUsBusinessDays: 1 },
      "wait",
      null,
      /finish our side/,
    ],
    [
      "partly live, a channel waiting a fortnight",
      { stage: "partly_live", partlyLiveDays: 14, stepsLeft: 1 },
      "offer_call",
      null,
      /waited 14 days/,
    ],
    [
      "partly live, early",
      { stage: "partly_live", partlyLiveDays: 3, stepsLeft: 1 },
      "wait",
      null,
      /no longer closes/,
    ],
    [
      "decided to let it close",
      { decision: "let_close", remainingDays: 5 },
      "let_close",
      null,
      /You decided/,
    ],
    ["early, moving", {}, "wait", null, /^Progress 2 days ago, 2 steps left and 15 days to go\.$/],
    ["early, stale", { noProgressDays: 6 }, "offer_call", null, /no progress for 6 days/],
    ["early, never any progress", { noProgressDays: null }, "offer_call", null, /no progress yet/],
    [
      "a week in and no setup screen answered",
      { answeredAScreen: false, remainingDays: 23, noProgressDays: null },
      "phone_the_clinic",
      null,
      /Nobody has answered a setup screen in 7 days/,
    ],
    [
      "late, no setup screen answered: a call, never let it close on that alone",
      { answeredAScreen: false, remainingDays: 8 },
      "phone_the_clinic",
      null,
      /Nobody has answered a setup screen yet and 8 days are left/,
    ],
    [
      "late, already extended and moving",
      { remainingDays: 8, decision: "extended" },
      "wait",
      null,
      /^Already extended/,
    ],
    [
      "late, already extended and stale",
      { remainingDays: 3, noProgressDays: 9, decision: "extended" },
      "phone_the_clinic",
      null,
      /^Already extended, with 2 steps left and no progress for 9 days/,
    ],
    [
      "more time offered, not yet taken",
      { remainingDays: 6, decision: "extension_offered" },
      "wait",
      null,
      /More time was offered: extend the setup window from its Billing page/,
    ],
    [
      "more time offered, and nothing since",
      { remainingDays: 6, noProgressDays: 8, decision: "extension_offered" },
      "phone_the_clinic",
      null,
      /More time was offered and no progress for 8 days/,
    ],
    [
      "waiting on us with three days left: extend by the days it waited",
      { stage: "waiting_on_us", waitingOnUsDays: 1, waitingOnUsBusinessDays: 1, remainingDays: 3 },
      "extend",
      1,
      /^The clinic is waiting on us with 3 days of its window left/,
    ],
    [
      "waiting on us near the end after an extension: says it was extended",
      {
        stage: "waiting_on_us",
        waitingOnUsDays: 2,
        waitingOnUsBusinessDays: 2,
        remainingDays: 2,
        decision: "extended",
      },
      "extend",
      2,
      /^Already extended once, and the clinic is waiting on us/,
    ],
    ["late, one step, moving", { remainingDays: 8, stepsLeft: 1 }, "extend", 7, /7 more days/],
    [
      "late, one step, stale",
      { remainingDays: 8, stepsLeft: 1, noProgressDays: 6 },
      "offer_call",
      null,
      /to finish it/,
    ],
    ["late, two steps, moving", { remainingDays: 8 }, "extend", 14, /14 more days/],
    [
      "late, two steps, stale a week",
      { remainingDays: 3, noProgressDays: 7 },
      "offer_call",
      null,
      /no progress for 7 days/,
    ],
    [
      "late, two steps, stale ten days",
      { remainingDays: 3, noProgressDays: 10 },
      "let_close",
      null,
      /let it close unless they reply/,
    ],
    [
      "late, two steps, never any progress",
      { remainingDays: 3, noProgressDays: null },
      "let_close",
      null,
      /no progress yet/,
    ],
    [
      "the last day, nothing answered",
      { remainingDays: 0, answeredAScreen: false },
      "phone_the_clinic",
      null,
      /0 days are left: phone the clinic/,
    ],
  ])("%s", (_, input, action, days, reason) => {
    const r = recommend({ ...facts, ...input });
    expect(r.action).toBe(action);
    expect(r.days).toBe(days);
    expect(r.reason).toMatch(reason);
    // One sentence of fixed words and numbers.
    expect(r.reason).toMatch(/^[A-Z0-9][^\n]*[.]$/);
    expect(r.reason).not.toMatch(/revenue|collected|recovered/i);
  });
});
