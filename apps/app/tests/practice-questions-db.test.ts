import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AssistantResponder } from "@/lib/assistant/turn";
import {
  duePracticeRuns,
  runOnePracticeRun,
  sweepPracticeQuestions,
} from "@/lib/engine/practice/job";
import type { PracticeJudge } from "@/lib/engine/practice/judge";
import {
  claimPracticeRun,
  practiceQuestionsGate,
  readPracticeInputs,
  readPracticeState,
  recordPracticeRun,
  requestPracticeQuestions,
} from "@/lib/engine/practice/store";
import { runOperation, type Operator } from "@/lib/ops/api";
import { saveKnowledge } from "@/lib/portal/knowledge";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { loadSetupState } from "@/lib/setup/state";
import { buildTracker } from "@/lib/setup/tracker";
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

/**
 * The practice questions against the database (plan Part G): a save asks for
 * a run two minutes out and a second save moves the same run on; the job
 * claims one run at a time per clinic, asks the brain (faked here, never
 * Anthropic), and records what it came to; a pass approves the version it
 * read and completes the tracker; a failure on the clinic's own data queues
 * O9; a judge's failure opens a review that ops lists and decides through the
 * envelope; the operator's approval stays as an override; the gate never
 * holds a live channel; and the runtime role can delete none of it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
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

/** The model, faked: careful answers, with the listed price, or a wrong one when asked to. */
function model(price = "$199"): AssistantResponder & { calls: number } {
  const fn = (async ({ messages }) => {
    fn.calls += 1;
    const last = messages[messages.length - 1]!.content;
    const said = (reply: string) => JSON.stringify({ reply, booking: { wants: false } });
    if (/How much is Signature facial/.test(last)) return said(`Signature facial is ${price}.`);
    if (/How much does/.test(last))
      return said(
        "There's no price for that one, but the team can go through it at a consultation.",
      );
    if (/poem/.test(last))
      return said("I can only help with questions about the practice. What can I help with?");
    if (/validate|lift|music|charge|fountain/.test(last))
      return said("I don't have that information, but the team can get back to you.");
    return said("That's one for the practice's clinicians; would you like a consultation?");
  }) as AssistantResponder & { calls: number };
  fn.calls = 0;
  return fn;
}

const judge =
  (verdict: "pass" | "fail"): PracticeJudge =>
  async () => ({ verdict, reason: verdict === "pass" ? "Fine." : "It reassured." });

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

describeDb("the practice questions, against the database", () => {
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
    expect(agent.approved_at).toBeInstanceOf(Date);
    expect(agent.approved_by_label).toBe(`the practice questions (run ${runId})`);
    const [run] = await runs();
    expect(run).toMatchObject({
      status: "passed",
      approved_version: agent.version,
      agent_version: agent.version,
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
    expect(agent.approved_at).toBeNull();
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
      "One thing to fix: 1 answer in Knowledge → Quick answers. Fix it there and she answers them again.",
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
    expect(agent.approved_at).toBeInstanceOf(Date);
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
    expect(agent.approved_at).toBeNull();
    expect((await runs()).map((r) => r.status)).toEqual(["superseded", "queued"]);
    // The superseded run asked again, which moved the queued one two minutes on.
    const queued = (await runs())[1]!;
    expect(queued.id).toBe(second);
    expect((queued.run_after as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await dueQueued()).toBe(second);
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

  test("the operator's approval stays as an override, recorded with the operator, which the tracker and the gate read", async () => {
    await setAnswers();
    const outcome = await runOperation(
      "approveAgentConfig",
      { clinicId: clinic.clinicId, approvedBy: "Laura Owner" },
      OPERATOR,
    );
    expect((outcome.body as { data: { status: string } }).data.status).toBe("updated");
    const override = (await runs()).find((r) => r.reason === "override")!;
    expect(override).toMatchObject({
      status: "passed",
      override_label: "Laura Owner (recorded by ops@healdesk.test)",
    });
    const practice = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readPracticeState(tx),
    );
    expect(practice.latest).toMatchObject({ status: "passed", overridden: true });
    const events = (
      await getMigratorPool().query(
        `select metadata from security_events where event = 'agent_config_approved' order by occurred_at desc limit 1`,
      )
    ).rows;
    expect(events[0]!.metadata).toMatchObject({ override: "practice_questions" });
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
