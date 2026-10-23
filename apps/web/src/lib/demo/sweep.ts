import { emailKey, sendSafely } from "@/lib/email";
import { site } from "@/lib/site";

import { postInternalAlert } from "./alert";
import { runDemoBuild } from "./build";
import { demoConsoleUrl, problemNotice } from "./own-demo";
import {
  DEMO_BUILD_STALL_MS,
  displayName,
  isDemoBuildStalled,
  listStalledDemoSessions,
  updateDemoSession,
  type DemoSession,
} from "./sessions";

/**
 * Stalled demo builds: started again once, then handed to a person.
 *
 * A build or an audit runs after the response that started it, inside the
 * route's 300 s; one still `building` or `auditing` after DEMO_BUILD_STALL_MS
 * (lib/demo/sessions.ts) was cut off and will never finish on its own. Until
 * now the console showed it as "Stalled" and waited for someone to press
 * Retry, and nothing told anyone, so a prospect who was promised a link
 * could wait a day on a page saying "finishing touches".
 *
 * Two doors, one rule each:
 *
 *   - `sweepStalledDemos()`, from GET /api/cron/demo-sweep: a stalled row
 *     that has never been started again is started again, once, and Slack
 *     hears it was. One that has already been started again and stalled a
 *     second time is marked `failed` with the reason, Slack hears it needs a
 *     person, and hello@ is emailed (`problemNotice("failed")`, the message
 *     the homepage demo already sends). Marking it failed is what keeps the
 *     sweep quiet afterwards: a failed row is not a stalled one, so the next
 *     run says nothing more about it.
 *   - `retryStalledDemos()`, from "Retry all stalled" on /admin/demos: an
 *     operator's decision, so every stalled row is started again whatever
 *     its count, and the count goes up so the sweep's rule still holds.
 *
 * Both are idempotent against themselves: a retry sets a fresh clock, so a
 * second press or a second run minutes later finds nothing stalled and
 * writes nothing.
 *
 * ## What is and is not guaranteed when the cron and the button meet
 *
 * A Sheet has no transaction, so nothing here is atomic. Each row is
 * decided on the read that the write is made from (`updateDemoSession`
 * with a function patch): the row must still be stalled and its count
 * must be the one the sweep listed, else the writer skips. So a writer
 * whose read sees the other's write does nothing, and the count goes up
 * by one per writer that got through. What is not closed is the one Sheet
 * round-trip between that read and the write: two writers that both read
 * inside it both write, the later wins, the count reads one short, and two
 * builds of the same demo run; the second ends as a plain overwrite of the
 * first's row. The cron runs once a day and the button is pressed by a
 * person, so the meeting is rare, and its cost is a wasted build, not a
 * lost one.
 *
 * Neither runs the builds: those take minutes and belong after the
 * response (`after()` in the route and the action), through
 * `runRetriedBuilds`. `retry_count` on the row is how many times the run
 * that is on was started again after stalling, by either door or by the
 * per-row Retry on a stalled row. It goes back to 0 whenever a run ends
 * (lib/demo/build.ts writes ready, held or failed) and when an operator
 * rebuilds by hand, so the count is about this run, never the demo's
 * history: a demo that stalled once in October is not failed without a
 * retry when it stalls again in December.
 */

/** How many times the sweep starts a stalled build again before it stops and asks a person. */
export const DEMO_STALL_RETRIES = 1;

/**
 * How many builds one sweep, or one press, starts at once. A build makes
 * about ten Sheet requests over its minutes (the row read, the auditing
 * write, the verdict, the lead and the email stamp), the console's own
 * reads sit beside them, and the quota is about sixty requests a minute
 * for the whole Sheet. Three in parallel stay well inside it; a backlog of
 * twenty would not. The rows beyond the batch stay stalled, untouched, and
 * are the longest-stalled rows of the next run or the next press.
 */
export const RETRY_BATCH = 3;

const STALL_MINUTES = Math.round(DEMO_BUILD_STALL_MS / 60_000);

/**
 * Start a stalled build again: `building`, a fresh clock, one more on the
 * count. Decided on the read the write is made from: null, and no write,
 * when the row has gone, is no longer stalled (someone else got there) or
 * its count is not the one the caller saw (someone else got there and it
 * stalled again since). The caller must not start a build on null, because
 * the writer that got through already did. The build itself is the caller's
 * to run (`runRetriedBuilds`).
 */
export async function retryStalledDemo(
  session: Pick<DemoSession, "slug" | "retryCount">,
  now: Date = new Date(),
): Promise<DemoSession | null> {
  return updateDemoSession(session.slug, (current) =>
    isDemoBuildStalled(current, now.getTime()) && current.retryCount === session.retryCount
      ? { status: "building", buildNote: null, buildStartedAt: now, retryCount: current.retryCount + 1 }
      : null,
  );
}

/** The builds owed after a retry, in parallel, none throwing (runDemoBuild ends every failure as a row). */
export async function runRetriedBuilds(slugs: readonly string[]): Promise<void> {
  await Promise.all(slugs.map((slug) => runDemoBuild(slug).then(() => undefined)));
}

/** A row the sweep could not handle: the Sheet refused the write, or the row is damaged. Logged where it happens. */
export type SweepFailure = { slug: string; error: string };

export type StallRetry = {
  /** Started again; the caller runs their builds. */
  retried: DemoSession[];
  /** Rows that threw. The rows before and after them were handled all the same. */
  failures: SweepFailure[];
  /** Stalled rows left as they were because the batch was full (RETRY_BATCH); the next run's first. */
  waiting: number;
};

export type StallSweep = StallRetry & {
  /** Stalled again after a retry: marked failed, the team told. */
  gaveUp: DemoSession[];
};

/**
 * Each row is handled on its own, and a throw on one is recorded and
 * stepped over rather than ending the run. Otherwise a Sheets quota refusal
 * on the second row, or a row whose id was blanked by hand (emailKey
 * refuses it), would throw out of the loop before the caller scheduled
 * anything, and the first row, already written as building with its count
 * up, would never have its build run: at the next sweep it reads as stalled
 * after a retry and is marked failed without ever having been retried.
 */
function failed(slug: string, error: unknown): SweepFailure {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[healdesk] demo stall sweep: a row could not be handled", { slug, error: message });
  return { slug, error: message };
}

/**
 * "Retry all stalled": the stalled rows started again, whatever their
 * count, longest stalled first and at most RETRY_BATCH of them; the rest
 * wait for the next press. Returns the rows started again, whose builds
 * the caller runs, the rows that threw, and how many waited. Only the
 * listing itself throws.
 */
export async function retryStalledDemos(now: Date = new Date()): Promise<StallRetry> {
  const out: StallRetry = { retried: [], failures: [], waiting: 0 };
  for (const stalled of await listStalledDemoSessions(now.getTime())) {
    if (out.retried.length >= RETRY_BATCH) {
      out.waiting += 1;
      continue;
    }
    try {
      const again = await retryStalledDemo(stalled, now);
      if (again) out.retried.push(again);
    } catch (error) {
      out.failures.push(failed(stalled.slug, error));
    }
  }
  return out;
}

/**
 * The sweep's rule: once more, then a person. At most RETRY_BATCH builds
 * are started; a row past that waits, while a row that has had its retry
 * is given up on whatever the batch holds, since giving up starts nothing.
 * Only the listing itself throws.
 */
export async function sweepStalledDemos(now: Date = new Date()): Promise<StallSweep> {
  const sweep: StallSweep = { retried: [], gaveUp: [], failures: [], waiting: 0 };
  for (const stalled of await listStalledDemoSessions(now.getTime())) {
    try {
      if (stalled.retryCount < DEMO_STALL_RETRIES) {
        if (sweep.retried.length >= RETRY_BATCH) {
          sweep.waiting += 1;
          continue;
        }
        const again = await retryStalledDemo(stalled, now);
        if (!again) continue;
        sweep.retried.push(again);
        await postInternalAlert(`Demo build stalled: ${displayName(again)}, retried. ${demoConsoleUrl()}`);
        continue;
      }
      const given = await giveUp(stalled, now);
      if (!given) continue;
      sweep.gaveUp.push(given);
      await postInternalAlert(`Demo build needs you: ${displayName(given)} stalled twice. ${demoConsoleUrl()}`);
      await tellTheTeam(given);
    } catch (error) {
      sweep.failures.push(failed(stalled.slug, error));
    }
  }
  return sweep;
}

/**
 * Stalled again after its retry: a failed row with the reason, so the
 * console offers Retry and the sweep moves on. Decided on the read it
 * writes from, as the retry is: null when the row is no longer stalled or
 * its count moved (an operator pressed Retry all stalled since the listing).
 */
async function giveUp(session: DemoSession, now: Date): Promise<DemoSession | null> {
  return updateDemoSession(session.slug, (current) =>
    isDemoBuildStalled(current, now.getTime()) && current.retryCount === session.retryCount
      ? {
          status: "failed",
          buildNote: `The build stalled twice: cut off after ${STALL_MINUTES} minutes, started again, and cut off again. Retry it by hand once the cause is known.`,
        }
      : null,
  );
}

/**
 * To hello@, as the homepage demo's failure notice goes: the site, the
 * reason, the console. Keyed by the demo's row id, never an address, and
 * once per demo: a row that fails this way twice has been retried by hand
 * in between, and the operator who did that knows.
 */
async function tellTheTeam(session: DemoSession): Promise<void> {
  const { subject, text } = problemNotice(session, "failed");
  const result = await sendSafely({
    to: site.email,
    subject,
    text,
    ...(session.leadEmail ? { replyTo: session.leadEmail } : {}),
    tag: "demo-stalled",
    idempotencyKey: emailKey("demo-stalled", session.id),
  });
  if (result.status !== "sent") {
    console.error("[healdesk] stalled-demo notice to the team not sent", { slug: session.slug, ...result });
  }
}
