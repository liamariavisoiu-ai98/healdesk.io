import { emailKey, sendSafely } from "@/lib/email";
import { site } from "@/lib/site";

import { postInternalAlert } from "./alert";
import { runDemoBuild } from "./build";
import { demoConsoleUrl, problemNotice } from "./own-demo";
import {
  DEMO_BUILD_STALL_MS,
  displayName,
  getDemoSession,
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
 * writes nothing. Both re-read each row before writing it, because a Sheet
 * has no transaction and the cron and the button can meet.
 *
 * Neither runs the builds: those take minutes and belong after the
 * response (`after()` in the route and the action), through
 * `runRetriedBuilds`. `retry_count` on the row is how many times a stalled
 * build was started again, by either door or by the per-row Retry on a
 * stalled row; a rebuild of a ready demo is not a retry and leaves it alone.
 */

/** How many times the sweep starts a stalled build again before it stops and asks a person. */
export const DEMO_STALL_RETRIES = 1;

const STALL_MINUTES = Math.round(DEMO_BUILD_STALL_MS / 60_000);

/**
 * Start a stalled build again: `building`, a fresh clock, one more on the
 * count. Re-reads the row first and returns null when it is no longer
 * stalled (someone else got there) or no longer exists. The build itself is
 * the caller's to run (`runRetriedBuilds`).
 */
export async function retryStalledDemo(session: Pick<DemoSession, "slug">, now: Date = new Date()): Promise<DemoSession | null> {
  const fresh = await getDemoSession(session.slug, { fresh: true });
  if (!fresh || !isDemoBuildStalled(fresh, now.getTime())) return null;
  return updateDemoSession(fresh.slug, {
    status: "building",
    buildNote: null,
    buildStartedAt: now,
    retryCount: fresh.retryCount + 1,
  });
}

/** The builds owed after a retry, in parallel, none throwing (runDemoBuild ends every failure as a row). */
export async function runRetriedBuilds(slugs: readonly string[]): Promise<void> {
  await Promise.all(slugs.map((slug) => runDemoBuild(slug).then(() => undefined)));
}

/**
 * "Retry all stalled": every stalled row started again, whatever its count.
 * Returns the rows started again; the caller runs their builds.
 */
export async function retryStalledDemos(now: Date = new Date()): Promise<DemoSession[]> {
  const retried: DemoSession[] = [];
  for (const stalled of await listStalledDemoSessions(now.getTime())) {
    const again = await retryStalledDemo(stalled, now);
    if (again) retried.push(again);
  }
  return retried;
}

export type StallSweep = {
  /** Started again; the caller runs their builds. */
  retried: DemoSession[];
  /** Stalled again after a retry: marked failed, the team told. */
  gaveUp: DemoSession[];
};

/** The sweep's rule: once more, then a person. */
export async function sweepStalledDemos(now: Date = new Date()): Promise<StallSweep> {
  const sweep: StallSweep = { retried: [], gaveUp: [] };
  for (const stalled of await listStalledDemoSessions(now.getTime())) {
    if (stalled.retryCount < DEMO_STALL_RETRIES) {
      const again = await retryStalledDemo(stalled, now);
      if (!again) continue;
      sweep.retried.push(again);
      await postInternalAlert(`Demo build stalled: ${displayName(again)}, retried. ${demoConsoleUrl()}`);
      continue;
    }
    const failed = await giveUp(stalled, now);
    if (!failed) continue;
    sweep.gaveUp.push(failed);
    await postInternalAlert(`Demo build needs you: ${displayName(failed)} stalled twice. ${demoConsoleUrl()}`);
    await tellTheTeam(failed);
  }
  return sweep;
}

/** Stalled again after its retry: a failed row with the reason, so the console offers Retry and the sweep moves on. */
async function giveUp(session: DemoSession, now: Date): Promise<DemoSession | null> {
  const fresh = await getDemoSession(session.slug, { fresh: true });
  if (!fresh || !isDemoBuildStalled(fresh, now.getTime())) return null;
  return updateDemoSession(fresh.slug, {
    status: "failed",
    buildNote: `The build stalled twice: cut off after ${STALL_MINUTES} minutes, started again, and cut off again. Retry it by hand once the cause is known.`,
  });
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
