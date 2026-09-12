import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  REPO_AREAS,
  type ActivityDay,
  type AreaVolume,
  type Change,
  type ChangedFile,
  type ChangeSource,
  type ChangesPayload,
  type RepoArea,
} from "@/lib/admin/types";

/**
 * The commit feed behind /admin. GitHub when there is a token, the local
 * checkout when there is not.
 *
 * Server only. It shells out to `git` and reads `process.env`; importing it
 * from a client component would fail the build, which is the outcome we want.
 *
 * ## Why two backends and not one
 *
 * Deployed, the only truth available is GitHub: the container has no checkout.
 * Locally, GitHub is the *wrong* truth. It cannot see the commit made ninety
 * seconds ago and not yet pushed, which is precisely the commit the owner is
 * watching for. So the backend is chosen by `GITHUB_TOKEN` and the choice is
 * reported in `source`, because a feed quietly reading the wrong repo state is
 * worse than no feed.
 *
 * The two paths converge on one internal `CommitRecord` and share every line of
 * aggregation below it. That is deliberate: if activity, areas and totals were
 * computed twice they would drift, and the drift would only ever surface as a
 * number that looks fine and is wrong.
 *
 * ## The rate-limit arithmetic, which drove most of the design
 *
 * GitHub's list endpoint carries no line counts, so stats need one extra call
 * per commit. Forty commits is forty-one requests. A page polling every 15s is
 * 240 builds an hour, and 41 × 240 ≈ 9,800 requests against a 5,000/hour token
 * the feed would take itself off the air inside half an hour.
 *
 * Two caches fix that. A commit is immutable, so its detail is cached by sha
 * for the life of the process and a steady-state refresh fetches *only* the
 * commits that appeared since the last one, usually none. On top of that a
 * 15-second payload cache absorbs the poll and the several components mounting
 * at once. Both live in module scope, which means per instance: two serverless
 * instances keep two caches and the first request to each is a cold one. That
 * is fine here, the ceiling being protected is the GitHub limit, not
 * correctness, and would not be fine if this had to agree across instances.
 *
 * ## `execFile`, never `exec`
 *
 * The local path passes an argv array. Nothing here is attacker-controlled
 * today, but `exec` with an interpolated string is the *shape* of a command
 * injection, and the shape is what gets copied into the next file.
 *
 * ## What this deliberately does not do
 *
 * - It does not paginate past GitHub's first 100 commits, or past 500 locally,
 *   and on GitHub it expands only the newest `limit` of the page it did get.
 *   Every cap is reported twice: as a warning naming the number, and, because
 *   a sentence in a list of warnings is not something a stat tile or a chart
 *   can read, as `totals.complete` plus `coverage` in the payload, which is
 *   what makes the difference between "40" and "40+" and between a quiet day
 *   and a day nobody looked at.
 * - It does not fall back from GitHub to the local checkout when GitHub is
 *   down. `source` would then be a lie, and a deployed instance has no
 *   checkout to fall back to anyway.
 * - Merge commits have no file stats on the local path, `git log` does not
 *   diff a merge against a single parent, so they read as 0/0 there and as
 *   whatever GitHub says on the other. The history here is linear, so this has
 *   never bitten; it is written down because it would be baffling otherwise.
 * - Binary files carry zero line counts, because neither source measures lines
 *   for them. They still count toward `filesChanged`.
 *
 * ## Honest absence
 *
 * `loadChanges` never throws. Every failure becomes a valid payload plus a
 * warning string the page is expected to lead with. A *partial* read is not a
 * failure and does not get `ok: false`, the numbers are real, but it does get
 * `totals.complete: false`, which is the machine-readable half of the same
 * honesty. The rule the whole file follows: `ok` says whether we measured,
 * `complete` says whether we measured everything, and neither is ever inferred
 * from the other or from a zero. A *failed* read returns an
 * empty `activity` array rather than thirty zeroed days: thirty zeros draw a
 * flat line saying "nothing happened", when the truth is "we could not look". A
 * *successful* read that found nothing returns the zeroed days, because then
 * the flat line is true.
 */

/* ------------------------------------------------------------------ knobs -- */

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 40;
const MAX_WINDOW_DAYS = 365;
const MAX_LIMIT = 100;

/** Long enough to absorb a 15s poll and three components mounting together. */
const PAYLOAD_TTL_MS = 15_000;

const DETAIL_CONCURRENCY = 5;
/** Commits are immutable, so this only ever grows with new work. */
const DETAIL_CACHE_MAX = 500;
/** Distinct (window, limit) pairs kept. See `remember` for why there is a cap. */
const PAYLOAD_CACHE_MAX = 64;

/** Files shown per commit. `filesChanged` carries the true count. */
const MAX_FILES_PER_COMMIT = 12;

const GITHUB_API = "https://api.github.com";
const GITHUB_PAGE_SIZE = 100;
const GITHUB_FILE_CAP = 300; // GitHub's own per-commit cap, not ours.
const GITHUB_TIMEOUT_MS = 10_000;
const USER_AGENT = "healdesk-admin";

const LOCAL_MAX_COMMITS = 500;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

const DEFAULT_REPO = "liamariavisoiu-ai98/healdesk.io";

/* ------------------------------------------------------------ classifying -- */

/**
 * Repo path to area.
 *
 * Prefix matching against `REPO_AREAS`, with `.github/` folded into `ci`
 * because a workflow change is CI work wherever the directory happens to sit.
 * Everything unmatched is `other`, an honest bucket, not a wrong guess at the
 * nearest area.
 */
export function classifyArea(path: string): RepoArea {
  const normalized = path.replace(/^\.\//, "").replace(/^\/+/, "");

  if (normalized.startsWith(".github/")) return "ci";

  for (const area of REPO_AREAS) {
    if (area === "ci" || area === "other") continue;
    if (normalized === area || normalized.startsWith(`${area}/`)) return area;
  }

  return "other";
}

/* -------------------------------------------------------------- internals -- */

/**
 * What both backends produce. `additions`/`deletions` are carried separately
 * from `files` because GitHub reports authoritative commit totals even when it
 * truncates the file list at 300.
 */
type CommitRecord = {
  sha: string;
  authorName: string;
  /** ISO 8601, normalised to UTC by both backends so they agree. */
  authoredAt: string;
  message: string;
  url: string | null;
  /** Every file touched, before the display cap. */
  files: ChangedFile[];
  filesChanged: number;
  additions: number;
  deletions: number;
};

type LoadResult = {
  payload: ChangesPayload;
  /** False when the read degraded, do not let it overwrite the last good one. */
  healthy: boolean;
};

type CacheEntry = { storedAt: number; payload: ChangesPayload };

/** 15s window. Serves the poll storm. */
const payloadCache = new Map<string, CacheEntry>();
/** Survives failure, so a rate-limited read can still show something real. */
const lastGoodPayload = new Map<string, ChangesPayload>();
/** Keyed by `owner/name@sha`. A commit's stats never change. */
const detailCache = new Map<string, CommitRecord>();

/**
 * Every cache in this module is bounded, including the two payload ones.
 *
 * Their key is `source:repo:windowDays:limit`, and the route handler lets the
 * caller pick the last two: 365 windows x 100 limits is 36,500 distinct keys,
 * and nothing here expires `lastGoodPayload` at all. Walking that grid, which
 * takes a cookie, but the cookie is not the only thing standing between this
 * process and its memory ceiling, would leave a full payload of up to a
 * hundred commits at every point. The dashboard asks for four of those keys, so
 * a cap in the dozens never evicts one anybody wanted.
 */
function remember<V>(
  cache: Map<string, V>,
  max: number,
  key: string,
  value: V,
): void {
  // Re-inserting moves the key to the back of the iteration order, so a key
  // that is still being asked for is not the one dropped at the cap.
  cache.delete(key);
  if (cache.size >= max) {
    // Maps iterate in insertion order, so this drops the oldest.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

function rememberDetail(key: string, record: CommitRecord): void {
  remember(detailCache, DETAIL_CACHE_MAX, key, record);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The first blank line splits headline from reasoning. Bodies here are long. */
export function splitMessage(message: string): { subject: string; body: string } {
  const text = message.replace(/\r\n/g, "\n").trim();
  if (text === "") return { subject: "(no commit message)", body: "" };

  const breakAt = text.search(/\n[ \t]*\n/);
  if (breakAt === -1) return { subject: collapse(text), body: "" };

  return {
    subject: collapse(text.slice(0, breakAt)),
    body: text.slice(breakAt).trim(),
  };
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC of the first day in the window, so the earliest day is whole. */
function windowStart(now: Date, windowDays: number): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return start;
}

function churn(file: ChangedFile): number {
  return file.additions + file.deletions;
}

/* ------------------------------------------------------------- assembling -- */

/**
 * Gapless by construction: every day in the window exists before any commit is
 * counted. A sparkline drawn only from days that had commits compresses three
 * weeks of silence into a straight line between two spikes, and reads as steady
 * work.
 *
 * Buckets are UTC days on both backends. A commit authored at 01:00 in a +04:00
 * zone therefore lands on the previous UTC day, worth knowing before wondering
 * why a chart looks off by one.
 */
export function buildActivity(
  records: CommitRecord[],
  now: Date,
  windowDays: number,
): { days: ActivityDay[]; outOfWindow: number } {
  const start = windowStart(now, windowDays);
  const days = new Map<string, ActivityDay>();

  for (let offset = 0; offset < windowDays; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    const date = utcDayKey(day);
    days.set(date, { date, commits: 0, additions: 0, deletions: 0 });
  }

  let outOfWindow = 0;

  for (const record of records) {
    const day = days.get(record.authoredAt.slice(0, 10));
    // Anything outside the window is dropped rather than clamped onto an edge
    // day, which would put a spike on a day that had no work. It happens: a
    // rebase moves the commit date, which is what `--since` filters on, and
    // leaves the author date, which is what the chart buckets by. The caller
    // says so rather than letting the chart and the totals quietly disagree.
    if (!day) {
      outOfWindow += 1;
      continue;
    }
    day.commits += 1;
    day.additions += record.additions;
    day.deletions += record.deletions;
  }

  return { days: [...days.values()], outOfWindow };
}

/**
 * Only areas that were actually touched, sorted by churn. Zero-filling all nine
 * would be truthful but noisy: six empty bars say nothing about where the work
 * went, which is the only question this breakdown answers.
 */
function buildAreas(records: CommitRecord[]): AreaVolume[] {
  const volumes = new Map<RepoArea, AreaVolume>();

  for (const record of records) {
    const touched = new Set<RepoArea>();

    for (const file of record.files) {
      const existing = volumes.get(file.area) ?? {
        area: file.area,
        commits: 0,
        additions: 0,
        deletions: 0,
      };
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      volumes.set(file.area, existing);
      touched.add(file.area);
    }

    // One commit touching four files in apps/web is one commit for apps/web.
    for (const area of touched) {
      const volume = volumes.get(area);
      if (volume) volume.commits += 1;
    }
  }

  return [...volumes.values()].sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      b.commits - a.commits ||
      a.area.localeCompare(b.area),
  );
}

function toChange(record: CommitRecord): Change {
  const { subject, body } = splitMessage(record.message);

  const areaChurn = new Map<RepoArea, number>();
  for (const file of record.files) {
    areaChurn.set(file.area, (areaChurn.get(file.area) ?? 0) + churn(file));
  }

  const areas = [...areaChurn.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([area]) => area);

  // The shown files are the biggest ones, not the first ones, a cap that keeps
  // an alphabetical accident and drops the rewrite is worse than no cap.
  const files = [...record.files]
    .sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES_PER_COMMIT);

  return {
    sha: record.sha,
    shortSha: record.sha.slice(0, 7),
    subject,
    body,
    authorName: record.authorName,
    authoredAt: record.authoredAt,
    additions: record.additions,
    deletions: record.deletions,
    filesChanged: record.filesChanged,
    files,
    areas,
    url: record.url,
  };
}

/**
 * What the caller knows about the shortfall, before this function turns it into
 * the payload's coverage.
 *
 * The two backends discover it in completely different ways. GitHub compares
 * the page it listed against the commits it managed to expand, git compares its
 * output against its own `--max-count`, so each computes this and hands it
 * over, rather than `assemble` trying to infer a cap from the records it was
 * given. A shortfall is invisible in the records: forty commits look exactly
 * like forty commits whether or not there were fifty.
 */
type Coverage = {
  /** Whether these records account for every commit in the window. */
  complete: boolean;
  /** Commits in the window as far as the backend could see; null if unknown. */
  inWindow: number | null;
  /** True when `inWindow` is a floor rather than an exact count. */
  inWindowAtLeast: boolean;
};

/** Everything was read. The common case, and the only one locally. */
const COMPLETE: Coverage = {
  complete: true,
  inWindow: null,
  inWindowAtLeast: false,
};

/**
 * The oldest day these records actually cover, as a UTC `YYYY-MM-DD`.
 *
 * Clamped to the start of the window: a commit whose author date predates the
 * window (a rebase does this) does not extend coverage backwards past days the
 * chart is not drawing anyway. Null when there is nothing to bound.
 */
function coveredFrom(
  ordered: CommitRecord[],
  now: Date,
  windowDays: number,
): string | null {
  const oldest = ordered[ordered.length - 1];
  if (!oldest) return null;
  const startKey = utcDayKey(windowStart(now, windowDays));
  const oldestKey = oldest.authoredAt.slice(0, 10);
  return oldestKey < startKey ? startKey : oldestKey;
}

/**
 * One rule, both backends: `activity`, `areas` and `totals` describe exactly
 * the commits this payload could account for in full, and `changes` is the
 * newest `limit` of that same set. Locally that set is the whole window; on
 * GitHub it is what was detailed, and the shortfall is a warning *and*
 * `totals.complete: false`, because the components that draw these numbers
 * cannot read a warning, and a sentence nobody can act on is how the tiles
 * ended up painting a partial count as the month's work.
 */
function assemble(
  source: ChangeSource,
  records: CommitRecord[],
  windowDays: number,
  limit: number,
  warnings: string[],
  now: Date,
  coverage: Coverage,
): ChangesPayload {
  const ordered = [...records].sort((a, b) =>
    b.authoredAt.localeCompare(a.authoredAt),
  );

  const activity = buildActivity(ordered, now, windowDays);

  if (activity.outOfWindow > 0) {
    warnings.push(
      `${activity.outOfWindow} of these commits were authored before the window and appear in the list but not in the chart, a rebase moves the commit date and leaves the author date behind.`,
    );
  }

  return {
    source,
    // These counts were computed from commits actually read. Whether they
    // account for the *whole window* is `totals.complete`, one field down.
    ok: true,
    changes: ordered.slice(0, limit).map(toChange),
    activity: activity.days,
    areas: buildAreas(ordered),
    totals: {
      commits: ordered.length,
      additions: ordered.reduce((sum, record) => sum + record.additions, 0),
      deletions: ordered.reduce((sum, record) => sum + record.deletions, 0),
      activeDays: activity.days.filter((day) => day.commits > 0).length,
      complete: coverage.complete,
    },
    // Null when complete: there is no shortfall to qualify, and an object full
    // of nulls would invite a component to render a hedge over a whole read.
    coverage: coverage.complete
      ? null
      : {
          inWindow: coverage.inWindow,
          inWindowAtLeast: coverage.inWindowAtLeast,
          from: coveredFrom(ordered, now, windowDays),
        },
    windowDays,
    fetchedAt: now.toISOString(),
    warnings,
  };
}

/** A failed read. Note the empty `activity`, see the header comment. */
function emptyPayload(
  source: ChangeSource,
  windowDays: number,
  warnings: string[],
  now: Date,
): ChangesPayload {
  return {
    source,
    // The whole point of this payload. Every number below is a filler value
    // standing in for something that could not be read, and `ok: false` is what
    // stops the page drawing them as a measurement of a quiet fortnight.
    ok: false,
    changes: [],
    activity: [],
    areas: [],
    // `complete: false` is not a second claim here, it is the same one: nothing
    // was measured, so nothing about the window is accounted for. `coverage`
    // stays null because there is no partial read to describe, a component
    // reading it must fall back to `ok`, which already says everything.
    totals: {
      commits: 0,
      additions: 0,
      deletions: 0,
      activeDays: 0,
      complete: false,
    },
    coverage: null,
    windowDays,
    fetchedAt: now.toISOString(),
    warnings,
  };
}

/* ----------------------------------------------------------- json reading -- */

// GitHub's response is `unknown` until proven otherwise. Casting it to a
// hand-written interface would type-check and still hand a component
// `undefined` where it expected a number, the first time a field moves.

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ---------------------------------------------------------------- github -- */

type RepoSlug = { owner: string; name: string; warning: string | null };

function repoSlug(): RepoSlug {
  const fallback = DEFAULT_REPO.split("/");
  const defaults = { owner: fallback[0] ?? "", name: fallback[1] ?? "" };

  const raw = process.env.HEALDESK_REPO?.trim();
  if (!raw) return { ...defaults, warning: null };

  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw);
  const owner = match?.[1];
  const name = match?.[2];

  if (!owner || !name) {
    return {
      ...defaults,
      warning: `HEALDESK_REPO is "${raw}", which is not owner/name, reading ${DEFAULT_REPO} instead.`,
    };
  }

  return { owner, name, warning: null };
}

type GitHubResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: "rate-limit"; resetAt: Date | null }
  | { ok: false; kind: "other"; message: string };

function rateLimitNote(resetAt: Date | null): string {
  return resetAt
    ? `GitHub's API rate limit is used up; it resets at ${resetAt.toISOString()}.`
    : "GitHub's API rate limit is used up and it did not say when it resets.";
}

async function githubGet(url: string, token: string): Promise<GitHubResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // The entire point is to show what changed a moment ago.
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, kind: "other", message: describeError(error) };
  }

  // A 403 from GitHub is usually a bad token and sometimes an exhausted limit.
  // The remaining-count header is what tells them apart, and they deserve very
  // different words in front of the owner.
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return {
        ok: false,
        kind: "rate-limit",
        resetAt:
          Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
      };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "other",
      message: `GitHub answered ${response.status} ${response.statusText || "(no status text)"}.`,
    };
  }

  try {
    const body: unknown = await response.json();
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      kind: "other",
      message: `GitHub's response was not JSON: ${describeError(error)}`,
    };
  }
}

function mapGitHubStatus(status: string | null): ChangedFile["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    // A copy is a new file at the new path, whatever produced it.
    case "copied":
      return "added";
    default:
      return "modified";
  }
}

function parseGitHubCommit(
  body: unknown,
  url: string,
  warnings: string[],
): CommitRecord | null {
  const root = readRecord(body);
  const sha = readString(root?.["sha"]);
  const commit = readRecord(root?.["commit"]);

  if (!root || !sha || !commit) {
    warnings.push(
      `A commit came back from GitHub in a shape this page could not read (${url}).`,
    );
    return null;
  }

  const commitAuthor = readRecord(commit["author"]);
  const commitCommitter = readRecord(commit["committer"]);
  const accountAuthor = readRecord(root["author"]);

  const authoredRaw =
    readString(commitAuthor?.["date"]) ?? readString(commitCommitter?.["date"]);
  const authoredAt = authoredRaw ? new Date(authoredRaw) : null;

  if (!authoredAt || Number.isNaN(authoredAt.getTime())) {
    warnings.push(
      `Commit ${sha.slice(0, 7)} has no readable date, so it is left out rather than dropped onto today.`,
    );
    return null;
  }

  const files: ChangedFile[] = [];
  const rawFiles = readArray(root["files"]);

  for (const entry of rawFiles) {
    const file = readRecord(entry);
    const path = readString(file?.["filename"]);
    if (!file || !path) continue;

    files.push({
      path,
      area: classifyArea(path),
      status: mapGitHubStatus(readString(file["status"])),
      additions: readNumber(file["additions"]) ?? 0,
      deletions: readNumber(file["deletions"]) ?? 0,
    });
  }

  if (rawFiles.length >= GITHUB_FILE_CAP) {
    warnings.push(
      `GitHub lists at most ${GITHUB_FILE_CAP} files per commit and ${sha.slice(0, 7)} hit that ceiling, so its area figures are partial.`,
    );
  }

  const stats = readRecord(root["stats"]);

  return {
    sha,
    authorName:
      readString(commitAuthor?.["name"]) ??
      readString(accountAuthor?.["login"]) ??
      "unknown",
    authoredAt: authoredAt.toISOString(),
    message: readString(commit["message"]) ?? "",
    url: readString(root["html_url"]),
    files,
    filesChanged: files.length,
    // The commit-level stats stay right even when the file list is truncated.
    additions:
      readNumber(stats?.["additions"]) ??
      files.reduce((sum, file) => sum + file.additions, 0),
    deletions:
      readNumber(stats?.["deletions"]) ??
      files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** Bounded worker pool. Forty commits at once is forty sockets and a 403. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

async function loadFromGitHub(
  token: string,
  cacheKey: string,
  windowDays: number,
  limit: number,
  warnings: string[],
  now: Date,
): Promise<LoadResult> {
  const slug = repoSlug();
  if (slug.warning) warnings.push(slug.warning);

  const repoPath = `${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.name)}`;
  const since = windowStart(now, windowDays).toISOString();
  const listUrl = `${GITHUB_API}/repos/${repoPath}/commits?since=${encodeURIComponent(since)}&per_page=${GITHUB_PAGE_SIZE}`;

  /** A rate limit is a wait, not an error. Show the last good read, say why. */
  const degrade = (note: string): LoadResult => {
    const cached = lastGoodPayload.get(cacheKey);
    if (cached) {
      return {
        payload: {
          ...cached,
          // fetchedAt stays as it was: this data is genuinely that old, and the
          // live indicator is supposed to say so.
          //
          // The cached payload's own warnings are kept. They described that
          // read and still do, and this call's warnings (a clamped argument, a
          // bad HEALDESK_REPO) are folded in without repeating any.
          warnings: [
            ...new Set([
              ...cached.warnings,
              ...warnings,
              note,
              "Showing the last successful read.",
            ]),
          ],
        },
        healthy: false,
      };
    }
    return {
      payload: emptyPayload("github", windowDays, [...warnings, note], now),
      healthy: false,
    };
  };

  const list = await githubGet(listUrl, token);

  if (!list.ok) {
    return degrade(
      list.kind === "rate-limit"
        ? rateLimitNote(list.resetAt)
        : `GitHub could not be read: ${list.message}`,
    );
  }

  if (!Array.isArray(list.body)) {
    return degrade("GitHub returned something other than a list of commits.");
  }

  const shas: string[] = [];
  for (const entry of list.body) {
    const sha = readString(readRecord(entry)?.["sha"]);
    if (sha) shas.push(sha);
  }

  // One page. Saying "at least" when the page filled up matters: the true
  // number is unknown from here, and a precise-looking 100 would be a guess.
  const pageFull = list.body.length >= GITHUB_PAGE_SIZE;
  if (pageFull) {
    warnings.push(
      `GitHub was asked for one page, so this counts the newest ${GITHUB_PAGE_SIZE} commits in the window and no more.`,
    );
  }

  const wanted = shas.slice(0, limit);
  if (shas.length > wanted.length) {
    warnings.push(
      `The window holds ${pageFull ? "at least " : ""}${shas.length} commits and this view covers the newest ${wanted.length}; the chart, totals and area figures describe those ${wanted.length}.`,
    );
  }

  let rateLimitResetAt: Date | null = null;
  let sawRateLimit = false;
  let failedDetails = 0;

  const records = await mapWithConcurrency(
    wanted,
    DETAIL_CONCURRENCY,
    async (sha): Promise<CommitRecord | null> => {
      const detailKey = `${slug.owner}/${slug.name}@${sha}`;
      const cached = detailCache.get(detailKey);
      if (cached) return cached;

      // Once the limit is gone it is gone. Firing the rest of the queue at it
      // spends nothing but goodwill, and secondary limits punish exactly this.
      if (sawRateLimit) return null;

      const url = `${GITHUB_API}/repos/${repoPath}/commits/${encodeURIComponent(sha)}`;
      const detail = await githubGet(url, token);

      if (!detail.ok) {
        if (detail.kind === "rate-limit") {
          sawRateLimit = true;
          rateLimitResetAt = detail.resetAt;
        } else {
          failedDetails += 1;
        }
        return null;
      }

      // A commit that could not be read is left out rather than shown with
      // zeroed counts, which would look like a commit that changed nothing.
      const record = parseGitHubCommit(detail.body, url, warnings);
      if (record) rememberDetail(detailKey, record);
      return record;
    },
  );

  const usable = records.filter(
    (record): record is CommitRecord => record !== null,
  );

  if (sawRateLimit) {
    // Partial data mid-refresh: the last good payload is more honest than a
    // feed that silently lost half its commits.
    const note = rateLimitNote(rateLimitResetAt);
    if (lastGoodPayload.has(cacheKey)) return degrade(note);
    warnings.push(
      `${note} ${wanted.length - usable.length} of ${wanted.length} commits are missing from this read.`,
    );
  }

  if (failedDetails > 0) {
    warnings.push(
      `${failedDetails} of ${wanted.length} commits could not be fetched in full and are left out of the list and the chart rather than shown with zeroed counts.`,
    );
  }

  if (wanted.length > 0 && usable.length === 0) {
    // The list read fine, so there is work. We simply could not measure any of
    // it. Assembling here would produce a month of zeroed days, which draws as
    // silence. The empty payload draws as "we could not look", which is true.
    return {
      payload: emptyPayload("github", windowDays, warnings, now),
      healthy: false,
    };
  }

  // The whole point of the field. `usable` is the newest `limit` commits of the
  // page that were expanded, not the commits in the window, and every
  // aggregate below is computed from it. It accounts for the window only when
  // the page did not fill (so there is nothing older to miss) and every sha on
  // it came back (so nothing in the middle was dropped by a rate limit or a
  // failed detail call).
  const coverage: Coverage = {
    complete: !pageFull && usable.length === shas.length,
    inWindow: shas.length,
    inWindowAtLeast: pageFull,
  };

  return {
    payload: assemble(
      "github",
      usable,
      windowDays,
      limit,
      warnings,
      now,
      coverage,
    ),
    healthy: !sawRateLimit && failedDetails === 0,
  };
}

/* ------------------------------------------------------------- local git -- */

const execFileAsync = promisify(execFile);

/**
 * ASCII record and field separators. A commit body can contain anything a
 * keyboard produces; it will not contain these.
 */
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const NUL = "\u0000";

/**
 * Walk up from cwd looking for `.git`. Next's cwd is the app directory in dev
 * and can be elsewhere in a build, so the root is found rather than assumed.
 * `.git` is a file in a worktree and a directory in a normal clone; `access`
 * does not care, which is why it is used instead of a stat-and-check.
 */
async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);

  for (;;) {
    try {
      await access(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function mapRawStatus(letter: string): ChangedFile["status"] {
  switch (letter.charAt(0).toUpperCase()) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "added";
    // M, T (type change), and anything git adds later.
    default:
      return "modified";
  }
}

/**
 * `--raw --numstat -z` prints both blocks for the same diff: raw carries the
 * status letter, numstat carries the line counts, and neither carries both.
 * Under `-z` every path is its own NUL-terminated token, so a path containing a
 * space, a quote or a newline parses correctly instead of quietly splitting
 * into two files.
 *
 * The file list is built from numstat. A file that appeared in raw but not in
 * numstat, which ordinary diffs do not produce, is dropped rather than shown
 * with invented counts.
 */
function parseStatBlock(block: string): ChangedFile[] {
  const tokens = block.split(NUL);
  const statuses = new Map<string, ChangedFile["status"]>();
  const counts = new Map<string, { additions: number; deletions: number }>();

  let index = 0;
  while (index < tokens.length) {
    // The first token carries the newline separating the pretty output from the
    // diff. Paths never do, `-z` terminates them with NUL.
    const token = (tokens[index] ?? "").replace(/^\n+/, "");
    index += 1;

    if (token.startsWith(":")) {
      const status = token.split(/\s+/).pop() ?? "";
      const paired = status.startsWith("R") || status.startsWith("C");
      let path = tokens[index];
      index += 1;
      if (paired) {
        // Old path, then new. The new one is where the file lives now.
        path = tokens[index];
        index += 1;
      }
      if (path) statuses.set(path, mapRawStatus(status));
      continue;
    }

    const numstat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!numstat) continue;

    const [, additionsRaw, deletionsRaw, pathRaw] = numstat;
    let path = pathRaw ?? "";

    if (path === "") {
      // A rename under `-z`: the old and new paths follow as two tokens.
      const oldPath = tokens[index];
      index += 1;
      const newPath = tokens[index];
      index += 1;
      path = newPath ?? oldPath ?? "";
    }

    if (path === "") continue;

    // "-" means binary. Zero is what both backends report for those.
    const additions = additionsRaw === "-" ? 0 : Number(additionsRaw);
    const deletions = deletionsRaw === "-" ? 0 : Number(deletionsRaw);

    counts.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }

  return [...counts.entries()].map(([path, count]) => ({
    path,
    area: classifyArea(path),
    status: statuses.get(path) ?? "modified",
    additions: count.additions,
    deletions: count.deletions,
  }));
}

/**
 * Returns the dropped count alongside the records: a commit git printed and
 * this parser could not read is a commit missing from every total below, which
 * is exactly the kind of shortfall `totals.complete` exists to state.
 */
function parseGitLog(
  stdout: string,
  warnings: string[],
): { records: CommitRecord[]; unreadable: number } {
  const records: CommitRecord[] = [];
  let unreadable = 0;

  for (const chunk of stdout.split(RECORD_SEPARATOR)) {
    if (chunk.trim() === "") continue;

    const parts = chunk.split(FIELD_SEPARATOR);
    const sha = (parts[0] ?? "").trim();
    const authorName = (parts[1] ?? "").trim();
    const authoredRaw = (parts[2] ?? "").trim();

    if (parts.length < 5 || sha === "") {
      unreadable += 1;
      continue;
    }

    const authoredAt = new Date(authoredRaw);
    if (Number.isNaN(authoredAt.getTime())) {
      unreadable += 1;
      continue;
    }

    // The message is everything between the date and the trailing separator, so
    // a body that somehow contained a separator byte still reassembles.
    const message = parts.slice(3, -1).join(FIELD_SEPARATOR);
    const files = parseStatBlock(parts[parts.length - 1] ?? "");

    records.push({
      sha,
      authorName: authorName === "" ? "unknown" : authorName,
      authoredAt: authoredAt.toISOString(),
      message,
      // No web URL exists for a commit that may not be pushed. The type allows
      // null precisely so this is not faked into a link that 404s.
      url: null,
      files,
      filesChanged: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    });
  }

  if (unreadable > 0) {
    warnings.push(
      `${unreadable} commits came out of git in a shape this page could not read and are left out.`,
    );
  }

  return { records, unreadable };
}

async function loadFromLocalGit(
  windowDays: number,
  limit: number,
  warnings: string[],
  now: Date,
): Promise<LoadResult> {
  const root = await findRepoRoot(process.cwd());

  if (!root) {
    return {
      payload: emptyPayload(
        "local-git",
        windowDays,
        [
          ...warnings,
          "No GITHUB_TOKEN is set and no git checkout was found above the working directory, so there is nothing to read.",
        ],
        now,
      ),
      healthy: false,
    };
  }

  const since = windowStart(now, windowDays).toISOString();
  const format = `${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%B${FIELD_SEPARATOR}`;

  let stdout: string;
  try {
    // An argv array, never a shell string. See the header comment.
    const result = await execFileAsync(
      "git",
      [
        "log",
        `--since=${since}`,
        `--max-count=${LOCAL_MAX_COMMITS}`,
        "--no-color",
        "--raw",
        "--numstat",
        "-z",
        `--pretty=format:${format}`,
      ],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    return {
      payload: emptyPayload(
        "local-git",
        windowDays,
        [...warnings, `git could not be read: ${describeError(error)}`],
        now,
      ),
      healthy: false,
    };
  }

  const { records, unreadable } = parseGitLog(stdout, warnings);

  // Against what git *printed*, not what parsed: two unreadable records out of
  // five hundred would otherwise read as 498 and hide the cap entirely.
  const printed = records.length + unreadable;
  const hitCap = printed >= LOCAL_MAX_COMMITS;

  if (hitCap) {
    warnings.push(
      `git was asked for at most ${LOCAL_MAX_COMMITS} commits and returned that many, so anything older inside this window is not counted.`,
    );
  }

  if (records.length > limit) {
    warnings.push(
      `The feed lists the newest ${limit} of ${records.length} commits in the window. The chart, totals and area figures count all ${records.length}.`,
    );
  }

  // Unlike the GitHub path, this one aggregates every commit it read rather
  // than the newest `limit` of them, the feed is capped, the numbers are not.
  // So it is complete unless git itself was cut off at `--max-count` or a
  // record came out unparseable. `inWindow` counts what git printed, readable
  // or not, and is a floor exactly when the cap was hit.
  const coverage: Coverage =
    hitCap || unreadable > 0
      ? { complete: false, inWindow: printed, inWindowAtLeast: hitCap }
      : COMPLETE;

  return {
    payload: assemble(
      "local-git",
      records,
      windowDays,
      limit,
      warnings,
      now,
      coverage,
    ),
    healthy: true,
  };
}

/* ------------------------------------------------------------------- api -- */

/**
 * The one entry point. Never throws, see the header comment.
 *
 * `windowDays` defaults to 30 and `limit` to 40. Both are clamped, with a
 * warning when they are, so a caller asking for five years of history gets a
 * year and is told, rather than a year presented as five.
 */
export async function loadChanges(
  opts: { windowDays?: number; limit?: number } = {},
): Promise<ChangesPayload> {
  const warnings: string[] = [];

  const requestedWindow = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const requestedLimit = opts.limit ?? DEFAULT_LIMIT;
  const windowDays = clampInt(requestedWindow, 1, MAX_WINDOW_DAYS);
  const limit = clampInt(requestedLimit, 1, MAX_LIMIT);

  if (windowDays !== requestedWindow) {
    warnings.push(`Asked for ${requestedWindow} days; showing ${windowDays}.`);
  }
  if (limit !== requestedLimit) {
    warnings.push(`Asked for ${requestedLimit} commits; showing ${limit}.`);
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  const source: ChangeSource = token ? "github" : "local-git";
  const slug = token ? repoSlug() : null;
  const cacheKey = `${source}:${slug ? `${slug.owner}/${slug.name}` : "checkout"}:${windowDays}:${limit}`;

  const cached = payloadCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < PAYLOAD_TTL_MS) {
    return cached.payload;
  }

  const now = new Date();
  let result: LoadResult;

  try {
    result = token
      ? await loadFromGitHub(token, cacheKey, windowDays, limit, warnings, now)
      : await loadFromLocalGit(windowDays, limit, warnings, now);
  } catch (error) {
    // Nothing above is meant to throw. If something does it is a bug in this
    // file, and the page still has to render something honest.
    result = {
      payload: emptyPayload(
        source,
        windowDays,
        [
          ...warnings,
          `The change feed failed unexpectedly: ${describeError(error)}`,
        ],
        now,
      ),
      healthy: false,
    };
  }

  // A degraded read is cached for the TTL, otherwise a rate limit turns every
  // poll into another request against the limit that caused it, but it never
  // replaces the last good payload, which is what the fallback shows.
  remember(payloadCache, PAYLOAD_CACHE_MAX, cacheKey, {
    storedAt: Date.now(),
    payload: result.payload,
  });
  if (result.healthy) {
    remember(lastGoodPayload, PAYLOAD_CACHE_MAX, cacheKey, result.payload);
  }

  return result.payload;
}
