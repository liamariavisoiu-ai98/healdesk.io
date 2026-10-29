/**
 * Run an Apify actor for as long as the demo's budget allows, and keep what it
 * had found by then (lib/demo/budget.ts).
 *
 * Apify's run-sync endpoint either returns every result or nothing: a crawl
 * that needs ninety seconds gives a sixty-second build no pages at all. So
 * the run is started asynchronously, waited on up to the deadline, and its
 * dataset read as it stands. The crawlers push a page (or a listing) to the
 * dataset as each one finishes, so a run cut off at the deadline still hands
 * back everything it completed. A run still going is aborted, so it stops
 * spending.
 *
 * Business data only: a clinic's public pages and its public listing.
 */

const API = "https://api.apify.com/v2";

type RunData = { id?: string; status?: string; defaultDatasetId?: string };

export type ActorResult<T> = {
  items: T[];
  /** True when the run finished on its own, false when the deadline cut it off. */
  finished: boolean;
};

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

async function apifyError(response: Response, what: string): Promise<Error> {
  // Apify's own words, for the operator's build note: "Apify HTTP 400" alone
  // cost a debugging session the first time.
  const detail = ((await response.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
  return new Error(`${what}: Apify HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

/**
 * `actor` is the `user~name` id. Throws only when the run could not be
 * started; a run that started and then ran out of time returns what it has.
 */
export async function runActorUntil<T>(
  actor: string,
  input: Record<string, unknown>,
  options: { token: string; deadline: number; what: string; fetchImpl?: typeof fetch },
): Promise<ActorResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" };
  const left = () => Math.max(0, options.deadline - Date.now());

  // Leave two seconds of the window to read the dataset after the wait.
  const waitSecs = Math.max(1, Math.floor((left() - 2_000) / 1000));
  const started = await fetchImpl(`${API}/acts/${actor}/runs?timeout=${waitSecs + 5}&waitForFinish=${Math.min(60, waitSecs)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(Math.max(1_000, left())),
  });
  if (!started.ok) throw await apifyError(started, options.what);
  const run = ((await started.json()) as { data?: RunData }).data ?? {};
  if (!run.id || !run.defaultDatasetId) throw new Error(`${options.what}: Apify started no run`);

  const finished = TERMINAL.has(run.status ?? "");
  let items: T[] = [];
  try {
    const got = await fetchImpl(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1_500, left())),
    });
    if (got.ok) {
      const body = (await got.json()) as unknown;
      items = Array.isArray(body) ? (body as T[]) : [];
    }
  } catch {
    // The deadline came while reading: the build carries on with no items.
  }
  if (!finished) {
    // Fire and forget: the build does not wait on the abort.
    void fetchImpl(`${API}/actor-runs/${run.id}/abort`, { method: "POST", headers, signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }
  return { items, finished };
}
