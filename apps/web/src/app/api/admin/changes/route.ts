import type { NextRequest } from "next/server";

import { loadChanges } from "@/lib/admin/changes";
import { requireOperator } from "@/lib/admin/operator";
import type { ChangesPayload } from "@/lib/admin/types";

/**
 * GET /api/admin/changes, the repo activity the admin page polls.
 *
 * ## The check in this file is the entire guard
 *
 * A route handler is not covered by the page's guard. If /admin redirects an
 * unauthenticated visitor but this file does not check, the page is protected
 * and the data is not: anyone can curl the JSON the page would have drawn. So
 * `requireOperator()` runs first, before the query string is even read, and it
 * is deliberately NOT wrapped in a try/catch, if the session check itself breaks,
 * this must fail closed with a 500 rather than fall through to serving the
 * payload.
 *
 * ## Why the params are checked here but clamped in the loader
 *
 * `limit` decides how many commits get expanded, and expanding a commit costs
 * an upstream GitHub call. `?limit=5000` from anyone holding the cookie would
 * turn one page load into thousands of calls and a rate-limit ban that outlasts
 * the request. `loadChanges` is what stops that: it clamps to 1–365 days and
 * 1–100 commits before it reaches for a backend, and it is the only entry point
 * to either.
 *
 * This file therefore checks that a param is *a number* and hands the number
 * on. It used to clamp as well, to the identical bounds, and that quietly cost
 * something: the loader answers an out-of-range request by clamping **and
 * warning**, "Asked for 5000 days; showing 365", and a value pre-clamped here
 * arrives looking like it was what the caller asked for, so the warning never
 * fired and the page showed a year without ever saying it had been asked for
 * five. Substituting a value and not saying so is the same fault as
 * substituting a default for `?days=abc`, which the note below refuses to do.
 * One clamp, in the place that can also report it.
 *
 * ## Why a failed load answers 200 and not 500
 *
 * `loadChanges` promises not to throw. It reports trouble in `warnings`. The
 * try/catch below is belt-and-braces for the day that promise is broken by an
 * edit three modules away. When it catches, the client gets a valid, empty
 * payload carrying the warning, because a polling UI can show a warning and
 * keep its last good frame, where a 500 leaves it nothing to say but "failed".
 *
 * The zeros in that empty payload used to be the sharp edge of this choice,
 * four of them are indistinguishable from a quiet fortnight, so the payload
 * carries `ok: false` and the dashboard renders em-dashes instead of numbers.
 * `activity` is left empty rather than padded with zero-days for the same
 * reason: an empty chart is honest, a flat line at zero is a claim that nothing
 * was committed.
 *
 * Not done here: no rate limit. The cookie bounds who can call this, and the
 * page polls on an interval that a per-IP counter would eventually punish.
 */

// Live data. A cached response, at the framework, or at any hop in front of
// it, would show the owner a repo that stopped changing, which is the one
// failure this whole feature exists to avoid.
export const dynamic = "force-dynamic";
export const revalidate = 0;
// The local-git source shells out and reads the working copy; that needs Node.
export const runtime = "nodejs";

/**
 * Set on every response, the 401s and 400s included, matching the blanket
 * header `apps/app/next.config.ts` puts over its whole surface. A shared cache
 * holding one admin's 200 and replaying it is the reason this is not left to
 * the framework's defaults.
 */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function json(
  body: ChangesPayload | { error: string },
  status: number,
): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

type ParsedParam =
  /** Absent, or present and usable. `undefined` means "let the loader decide". */
  | { ok: true; value: number | undefined }
  /** Present and not a number. */
  | { ok: false };

/**
 * Read one integer query param, or say it was malformed.
 *
 * Absent and present-but-empty are treated the same, an empty `?days=` is what
 * a blank field sends, and `Number("")` is 0, which would silently become a
 * one-day window. Anything else non-numeric is rejected rather than coerced,
 * because substituting a default for `?days=abc` answers a question nobody
 * asked and labels it with the number they typed.
 *
 * A number that is out of range is *not* rejected and not adjusted here. It is
 * passed on, and `loadChanges` clamps it to its own bounds and puts a warning
 * in the payload saying it did. See the note at the top of the file.
 */
function readInteger(params: URLSearchParams, name: string): ParsedParam {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return { ok: true, value: undefined };

  const parsed = Number(raw);
  // Catches NaN and both infinities, so "abc" and "1e999" fail the same way.
  if (!Number.isFinite(parsed)) return { ok: false };

  return { ok: true, value: Math.trunc(parsed) };
}

export async function GET(request: NextRequest): Promise<Response> {
  // The same cookie the page above it insists on. When these two disagreed,
  // the page on `hd_operator`, this handler on the old shared-password
  // `hd_admin`, a signed-in owner got a dashboard whose every poll answered
  // 401, which reads as "the repository stopped changing" rather than as a
  // permission failure.
  if ((await requireOperator()) === null) {
    return json({ error: "Not authorized." }, 401);
  }

  const params = request.nextUrl.searchParams;
  const days = readInteger(params, "days");
  const limit = readInteger(params, "limit");

  // Named one at a time, because "one of your two params is wrong" is a worse
  // answer than the caller deserves. These also narrow the union for the call.
  if (!days.ok) return json({ error: "`days` must be a number." }, 400);
  if (!limit.ok) return json({ error: "`limit` must be a number." }, 400);

  try {
    return json(
      await loadChanges({ windowDays: days.value, limit: limit.value }),
      200,
    );
  } catch (error) {
    console.error("[healdesk] admin changes loader threw", error);
    return json(emptyChanges(), 200);
  }
}

/**
 * A payload that is valid, empty, and says why.
 *
 * `ok: false` is what carries that. It is the field the dashboard reads to
 * decide between an em-dash and a zero, and it exists precisely so this file
 * does not have to encode "nothing was measured" as a magic number that a
 * component has to know to look for.
 *
 * `windowDays` is 0 for the same reason it always was, echoing back a 30 next
 * to four zeros reads as "thirty quiet days", but it is no longer load-bearing
 * on its own now that `ok` states the fact outright.
 *
 * `totals.complete` is false and `coverage` is null, which is the honest
 * reading of a failure: a payload that measured nothing certainly did not
 * measure the window, and there is no shortfall worth describing beyond the one
 * `ok` already names.
 *
 * `source` is "unknown" rather than a guess. This branch runs when `loadChanges`
 * *threw*, so we genuinely do not know which backend it got to before it died;
 * the previous version of this file picked one from `NODE_ENV`, which meant a
 * dev box with a token would be labelled "local-git" and the page would print
 * "Reading your local checkout" about a read that never happened.
 */
function emptyChanges(): ChangesPayload {
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
      // Nothing was measured, so nothing about the window is accounted for.
      // `ok: false` already stops the tiles drawing these; this stops a tile
      // that reads `complete` alone from calling four zeros the whole month.
      complete: false,
    },
    // No partial read to describe, see the note on `ChangesPayload.coverage`.
    coverage: null,
    windowDays: 0,
    fetchedAt: new Date().toISOString(),
    warnings: [
      "Could not read the repository. This is empty because the read failed, not because nothing has changed.",
    ],
  };
}
