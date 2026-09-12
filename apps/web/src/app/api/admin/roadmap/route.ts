import { requireOperator } from "@/lib/admin/operator";
import { loadRoadmap } from "@/lib/admin/roadmap";
import type { RoadmapPayload } from "@/lib/admin/types";

/**
 * GET /api/admin/roadmap, what is still coming, beside what already landed.
 *
 * ## The check in this file is the entire guard
 *
 * A route handler is not covered by the page's guard, so a protected /admin
 * page in front of an unprotected handler leaves the data readable by anyone
 * who knows the path. `requireOperator()` therefore runs first and on its own,
 * and
 * it is deliberately not wrapped in a try/catch: if the session check breaks,
 * this must fail closed with a 500 rather than fall through to the payload.
 *
 * ## Why a failed load answers 200 and not 500
 *
 * `loadRoadmap` promises not to throw. It reports trouble in `warnings`. The
 * try/catch is belt-and-braces for the day that promise is broken elsewhere.
 * When it catches, the client gets a valid, empty payload carrying a warning,
 * so a polling UI can say what went wrong and keep its last good frame instead
 * of blanking on a 500.
 *
 * The zeros in that payload are the sharp edge, and worth naming: an empty
 * roadmap looks identical to a finished one. `ok: false` is what tells them
 * apart, and the board reads it to decide whether an empty list means "nothing
 * left to do" or "we could not look". It must never render the first when the
 * truth is the second.
 *
 * This handler takes no query params, the roadmap is small and is returned
 * whole. There is nothing here to clamp, which is why it is shorter than its
 * sibling.
 */

// Live data: this tracks a file that changes under the running server, and a
// cached response would quietly pin the board to whatever it said at build.
export const dynamic = "force-dynamic";
export const revalidate = 0;
// The loader reads from disk, so this cannot run on an edge runtime.
export const runtime = "nodejs";

/**
 * Set on every response, the 401 included, matching the blanket header
 * `apps/app/next.config.ts` puts over its whole surface, so no intermediary
 * ever stores an admin's answer and replays it to someone else.
 */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function json(
  body: RoadmapPayload | { error: string },
  status: number,
): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  // `requireOperator()`, matching the page. See the note in ../changes/route.ts
  // on what a disagreement between the two costs.
  if ((await requireOperator()) === null) {
    return json({ error: "Not authorized." }, 401);
  }

  try {
    return json(await loadRoadmap(), 200);
  } catch (error) {
    console.error("[healdesk] admin roadmap loader threw", error);
    return json(emptyRoadmap(), 200);
  }
}

/**
 * A payload that is valid, empty, and says why.
 *
 * `byStatus` is written out rather than derived from `TASK_STATUSES`, so that
 * adding a status to the contract breaks this file at compile time instead of
 * shipping a board with one bucket silently missing.
 */
function emptyRoadmap(): RoadmapPayload {
  return {
    ok: false,
    groups: [],
    totals: {
      tasks: 0,
      byStatus: { ready: 0, vendor: 0, counsel: 0, decision: 0 },
    },
    fetchedAt: new Date().toISOString(),
    warnings: [
      "Could not read the roadmap. This is empty because the read failed, not because there is nothing left to do.",
    ],
  };
}
