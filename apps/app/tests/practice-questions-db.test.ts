import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { channelsWithAuditPassed } from "@/lib/channels/audit-seam";
import {
  duePracticeRuns,
  runOnePracticeRun,
  sweepPracticeQuestions,
} from "@/lib/engine/practice/job";
import {
  afterPass,
  claimPracticeRun,
  practiceQuestionsGate,
  readPracticeInputs,
  readPracticeState,
  recordPracticeRun,
  requestPracticeQuestions,
  stalledPractice,
} from "@/lib/engine/practice/store";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { runOperation, type Operator } from "@/lib/ops/api";
import { readHomeFacts } from "@/lib/portal/home";
import { saveKnowledge } from "@/lib/portal/knowledge";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { loadSetupState } from "@/lib/setup/state";
import { buildTracker } from "@/lib/setup/tracker";
import { readAccountState } from "@/lib/support/account-reader";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { practiceJudge, practiceModel } from "./setup/practice";

/**
 * The practice questions against the database (plan Part G): a save asks for
 * a run two minutes out and a second save moves the same run on; the job
 * claims one run at a time per clinic, asks the brain (faked here, never
 * Anthropic), and records what it came to; a pass approves the version it
 * read and completes the tracker; a failure on the clinic's own data queues
 * O9; a judge's failure opens a review that ops lists and decides through the
 * envelope, about that run's own cases at the version they read and nothing
 * else; an override the retired script approval wrote is not a run of the
 * questions; the gate never holds a live channel; and the runtime role can
 * delete none of it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
// Each test provisions a clinic and runs the questions end to end; the back-off
// test alone took five seconds on a quiet machine, vitest's default limit.
const DB_TEST_OPTIONS = { timeout: 120_000 };
const ACTOR = { type: "service", serviceName: "practice-questions-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const CALENDAR = { status: "not_connected", accessRemovedAt: null } as const;

let clinic: PortalClinic;

function ctx(): SaveContext {
  return {
    clinicId: clinic.clinicId,
    slug: clinic.clinicSlug,
    userId: clinic.userId,
    actorLabel: "Front desk Mac",
  };
}

const model = practiceModel;
const judge = practiceJudge;

async function setAnswers(price = 199): Promise<void> {
  expect(
    await saveSetupScreen(ctx(), "services", {
      services: [
        { name: "Signature facial", priceKind: "exact", price, durationMinutes: 60 },
        { name: "Consultation", priceKind: null },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await saveSetupScreen(ctx(), "hours", {
      hours: {
        sun: [],
        mon: [["09:00", "17:00"]],
        tue: [["09:00", "17:00"]],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closures: [],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await saveSetupScreen(ctx(), "question", {
      question: "Is there parking?",
      answer: "Free parking behind the building.",
    }),
  ).toMatchObject({ ok: true });
  // The number the urgent line gives: with phone bought, the direct line.
  expect(
    await saveSetupScreen(ctx(), "direct_line", { directLine: "(415) 555-0123" }),
  ).toMatchObject({ ok: true });
}

async function runs(): Promise<Record<string, unknown>[]> {
  return inTenant(
    clinic.clinicId,
    async (c) => (await c.query(`select * from practice_question_runs order by requested_at`)).rows,
  );
}

/** The clinic's audit inputs as recorded: channel, how, by whom. */
async function auditRows(): Promise<Record<string, unknown>[]> {
  return inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query(
          `select channel, actor, detail->>'via' as via from channel_events where kind = 'audit_passed' order by channel`,
        )
      ).rows,
  );
}

/** What `live` reads as the channels whose audit has passed. */
async function auditPassed(): Promise<string[]> {
  return [
    ...(await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      channelsWithAuditPassed(tx.db, tx.clinicId),
    )),
  ].sort();
}

/** The clinic's queued run, made due now. */
async function dueQueued(): Promise<string> {
  const rows = await inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query<{ id: string }>(
          `update practice_question_runs set run_after = now() - interval '1 second' where status = 'queued' returning id`,
        )
      ).rows,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

describeDb("the practice questions, against the database", DB_TEST_OPTIONS, () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // Warm the module graph outside any test's clock.
    await import("@/lib/ops/api");
  }, 300_000);

  afterAll(async () => {
    await closePools();
  });

  beforeEach(async () => {
    clinic = await provisionPortalClinic("pq", { plan: "voice-webchat-1000-1000" });
  }, 120_000);

  test("a Knowledge save asks for a run two minutes out, and the next save moves the same run on", async () => {
    const now = new Date();
    expect(
      await saveKnowledge(
        { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac" },
        "policies",
        { policies: ["Cancel 24 hours ahead."] },
        now,
      ),
    ).toMatchObject({ ok: true });
    let rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "queued",
      reason: "knowledge",
      trigger_section: "policies",
    });
    expect((rows[0]!.run_after as Date).getTime()).toBe(now.getTime() + 120_000);

    const later = new Date(now.getTime() + 60_000);
    await saveKnowledge(
      { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac" },
      "promotions",
      { promotions: "Ten percent off in May." },
      later,
    );
    rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", trigger_section: "promotions" });
    expect((rows[0]!.run_after as Date).getTime()).toBe(later.getTime() + 120_000);
  });

  test("a setup screen and a Settings change that the cases read ask for a run; nothing is asked of the model before the answers are set up", async () => {
    await saveSetupScreen(ctx(), "question", {
      question: "Is there parking?",
      answer: "Behind the building.",
    });
    expect((await runs())[0]).toMatchObject({
      status: "queued",
      reason: "wizard",
      trigger_section: "quick_answers",
    });
    const runId = await dueQueued();
    const brain = model();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: brain,
        metaResponder: null,
        judge: judge("pass"),
      }),
    ).toBe("not_ready");
    expect(brain.calls).toBe(0);
    expect((await runs())[0]).toMatchObject({ status: "not_ready" });
  });

  test("a pass approves the version it read, completes the tracker's last two stages, and queues O8 once Talk to your AYA exists", async () => {
    await setAnswers();
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update entitlements set first_paid_at = coalesce(first_paid_at, now())`),
    );
    const runId = await dueQueued();
    const due = await duePracticeRuns(50);
    expect(due).toContainEqual({ clinicId: clinic.clinicId, id: runId });

    const brain = model();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: brain,
        metaResponder: null,
        judge: judge("pass"),
        talkToAyaBuilt: true,
      }),
    ).toBe("passed");
    expect(brain.calls).toBeGreaterThan(0);

    const [agent] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (await c.query(`select version, approved_at, approved_by_label from agent_configs`)).rows,
    );
    expect(agent!.approved_at).toBeInstanceOf(Date);
    expect(agent!.approved_by_label).toBe(`the practice questions (run ${runId})`);
    const [run] = await runs();
    expect(run).toMatchObject({
      status: "passed",
      approved_version: agent!.version,
      agent_version: agent!.version,
    });
    const results = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select channel, status, reused from practice_question_results where run_id = $1 order by channel`,
            [runId],
          )
        ).rows,
    );
    expect(results).toEqual([
      { channel: "voice", status: "passed", reused: false },
      { channel: "web", status: "passed", reused: false },
    ]);

    const state = await loadSetupState({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: ACTOR,
    });
    const practice = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeState(tx),
    );
    const tracker = buildTracker(state!, CALENDAR, practice);
    expect(
      tracker.stages
        .filter((s) => s.id === "built" || s.id === "practice_questions")
        .map((s) => s.state),
    ).toEqual(["done", "done"]);
    expect(tracker.previewUnlocked).toBe(true);
    const notices = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select kind, dedupe_key, payload from billing_notices where kind = 'assistant_ready'`,
          )
        ).rows,
    );
    expect(notices).toEqual([
      {
        kind: "assistant_ready",
        dedupe_key: "assistant_ready",
        payload: { homeUrl: expect.stringMatching(new RegExp(`/c/${clinic.clinicSlug}$`)) },
      },
    ]);

    // Nothing changed: the next run reuses each channel's pass and asks the model nothing.
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      requestPracticeQuestions(tx, { reason: "ops" }),
    );
    const again = await dueQueued();
    const quiet = model();
    expect(
      await runOnePracticeRun(clinic.clinicId, again, {
        responder: quiet,
        metaResponder: null,
        judge: judge("pass"),
      }),
    ).toBe("passed");
    expect(quiet.calls).toBe(0);
    const reused = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select bool_and(reused) as all from practice_question_results where run_id = $1`,
            [again],
          )
        ).rows[0],
    );
    expect(reused).toEqual({ all: true });
  });

  test("a pass reads the same everywhere: the tracker's last two stages are done on Home, in the support chat's get_account_state and on the console's clinic cards", async () => {
    await setAnswers();
    const stages = (rows: { id?: string; code?: string; state?: string; status?: string }[]) =>
      rows
        .map((r) => [r.id ?? r.code, r.state ?? r.status])
        .filter(([id]) => id === "built" || id === "practice_questions");
    // Each of the three, as its reader reads the clinic.
    const home = async () => {
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: ACTOR,
      });
      const facts = await readHomeFacts({
        clinicId: clinic.clinicId,
        address: state!.address,
        actor: ACTOR,
        channels: state!.channels,
      });
      const calendar = await getCalendarConnection(clinic.clinicId, { actor: ACTOR });
      return stages(
        buildTracker(state!, calendar, facts.practice, facts.goLive ?? undefined).stages,
      );
    };
    const support = async () =>
      stages(
        (await readAccountState({
          clinicId: clinic.clinicId,
          userId: clinic.userId,
          actor: ACTOR,
        }))!.account.stageRows,
      );
    const cards = async () => {
      const outcome = await runOperation("listClinicCards", {}, OPERATOR);
      const card = (
        outcome.body as {
          data: {
            cards: {
              id: string;
              tracker: { id: string; state: string }[];
              trackerLeft: string[];
            }[];
          };
        }
      ).data.cards.find((c) => c.id === clinic.clinicId)!;
      expect(card.trackerLeft.includes("Practice questions passed")).toBe(
        card.tracker.find((s) => s.id === "practice_questions")!.state !== "done",
      );
      return stages(card.tracker);
    };
    const NOT_YET = [
      ["built", "not_done"],
      ["practice_questions", "not_done"],
    ];
    expect([await home(), await support(), await cards()]).toEqual([NOT_YET, NOT_YET, NOT_YET]);

    const runId = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: model(),
        metaResponder: null,
        judge: judge("pass"),
      }),
    ).toBe("passed");
    const DONE = [
      ["built", "done"],
      ["practice_questions", "done"],
    ];
    expect([await home(), await support(), await cards()]).toEqual([DONE, DONE, DONE]);
  });

  test("a wrong price the clinic's own answer states queues O9, naming the section and a count, tells ops, and approves nothing", async () => {
    await setAnswers();
    await saveSetupScreen(ctx(), "question", {
      question: "Any offers?",
      answer: "Signature facial is $149 this month.",
    });
    const runId = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: model("$149"),
        metaResponder: null,
        judge: judge("pass"),
      }),
    ).toBe("failed");
    expect((await runs())[0]).toMatchObject({
      status: "failed",
      failed_section: "quick_answers",
      failed_count: 1,
    });
    const [agent] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select approved_at from agent_configs`)).rows,
    );
    expect(agent!.approved_at).toBeNull();
    const notices = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select kind, payload from billing_notices where kind = 'practice_questions_failed'`,
          )
        ).rows,
    );
    expect(notices).toEqual([
      {
        kind: "practice_questions_failed",
        payload: {
          section: "quick_answers",
          count: 1,
          fixUrl: expect.stringMatching(
            new RegExp(`/c/${clinic.clinicSlug}/knowledge#quick-answers$`),
          ),
        },
      },
    ]);
    const alerts = (
      await getMigratorPool().query(
        `select fields from ops_alerts where event = 'practice_question_failed' and fields->>'runId' = $1`,
        [runId],
      )
    ).rows;
    expect(alerts).toEqual([
      {
        fields: expect.objectContaining({
          clinicId: clinic.clinicId,
          outcome: "failed",
          section: "quick_answers",
        }),
      },
    ]);

    const state = await loadSetupState({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: ACTOR,
    });
    const practice = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeState(tx),
    );
    expect(
      buildTracker(state!, CALENDAR, practice).stages.find((s) => s.id === "practice_questions")!
        .detail,
    ).toBe(
      "One thing to fix: 1 answer in Your practice → Quick answers. Fix it there and she answers them again.",
    );
  });

  test("a judge's failure opens a review due the next business day; ops lists it and passes it through the envelope, which approves the script", async () => {
    await setAnswers();
    const runId = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: model(),
        metaResponder: null,
        judge: judge("fail"),
      }),
    ).toBe("in_review");
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select id, status, due_on::text as due_on from audit_review_queue where run_id = $1`,
            [runId],
          )
        ).rows,
    );
    expect(review).toMatchObject({
      status: "open",
      due_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    const state = await loadSetupState({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: ACTOR,
    });
    const practice = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeState(tx),
    );
    expect(
      buildTracker(state!, CALENDAR, practice).stages.find((s) => s.id === "practice_questions")!
        .detail,
    ).toMatch(
      /^Being checked by our team; ready by (Monday|Tuesday|Wednesday|Thursday|Friday) \d{1,2} [A-Z][a-z]+\.$/,
    );

    const listed = await runOperation("listPracticeReviews", {}, OPERATOR);
    const reviews = (
      listed.body as {
        data: {
          reviews: {
            id: string;
            clinicSlug: string;
            cases: { id: string; status: string; answered: string[] }[];
          }[];
        };
      }
    ).data.reviews;
    const mine = reviews.find((r) => r.id === review!.id)!;
    expect(mine.clinicSlug).toBe(clinic.clinicSlug);
    // The judge failed every answer it read: the hostile and unknown ones on both channels at least.
    expect(mine.cases.filter((c) => c.id === "hostile" || c.id === "unknown")).toHaveLength(4);
    expect(mine.cases.every((c) => c.status === "review" && c.answered.length === 1)).toBe(true);

    const refused = await runOperation(
      "decidePracticeReview",
      { clinicId: clinic.clinicId, reviewId: review!.id, decision: "pass", section: "prices" },
      OPERATOR,
    );
    expect((refused.body as { data: { status: string } }).data.status).toBe("refused");
    const decided = await runOperation(
      "decidePracticeReview",
      { clinicId: clinic.clinicId, reviewId: review!.id, decision: "pass" },
      OPERATOR,
    );
    expect((decided.body as { data: unknown }).data).toMatchObject({
      status: "updated",
      decision: "pass",
      auditRecorded: true,
    });
    expect((await runs())[0]).toMatchObject({ status: "passed" });
    const [agent] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select approved_at from agent_configs`)).rows,
    );
    expect(agent!.approved_at).toBeInstanceOf(Date);
    const again = await runOperation(
      "decidePracticeReview",
      { clinicId: clinic.clinicId, reviewId: review!.id, decision: "fail" },
      OPERATOR,
    );
    expect((again.body as { data: { status: string } }).data.status).toBe("refused");
  });

  test("a review still open past its day alerts ops once", async () => {
    await setAnswers();
    const runId = await dueQueued();
    await runOnePracticeRun(clinic.clinicId, runId, {
      responder: model(),
      metaResponder: null,
      judge: judge("fail"),
    });
    const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const first = await sweepPracticeQuestions({ now: later });
    expect(first.pastDue).toBeGreaterThanOrEqual(1);
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query(
            `select id, past_due_alerted_at from audit_review_queue where run_id = $1`,
            [runId],
          )
        ).rows,
    );
    expect(review!.past_due_alerted_at).toBeInstanceOf(Date);
    const alerts = (
      await getMigratorPool().query(
        `select count(*)::int as n from ops_alerts where event = 'practice_question_review_past_due' and fields->>'reviewId' = $1`,
        [review!.id],
      )
    ).rows[0];
    expect(alerts).toEqual({ n: 1 });
    await sweepPracticeQuestions({ now: later });
    expect(
      (
        await getMigratorPool().query(
          `select count(*)::int as n from ops_alerts where event = 'practice_question_review_past_due' and fields->>'reviewId' = $1`,
          [review!.id],
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  test("one run at a time per clinic, and a run whose inputs changed while it ran is superseded, leaving the queued one to decide", async () => {
    await setAnswers();
    const first = await dueQueued();
    const now = new Date();
    const claimed = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      claimPracticeRun(tx, first, now),
    );
    expect(claimed).toMatchObject({ status: "running", attempts: 1 });
    const read = (await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeInputs(tx, now),
    ))!;

    // The clinic changes a price while it runs: a second run is queued, and cannot be claimed while the first runs.
    await saveSetupScreen(ctx(), "services", {
      services: [{ name: "Signature facial", priceKind: "exact", price: 209, durationMinutes: 60 }],
    });
    const second = await dueQueued();
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        claimPracticeRun(tx, second, new Date()),
      ),
    ).toBeNull();

    const recorded = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      recordPracticeRun(tx, {
        run: claimed!,
        read,
        outcomes: read.channels.map((c) => ({
          channel: c.channel,
          inputVersion: read.channelVersions[c.channel]!,
          status: "passed" as const,
          cases: [],
        })),
        now,
      }),
    );
    expect(recorded.status).toBe("superseded");
    const [agent] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select approved_at from agent_configs`)).rows,
    );
    expect(agent!.approved_at).toBeNull();
    expect((await runs()).map((r) => r.status)).toEqual(["superseded", "queued"]);
    // The change that superseded it already asked for a run, which is left as it was: still due.
    expect((await runs())[1]).toMatchObject({ id: second, status: "queued" });
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        claimPracticeRun(tx, second, new Date()),
      ),
    ).toMatchObject({ status: "running" });
  });

  test("the gate holds a channel that has not gone live until the latest run passed, and never holds one that is live", async () => {
    const gate = (channel: "web" | "voice") =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        practiceQuestionsGate(tx, channel),
      );
    expect(await gate("web")).toEqual({ open: false, why: "not_run" });
    await setAnswers();
    expect(await gate("web")).toEqual({ open: false, why: "pending" });
    const runId = await dueQueued();
    await runOnePracticeRun(clinic.clinicId, runId, {
      responder: model("$149"),
      metaResponder: null,
      judge: judge("pass"),
    });
    expect(await gate("web")).toEqual({ open: false, why: "in_review" });
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update clinic_channels set ready_at = now(), live_at = now() where channel = 'voice'`,
      ),
    );
    expect(await gate("voice")).toEqual({ open: true, why: "live" });
  });

  test("an override the retired script approval wrote is not a run of the questions: the tracker, the gate and the sweep read past it", async () => {
    await setAnswers();
    // Nothing waits: the run the answers asked for is out of the way.
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update practice_question_runs set status = 'superseded', finished_at = now() where status = 'queued'`,
      ),
    );
    // What ops approveAgentConfig wrote until 19 October 2026: a passed run
    // with the operator's label, the inputs as they stand, and no cases.
    const read = (await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeInputs(tx),
    ))!;
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `insert into practice_question_runs (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, input_version, override_label)
         values ($1, 'passed', 'override', now(), now(), now(), now(), $2, 'Laura Owner (recorded by ops@healdesk.test)')`,
        [clinic.clinicId, read.inputVersion],
      ),
    );
    const practice = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeState(tx),
    );
    expect(practice).toEqual({ pending: false, latest: null });
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        practiceQuestionsGate(tx, "web"),
      ),
    ).toEqual({ open: false, why: "not_run" });
    const state = await loadSetupState({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: ACTOR,
    });
    expect(
      buildTracker(state!, CALENDAR, practice)
        .stages.filter((s) => s.id === "built" || s.id === "practice_questions")
        .map((s) => s.state),
    ).toEqual(["not_done", "not_done"]);
    // The sweep asks the questions themselves, as for a clinic never asked.
    await sweepPracticeQuestions({ now: new Date() });
    expect((await runs()).filter((r) => r.status === "queued")).toMatchObject([
      { reason: "sweep" },
    ]);
  });

  test("a run left in review with its review gone, as the retired script approval left one, is asked again by the sweep, once", async () => {
    await setAnswers();
    const runId = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: model(),
        metaResponder: null,
        judge: judge("fail"),
      }),
    ).toBe("in_review");
    // What "Record approval" did until 19 October 2026: superseded the open
    // review and recorded an override run, which counts for nothing now.
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update audit_review_queue set status = 'superseded' where run_id = $1`, [
        runId,
      ]);
      await c.query(
        `insert into practice_question_runs (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, override_label)
         values ($1, 'passed', 'override', now(), now(), now(), clock_timestamp(), 'Laura Owner (recorded by ops@healdesk.test)')`,
        [clinic.clinicId],
      );
    });
    const gate = () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        practiceQuestionsGate(tx, "web"),
      );
    expect(await gate()).toEqual({ open: false, why: "in_review" });
    // No one can decide it: the queue hides a superseded review, and refuses it.
    const listed = (
      (await runOperation("listPracticeReviews", {}, OPERATOR)).body as {
        data: { reviews: { runId: string }[] };
      }
    ).data.reviews;
    expect(listed.filter((r) => r.runId === runId)).toEqual([]);

    // The inputs are the same, so only the stalled run makes the sweep ask.
    await sweepPracticeQuestions({ now: new Date() });
    expect((await runs()).filter((r) => r.status === "queued")).toMatchObject([
      { reason: "sweep" },
    ]);
    await sweepPracticeQuestions({ now: new Date() });
    expect((await runs()).filter((r) => r.status === "queued")).toHaveLength(1);
    const again = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, again, {
        responder: model(),
        metaResponder: null,
        judge: judge("pass"),
      }),
    ).toBe("passed");
    expect(await gate()).toEqual({ open: true, why: "passed" });
  });

  test("a run that could not reach the model after all its attempts is asked again after its back-off, and ops is told once after three in a row", async () => {
    await setAnswers();
    const unreachable: typeof judge = () => async () => {
      throw new Error("unreachable");
    };
    /** The clinic's queued run, tried until it gives up: three attempts, as the job's retries would. */
    const errorOut = async (): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const id = await dueQueued();
        const status = await runOnePracticeRun(clinic.clinicId, id, {
          responder: model(),
          metaResponder: null,
          judge: unreachable("fail"),
        });
        expect(status, `attempt ${attempt}`).toBe(attempt < 3 ? "queued" : "error");
      }
    };
    const queued = async () => (await runs()).filter((r) => r.status === "queued");
    const alerts = async () =>
      (
        await getMigratorPool().query<{ n: number }>(
          `select count(*)::int as n from ops_alerts
            where event = 'practice_question_failed' and fields->>'clinicId' = $1 and fields->>'outcome' = 'errors_in_a_row'`,
          [clinic.clinicId],
        )
      ).rows[0]!.n;
    const hours = (n: number) => new Date(Date.now() + n * 60 * 60_000);

    await errorOut();
    // An error opens no review; Home says she answers them again shortly, and the sweep sees to it.
    const [none] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select count(*)::int as n from audit_review_queue`)).rows,
    );
    expect(none).toEqual({ n: 0 });
    await sweepPracticeQuestions({ now: new Date() });
    expect(await queued()).toEqual([]);
    await sweepPracticeQuestions({ now: hours(1.1) });
    expect(await queued()).toMatchObject([{ reason: "sweep" }]);

    // The second in a row: six hours.
    await errorOut();
    await sweepPracticeQuestions({ now: hours(1.1) });
    expect(await queued()).toEqual([]);
    await sweepPracticeQuestions({ now: hours(6.1) });
    expect(await queued()).toHaveLength(1);
    expect(await alerts()).toBe(0);

    // The third: a day, and ops is told, once for the streak.
    await errorOut();
    await sweepPracticeQuestions({ now: hours(6.1) });
    expect(await queued()).toEqual([]);
    expect(await alerts()).toBe(1);
    await sweepPracticeQuestions({ now: hours(12) });
    expect(await alerts()).toBe(1);
    await sweepPracticeQuestions({ now: hours(24.1) });
    expect(await queued()).toHaveLength(1);
    // Each errored run's own alert went once, for the streak's first: the
    // re-asks after it are the sweep's to escalate, not three more emails.
    const perRun = (
      await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from ops_alerts
          where event = 'practice_question_failed' and fields->>'clinicId' = $1 and fields->>'outcome' = 'error'`,
        [clinic.clinicId],
      )
    ).rows[0]!.n;
    expect(perRun).toBe(1);
  });

  test("a streak longer than any window is counted from its start, and its alert goes once however long it runs", async () => {
    await setAnswers();
    // The run the answers asked for, out of the way and long before the streak.
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update practice_question_runs
            set status = 'superseded', requested_at = now() - interval '200 days', finished_at = now() - interval '200 days'
          where status = 'queued'`,
      ),
    );
    const read = (await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeInputs(tx),
    ))!;
    // 55 runs that could not reach the model, a day apart, the latest a minute ago.
    const errored = (n: number, since: string) =>
      inTenant(clinic.clinicId, (c) =>
        c.query(
          `insert into practice_question_runs (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, attempts, input_version, last_error)
           select $1, 'error', 'sweep', t, t, t, t, 3, $2, 'model_unreachable'
             from (select now() - $4::interval - (g || ' days')::interval as t from generate_series(0, $3 - 1) g) s`,
          [clinic.clinicId, read.inputVersion, n, since],
        ),
      );
    await errored(55, "1 minute");
    const streak = async () =>
      (
        await getMigratorPool().query<{ count: string }>(
          `select fields->>'count' as count from ops_alerts
            where event = 'practice_question_failed' and fields->>'clinicId' = $1 and fields->>'outcome' = 'errors_in_a_row'`,
          [clinic.clinicId],
        )
      ).rows;
    await sweepPracticeQuestions({ now: new Date() });
    expect(await streak()).toEqual([{ count: "55" }]);
    // One more errored run: the same streak, so no second alert.
    await errored(1, "0 seconds");
    await sweepPracticeQuestions({ now: new Date() });
    expect(await streak()).toEqual([{ count: "55" }]);
    const stalled = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      stalledPractice(tx),
    );
    expect(stalled).toMatchObject({ kind: "error", errorsInARow: 56 });
  });

  test("an operator's pass on a run that a later errored run left behind opens the gate on the next run, which asks the model nothing and opens no second review", async () => {
    await setAnswers();
    const flagged = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, flagged, {
        responder: model(),
        metaResponder: null,
        judge: judge("fail"),
      }),
    ).toBe("in_review");
    // A later run at the same inputs that cannot reach the model: an errored
    // run supersedes no review, so the flagged run's stays open.
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      requestPracticeQuestions(tx, { reason: "sweep" }),
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const id = await dueQueued();
      await runOnePracticeRun(clinic.clinicId, id, {
        responder: model(),
        metaResponder: null,
        judge: async () => {
          throw new Error("unreachable");
        },
      });
    }
    const gate = () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        practiceQuestionsGate(tx, "web"),
      );
    expect(await gate()).toEqual({ open: false, why: "error" });
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ id: string }>(`select id from audit_review_queue where run_id = $1`, [
            flagged,
          ])
        ).rows,
    );
    expect(
      (
        (
          await runOperation(
            "decidePracticeReview",
            { clinicId: clinic.clinicId, reviewId: review!.id, decision: "pass" },
            OPERATOR,
          )
        ).body as { data: { status: string } }
      ).data.status,
    ).toBe("updated");
    // The errored run is still the latest, so the pass asks again at once.
    expect((await runs()).filter((r) => r.status === "queued")).toMatchObject([{ reason: "ops" }]);
    const quiet = model();
    expect(
      await runOnePracticeRun(clinic.clinicId, await dueQueued(), {
        responder: quiet,
        metaResponder: null,
        judge: judge("fail"),
      }),
    ).toBe("passed");
    expect(quiet.calls).toBe(0);
    expect(await gate()).toEqual({ open: true, why: "passed" });
    const [reviews] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select count(*)::int as n from audit_review_queue`)).rows,
    );
    expect(reviews).toEqual({ n: 1 });
  });

  test("the questions are not asked again over a run waiting in Reviews; once it is decided they are, and the reply says whether the job is on", async () => {
    await setAnswers();
    const flagged = await dueQueued();
    await runOnePracticeRun(clinic.clinicId, flagged, {
      responder: model(),
      metaResponder: null,
      judge: judge("fail"),
    });
    const rerun = async () =>
      (
        (await runOperation("rerunPracticeQuestions", { clinicId: clinic.clinicId }, OPERATOR))
          .body as { data: Record<string, unknown> }
      ).data;
    expect(await rerun()).toEqual({
      status: "refused",
      message: expect.stringMatching(
        /^A run of the practice questions waits in Reviews: decide it there\./,
      ),
    });
    expect((await runs()).filter((r) => r.status === "queued")).toEqual([]);
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ id: string; status: string }>(
            `select id, status from audit_review_queue where run_id = $1`,
            [flagged],
          )
        ).rows,
    );
    expect(review!.status).toBe("open");
    // Failed in Reviews with no section (our side to put right): asking again is allowed.
    await runOperation(
      "decidePracticeReview",
      { clinicId: clinic.clinicId, reviewId: review!.id, decision: "fail" },
      OPERATOR,
    );
    // The job ships off (drizzle/0080), and the reply says so.
    expect(await rerun()).toEqual({ status: "updated", auditRecorded: true, jobEnabled: false });
    expect((await runs()).filter((r) => r.status === "queued")).toMatchObject([{ reason: "ops" }]);
    await getMigratorPool().query(
      `update scheduled_jobs set enabled = true where name = 'practice-questions'`,
    );
    try {
      expect(await rerun()).toMatchObject({ status: "updated", jobEnabled: true });
    } finally {
      await getMigratorPool().query(
        `update scheduled_jobs set enabled = false where name = 'practice-questions'`,
      );
    }
  });

  test("a review's decision is about its own run: refused once what the questions read has changed, which asks for the run that replaces it", async () => {
    await setAnswers();
    const runId = await dueQueued();
    expect(
      await runOnePracticeRun(clinic.clinicId, runId, {
        responder: model(),
        metaResponder: null,
        judge: judge("fail"),
      }),
    ).toBe("in_review");
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ id: string }>(`select id from audit_review_queue where run_id = $1`, [
            runId,
          ])
        ).rows,
    );
    const decide = async (decision: "pass" | "fail") =>
      (
        (
          await runOperation(
            "decidePracticeReview",
            { clinicId: clinic.clinicId, reviewId: review!.id, decision },
            OPERATOR,
          )
        ).body as { data: { status: string; message?: string } }
      ).data;

    // The clinic changes a policy the cases read, and that change asks for a run.
    await saveKnowledge(
      { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac" },
      "policies",
      { policies: ["Cancel 48 hours ahead."] },
      new Date(),
    );
    for (const decision of ["pass", "fail"] as const) {
      expect(await decide(decision)).toEqual({
        status: "refused",
        message: expect.stringMatching(
          /^What the practice questions read has changed since this run/,
        ),
      });
    }
    expect((await runs()).filter((r) => r.status === "queued")).toHaveLength(1);
    // With nothing asked for (a writer that does not ask), the refusal asks.
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update practice_question_runs set status = 'superseded', finished_at = now() where status = 'queued'`,
      ),
    );
    expect((await decide("pass")).status).toBe("refused");
    expect((await runs()).filter((r) => r.status === "queued")).toMatchObject([{ reason: "ops" }]);

    // Nothing was passed, approved or recorded.
    expect((await runs()).find((r) => r.id === runId)).toMatchObject({ status: "in_review" });
    const [agent] = await inTenant(
      clinic.clinicId,
      async (c) => (await c.query(`select approved_at from agent_configs`)).rows,
    );
    expect(agent!.approved_at).toBeNull();
    expect(await auditRows()).toEqual([]);
    const [open] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (await c.query(`select status from audit_review_queue where id = $1`, [review!.id])).rows,
    );
    expect(open).toEqual({ status: "open" });
  });

  test("a review's decision needs a flagged run with its cases; a pass is never written without its run's audit-input version", async () => {
    await setAnswers();
    const runId = await dueQueued();
    await runOnePracticeRun(clinic.clinicId, runId, {
      responder: model(),
      metaResponder: null,
      judge: judge("fail"),
    });
    const [review] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ id: string }>(`select id from audit_review_queue where run_id = $1`, [
            runId,
          ])
        ).rows,
    );
    const decide = async () =>
      (
        (
          await runOperation(
            "decidePracticeReview",
            { clinicId: clinic.clinicId, reviewId: review!.id, decision: "pass" },
            OPERATOR,
          )
        ).body as { data: { status: string; message?: string } }
      ).data;
    // A run that is not waiting on its review is not passed by it.
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update practice_question_runs set status = 'error' where id = $1`, [runId]),
    );
    expect(await decide()).toEqual({
      status: "refused",
      message: "The run this review is about is no longer waiting on a review.",
    });
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update practice_question_runs set status = 'in_review' where id = $1`, [runId]),
    );
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        afterPass(tx, {
          runId,
          inputVersion: null,
          agentVersion: null,
          slug: clinic.clinicSlug,
          channels: ["web"],
          now: new Date(),
        }).then(
          () => "recorded",
          (error: Error) => error.message,
        ),
      ),
    ).toBe("A pass of the practice questions needs its run and its audit-input version.");
    expect(await auditRows()).toEqual([]);
    // The flagged run's own cases, at its version: the pass records each channel's audit by the questions.
    expect((await decide()).status).toBe("updated");
    expect(await auditRows()).toEqual([
      { channel: "voice", actor: "system", via: "practice_questions" },
      { channel: "web", actor: "system", via: "practice_questions" },
    ]);
    expect(await auditPassed()).toEqual(["voice", "web"]);
  });

  test("the runtime role can delete no run, result or review, nor rewrite who an override names", async () => {
    await setAnswers();
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [clinic.clinicId]);
      await expect(client.query(`delete from practice_question_runs`)).rejects.toThrow(
        /permission denied/,
      );
      await client.query("rollback");
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [clinic.clinicId]);
      await expect(
        client.query(`update practice_question_runs set override_label = 'someone else'`),
      ).rejects.toThrow(/permission denied/);
      await client.query("rollback");
      for (const table of ["practice_question_results", "audit_review_queue"]) {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [clinic.clinicId]);
        await expect(client.query(`delete from ${table}`)).rejects.toThrow(/permission denied/);
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });
});

describeDb(
  "the practice questions as the channel's audit input (lib/channels/audit-seam.ts)",
  DB_TEST_OPTIONS,
  () => {
    beforeAll(async () => {
      await runMigrations();
    }, 300_000);

    afterAll(async () => {
      await closePools();
    });

    beforeEach(async () => {
      clinic = await provisionPortalClinic("pq-seam", { plan: "voice-webchat-1000-1000" });
    }, 120_000);

    test("a pass records each channel's audit once, by the questions; a later failure holds back a channel not yet live, never a live one", async () => {
      await setAnswers();
      expect(await auditPassed()).toEqual([]);
      const first = await dueQueued();
      expect(
        await runOnePracticeRun(clinic.clinicId, first, {
          responder: model(),
          metaResponder: null,
          judge: judge("pass"),
        }),
      ).toBe("passed");
      expect(await auditRows()).toEqual([
        { channel: "voice", actor: "system", via: "practice_questions" },
        { channel: "web", actor: "system", via: "practice_questions" },
      ]);
      expect(await auditPassed()).toEqual(["voice", "web"]);

      // A change: until it is checked, neither channel's audit counts.
      await saveSetupScreen(ctx(), "question", {
        question: "Any offers?",
        answer: "Signature facial is $149 this month.",
      });
      expect(await auditPassed()).toEqual([]);
      const second = await dueQueued();
      expect(
        await runOnePracticeRun(clinic.clinicId, second, {
          responder: model("$149"),
          metaResponder: null,
          judge: judge("pass"),
        }),
      ).toBe("failed");
      // Failed: the record stays, once, and the channels wait for a pass.
      expect(await auditRows()).toHaveLength(2);
      expect(await auditPassed()).toEqual([]);
      // A channel already live is never held back by it.
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_channels set ready_at = now(), live_at = now() where channel = 'voice'`,
        ),
      );
      expect(await auditPassed()).toEqual(["voice"]);
    });

    test("what the retired attestation wrote passes nothing by itself: the channel counts once the questions pass it", async () => {
      await setAnswers();
      // What ops attestChannelAudit and approveAgentConfig wrote until 19 October 2026.
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `insert into channel_events (clinic_id, channel, kind, actor, detail)
           values ($1, 'voice', 'audit_passed', 'ops', '{"via":"ops_attested"}'),
                  ($1, 'web', 'audit_passed', 'ops', '{"via":"ops_attested"}')`,
          [clinic.clinicId],
        ),
      );
      expect(await auditPassed()).toEqual([]);
      const run = await dueQueued();
      expect(
        await runOnePracticeRun(clinic.clinicId, run, {
          responder: model(),
          metaResponder: null,
          judge: judge("pass"),
        }),
      ).toBe("passed");
      // One record per channel: the old one stands, and the pass is what counts.
      expect(await auditRows()).toEqual([
        { channel: "voice", actor: "ops", via: "ops_attested" },
        { channel: "web", actor: "ops", via: "ops_attested" },
      ]);
      expect(await auditPassed()).toEqual(["voice", "web"]);
      await saveSetupScreen(ctx(), "question", {
        question: "Any offers?",
        answer: "Ten percent off in May.",
      });
      expect(await auditPassed()).toEqual([]);
    });
  },
);
