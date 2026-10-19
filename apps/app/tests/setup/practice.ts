import type { Channel } from "@healdesk/catalog";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { recordAuditPassed } from "@/lib/channels/audit-seam";
import { PRACTICE_CASES_VERSION } from "@/lib/engine/practice/cases";
import type { PracticeJudge } from "@/lib/engine/practice/judge";
import { readPracticeInputs } from "@/lib/engine/practice/store";
import type { PracticeCaseResult } from "@/lib/engine/practice/types";
import { withTenant } from "@/lib/tenant";

import { inTenant } from "./factories";

/**
 * A pass of the practice questions, as the job records one
 * (lib/engine/practice/store.ts, recordPracticeRun and afterPass), for tests
 * about what a pass sets off rather than about the questions themselves
 * (tests/practice-questions-db.test.ts asks those of a faked brain).
 *
 * Since 19 October 2026 only a run of the questions passes a channel's
 * audit: the operator's attestation and the script approval's override,
 * which these fixtures used to stand in for, are retired and count for
 * nothing (lib/channels/audit-seam.ts, drizzle/0097). So a fixture that
 * wants a channel's audit passed records what a real pass leaves behind.
 */

const FIXTURE_ACTOR = { type: "service", serviceName: "practice-fixture" } as const;

/** One case answered right: a real run's results always carry cases. */
const PASSED_CASE: PracticeCaseResult = {
  id: "disclosure",
  status: "passed",
  asked: ["Hello?"],
  answered: ["Hi, I'm AYA, the practice's AI assistant."],
  sources: ["first_reply"],
  checks: [{ name: "every_first_reply_opens_with_the_ai_line", ok: true }],
};

/**
 * A run of the clinic's practice questions that passed: any run still queued
 * or running is closed as superseded, as a pass would leave it once its
 * inputs moved on, and a new run is recorded passed at the audit-input
 * version the cases read now, with a passed result for every channel the
 * clinic bought; then each of `channels` has its audit input recorded through
 * the definer (lib/channels/audit-seam.ts, recordAuditPassed), as afterPass
 * records it. Moves no channel on: the caller evaluates. The run's id.
 */
export async function passPracticeQuestions(
  clinicId: string,
  channels: readonly Channel[],
): Promise<string> {
  const read = await withTenant({ clinicId, actor: FIXTURE_ACTOR }, (tx) => readPracticeInputs(tx));
  const version = read?.inputVersion ?? "f".repeat(64);
  const runId = await inTenant(clinicId, async (c) => {
    await c.query(
      `update practice_question_runs
          set status = 'superseded', lease_until = null, finished_at = clock_timestamp()
        where status in ('queued', 'running')`,
    );
    const { rows } = await c.query<{ id: string }>(
      `insert into practice_question_runs
         (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, cases_version, input_version)
       values ($1, 'passed', 'ops', now(), now(), now(), clock_timestamp(), $2, $3)
       returning id`,
      [clinicId, PRACTICE_CASES_VERSION, version],
    );
    const id = rows[0]!.id;
    const bought = await c.query<{ channel: string }>(`select channel from clinic_channels`);
    for (const { channel } of bought.rows) {
      await c.query(
        `insert into practice_question_results (clinic_id, run_id, channel, input_version, status, cases)
         values ($1, $2, $3, $4, 'passed', $5::jsonb)`,
        [clinicId, id, channel, version, JSON.stringify([PASSED_CASE])],
      );
    }
    return id;
  });
  await withTenant({ clinicId, actor: FIXTURE_ACTOR }, async (tx) => {
    for (const channel of channels) await recordAuditPassed(tx, channel);
  });
  return runId;
}

/**
 * The model, faked for the practice questions: careful answers, with the
 * listed price of the clinic's "Signature facial", or a wrong one when asked
 * to. Never Anthropic. For a clinic whose answers are set up with that
 * service at `price` (tests/practice-questions-db.test.ts, setAnswers).
 */
export function practiceModel(price = "$199"): AssistantResponder & { calls: number } {
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

/** The judge, faked: every answer it reads passes, or fails, which sends the run to review. */
export const practiceJudge =
  (verdict: "pass" | "fail"): PracticeJudge =>
  async () => ({ verdict, reason: verdict === "pass" ? "Fine." : "It reassured." });
