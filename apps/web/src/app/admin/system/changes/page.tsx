import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { loadChanges } from "@/lib/admin/changes";
import { requireOperator } from "@/lib/admin/operator";
import { loadRoadmap } from "@/lib/admin/roadmap";
import type { ChangesPayload, RoadmapPayload } from "@/lib/admin/types";

/**
 * /admin/system/changes, the commit feed: every commit as it lands, where the
 * work is concentrated, and what is still queued behind it. Until the admin
 * redesign (23 October 2026) this was /admin itself, so an operator landed on
 * engineering telemetry; the owner's decision D11 moves it here, under
 * System, and never deletes it. The loaders, the dashboard component and its
 * honesty tests are untouched.
 *
 * ## Why the first load happens here and not in the browser
 *
 * The obvious build is a client component that mounts, shows a skeleton, and
 * fetches. It is also the wrong one. This page is opened to answer a question,
 * "what has changed?", and the skeleton answers it with a shrug for as long as
 * the round trip takes, on a payload the server could have read before the HTML
 * was even sent. So `loadChanges()` and `loadRoadmap()` are called directly,
 * in-process, with no HTTP hop through our own route handlers, and the result
 * is handed to `AdminDashboard` as its opening frame. The polling starts from a
 * page that is already correct.
 *
 * The two loaders are awaited together and settled independently. A roadmap
 * that cannot be read must not take the commit feed down with it, which is
 * exactly what a bare `Promise.all` over two throwing promises would do.
 *
 * ## Why the loaders are caught at all
 *
 * Both promise not to throw. They report trouble in `warnings` instead, and
 * the route handlers in /api/admin still wrap them, for the day an edit three
 * modules away breaks that promise. The same reasoning applies here, more so:
 * an unhandled throw in a page is a 500, and a 500 is the one outcome this
 * whole feature exists to avoid. The owner opened this to see what is going on;
 * "Application error" tells them nothing and hides the roadmap too.
 *
 * The fallbacks below duplicate the shape of the ones in the route handlers,
 * and the duplication is real rather than justified: three near-identical empty
 * payloads exist, differing only in their wording. What keeps it safe is the
 * types, a change to `ChangesPayload` or `RoadmapPayload` breaks every copy at
 * compile time, so none can silently rot. Collapsing them into
 * `lib/admin/` would be an improvement and is not a correctness fix.
 *
 * ## `ok: false` is what says "nothing was measured"
 *
 * A fallback payload sets it, and `AdminDashboard` renders em-dashes rather
 * than zeros wherever it is false. Four zeros beside a 30-day window would be a
 * claim of thirty quiet days, which is a guess dressed as a fact.
 *
 * This used to be carried by `windowDays: 0`, a convention three files had
 * agreed on and none of them stated in the contract. It was also not honoured
 * by `loadChanges`, whose own failure payload keeps the real window and so read
 * as a measurement of zero. That is the bug this field removes.
 *
 * ## The roadmap's file must travel with this route
 *
 * `loadRoadmap()` reads scripts/docs-site/tasks.mjs, outside apps/web, so
 * next.config.ts lists it under `outputFileTracingIncludes` for the route
 * that calls it; that entry named "/admin" and needs this path too (the lead
 * adds it: next.config.ts is outside this lane). Without it the deployed
 * function has no copy and the board says it could not be read.
 */

/**
 * On the page rather than in the layout. A plain string `title` on a layout
 * clears the closest parent's `title.template` for every route below it, which
 * would drop the healdesk suffix from the sign-in page's tab as a side
 * effect of naming this one. Here it resolves through the root template and
 * affects nothing else. `robots: noindex` stays on the layout, where it should
 * cover the whole subtree. The reasoning is written out in `layout.tsx`.
 */
export const metadata: Metadata = {
  title: "Changes",
};

// Never cached, at any layer. `requireOperator()` reads cookies and would force
// this dynamic anyway; saying so out loud means the guarantee does not depend
// on noticing that side effect. A cached admin page is a page that tells the
// owner the repository stopped changing.
export const dynamic = "force-dynamic";

export default async function ChangesPage() {
  /**
   * The guard, not a convenience. Without it this page renders the whole repo
   * map to anyone who asks, the route handlers protect the JSON, and this
   * protects the HTML that is server-rendered with the same data inside it.
   *
   * `requireOperator()`, not the old `requireAdmin()`. Sign-in now issues one
   * cookie, `hd_operator`, and never the shared-password `hd_admin`; a page
   * still asking for `hd_admin` therefore bounced every freshly signed-in
   * operator to /admin/sign-in, which saw a valid session and bounced them
   * straight back here. A redirect loop on the console's front door, from two
   * guards that were each individually correct.
   */
  if ((await requireOperator()) === null) redirect("/admin/sign-in");

  const [initialChanges, initialRoadmap] = await Promise.all([
    loadChanges().catch(changesFallback),
    loadRoadmap().catch(roadmapFallback),
  ]);

  return (
    <AdminDashboard
      initialChanges={initialChanges}
      initialRoadmap={initialRoadmap}
    />
  );
}

/**
 * A valid, empty changes payload that says why it is empty.
 *
 * `source` is "unknown", because it is. This branch runs when `loadChanges`
 * threw, so which backend it reached before dying is not something this file
 * knows; it used to guess from `NODE_ENV`, and the page printed that guess as a
 * confident sentence about where it was reading from.
 *
 * `ok: false` is what makes the difference visible downstream: the dashboard
 * draws em-dashes rather than zeros, because no commits and no reading are
 * different claims.
 *
 * `activity` stays empty rather than being padded with zero-days: an empty
 * chart is an absence, a flat line at zero is a claim that nobody committed.
 *
 * `totals.complete: false` with `coverage: null` says the second half of it:
 * these numbers do not account for the window, and there is no partial read to
 * qualify, the read did not happen at all.
 */
function changesFallback(error: unknown): ChangesPayload {
  console.error("[healdesk] admin changes page: loadChanges threw", error);

  return {
    source: "unknown",
    ok: false,
    changes: [],
    activity: [],
    areas: [],
    totals: {
      commits: 0,
      additions: 0,
      deletions: 0,
      activeDays: 0,
      // Nothing measured means nothing accounted for. See `coverage` below.
      complete: false,
    },
    coverage: null,
    windowDays: 0,
    fetchedAt: new Date().toISOString(),
    warnings: [
      "Could not read the repository for the first load. This is empty because the read failed, not because nothing has changed. The next poll will try again.",
    ],
  };
}

/**
 * The same for the roadmap.
 *
 * `byStatus` is written out in full rather than derived from `TASK_STATUSES`,
 * so that adding a status to the contract breaks this file at compile time
 * instead of shipping a board with one bucket silently missing.
 */
function roadmapFallback(error: unknown): RoadmapPayload {
  console.error("[healdesk] admin changes page: loadRoadmap threw", error);

  return {
    ok: false,
    groups: [],
    totals: {
      tasks: 0,
      byStatus: { ready: 0, vendor: 0, counsel: 0, decision: 0 },
    },
    fetchedAt: new Date().toISOString(),
    warnings: [
      "Could not read the roadmap for the first load. This is empty because the read failed, not because there is nothing left to do. The next poll will try again.",
    ],
  };
}
