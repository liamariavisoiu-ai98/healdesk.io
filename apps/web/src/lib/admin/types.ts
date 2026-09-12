/**
 * The contract between the admin page's data sources and everything that draws
 * them.
 *
 * This file is types only, no runtime code, no imports, so both the server
 * modules that produce these shapes and the client components that render them
 * can depend on it without dragging a dependency across the boundary.
 *
 * ## Why the shapes are deliberately flat
 *
 * Everything here crosses the network as JSON from a route handler to a client
 * component that polls. Dates are ISO strings rather than `Date`, because a
 * `Date` does not survive `JSON.stringify` and the silent failure is a string
 * where a component expected a method. Numbers are pre-computed server-side so
 * the browser never re-derives a total that the server already knows.
 */

/* ---------------------------------------------------------------- changes -- */

/** Where a commit list came from. Surfaced in the UI so it is never ambiguous. */
export type ChangeSource =
  /** Read from the GitHub API. Works when deployed; reflects what is pushed. */
  | "github"
  /** Read from the local checkout with `git log`. Dev only; includes unpushed. */
  | "local-git"
  /**
   * No backend was reached, so there is no source to name.
   *
   * This member exists because the alternative was worse. A payload built on
   * the failure path still has to fill this field, and without an "unknown" the
   * only options were to name a backend that was never read, which the page
   * renders as the confident sentence "Reading github.com", or to guess one
   * from `NODE_ENV`, which two separate files had independently started doing.
   * Both are a guess rendered as a fact, which this codebase does not do.
   *
   * Only ever appears with `ok: false`. A loader that knows which backend it
   * tried and failed on still names that backend: "we asked GitHub and it
   * refused" is a fact worth keeping, and it is not this.
   */
  | "unknown";

/** One top-level area of the repo, used to say *where* change is concentrated. */
export type RepoArea =
  | "apps/web"
  | "apps/app"
  | "packages/leadgen"
  | "packages/connectors"
  | "packages/catalog"
  | "docs"
  | "scripts"
  | "ci"
  | "other";

export const REPO_AREAS: readonly RepoArea[] = [
  "apps/web",
  "apps/app",
  "packages/leadgen",
  "packages/connectors",
  "packages/catalog",
  "docs",
  "scripts",
  "ci",
  "other",
] as const;

/** A file touched by a commit. */
export type ChangedFile = {
  path: string;
  area: RepoArea;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
};

/**
 * One commit, already summarised.
 *
 * `subject` and `body` are split because this repo writes long, explanatory
 * commit messages, the subject is the headline the timeline shows, the body is
 * the reasoning revealed on expand. Rendering the whole thing in a list would
 * make the feed unreadable.
 */
export type Change = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  /** ISO 8601. Authored time, not committed time. It is the one people mean. */
  authoredAt: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  /** Capped server-side; `filesChanged` carries the true count. */
  files: ChangedFile[];
  /** Areas this commit touched, most-changed first. Drives the area pills. */
  areas: RepoArea[];
  /** Web URL on GitHub, or null when read from a local checkout. */
  url: string | null;
};

/** A single day's activity, for the sparkline. Gapless, quiet days are zeros. */
export type ActivityDay = {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  commits: number;
  additions: number;
  deletions: number;
};

/** How much change each area absorbed over the window. */
export type AreaVolume = {
  area: RepoArea;
  commits: number;
  additions: number;
  deletions: number;
};

/**
 * What a partial read actually covered.
 *
 * The GitHub backend expands only the newest `limit` commits of the window, and
 * every aggregate, `activity`, `areas`, `totals`, is computed from those. So
 * a window holding fifty commits reports the newest forty and, without this,
 * reports them as if they were the fifty. `ok` cannot carry that: the read
 * succeeded and the numbers are real, they simply describe less than the window
 * the page is labelled with. This is the field that lets a component say
 * "40+" and hatch the days it never saw, instead of drawing them as zero.
 */
export type ChangeCoverage = {
  /**
   * How many commits the window holds, as far as the backend could see, or
   * null when it could not say at all.
   */
  inWindow: number | null;
  /**
   * True when `inWindow` is a floor rather than an exact count. GitHub was
   * asked for one page and the page filled, so the real number is unknown and
   * "50" would be a guess where "at least 100" is a fact.
   */
  inWindowAtLeast: boolean;
  /**
   * Oldest UTC day (YYYY-MM-DD) the counted commits reach back to.
   *
   * Days *before* it are not covered by this read and must not be drawn as
   * zero, a zero there is a claim that nobody committed, when the truth is
   * that nobody looked. The day itself may be partial: the oldest counted
   * commit can be the third of five that landed that day.
   *
   * Null when nothing was counted, which leaves nothing to bound.
   */
  from: string | null;
};

export type ChangesPayload = {
  source: ChangeSource;
  /**
   * Whether the numbers below are a measurement or an absence.
   *
   * This is the most important field in the file, because without it every
   * number here lies in exactly one direction. `totals` cannot hold "unknown",
   * the fields are required numbers, so a read that failed produces four zeros
   * that are byte-identical to a genuinely quiet fortnight. The UI then draws
   * "0 commits" in brand colours over a repository it simply could not open.
   *
   * `false` means: nothing was read, and every count below is a filler value.
   * Render an honest absence, an em-dash, not a zero. `true` means the counts
   * were actually computed, even if `warnings` says something was capped or
   * partial along the way.
   *
   * It is deliberately *not* `warnings.length === 0`. A healthy read warns about
   * things that do not invalidate it, a `HEALDESK_REPO` that had to fall back
   * to the default, and treating those as an absence would blank a page full
   * of real data. Trouble and unmeasured are different questions and each gets
   * its own field; how *much* was measured is a third, and it is
   * `totals.complete`.
   */
  ok: boolean;
  /** Newest first. */
  changes: Change[];
  activity: ActivityDay[];
  areas: AreaVolume[];
  totals: {
    commits: number;
    additions: number;
    deletions: number;
    /** Distinct days with at least one commit, among the commits counted. */
    activeDays: number;
    /**
     * Whether the four numbers above account for the whole window.
     *
     * `ok` says the numbers are a measurement; this says how much they measure.
     * They are different questions and the answer to the first was being used
     * for both: a GitHub read that expanded the newest forty of fifty commits
     * came back `ok: true` with four totals that described forty and a
     * `windowDays` that said thirty days, so the page painted a partial count
     * in brand colours as the month's work.
     *
     * False means every number here is a floor. Render it as one, a `+`, a
     * dropped emphasis, a hatched region on the chart, and read `coverage`
     * for what the shortfall actually was.
     */
    complete: boolean;
  };
  /**
   * What a partial read covered, or null.
   *
   * Null when `totals.complete` is true. There is nothing to qualify, and
   * null when `ok` is false, because a read that measured nothing has no
   * coverage to describe either.
   */
  coverage: ChangeCoverage | null;
  /** How many days back the window reaches. */
  windowDays: number;
  /** ISO 8601, stamped when the server built this payload. */
  fetchedAt: string;
  /**
   * Non-fatal problems worth showing rather than swallowing, a rate-limited
   * GitHub call, a missing token, a truncated file list. Empty when clean.
   */
  warnings: string[];
};

/* ---------------------------------------------------------------- roadmap -- */

/** Mirrors the `status` field in scripts/docs-site/tasks.mjs. */
export type TaskStatus =
  /** Nothing blocks it. */
  | "ready"
  /** Waiting on a third party. */
  | "vendor"
  /** Waiting on a lawyer. */
  | "counsel"
  /** Needs a decision. */
  | "decision";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "ready",
  "vendor",
  "counsel",
  "decision",
] as const;

export type RoadmapTask = {
  id: string;
  group: string;
  status: TaskStatus;
  /** Task id this one waits on, or null. Drives the dependency chains. */
  blockedBy: string | null;
  title: string;
  /** Human estimate as written, e.g. "2 minutes". Free text, never parsed. */
  effort: string | null;
  /** The plain-English explanation. */
  plain: string;
};

export type RoadmapGroup = {
  id: string;
  title: string;
  blurb: string;
  tasks: RoadmapTask[];
};

export type RoadmapPayload = {
  /**
   * Whether the task list was actually read.
   *
   * The same problem as `ChangesPayload.ok`, in a sharper form: `groups: []`
   * with `totals.tasks: 0` is byte-identical to a roadmap where every last task
   * is done. One of those deserves a celebration and the other is a broken
   * read, and a board that picks wrong is either hiding a failure or claiming
   * an achievement nobody earned.
   *
   * This is not hypothetical on a deployed instance. `scripts/` is not traced
   * into the web app's build output, so off a full checkout the loader returns
   * exactly this empty payload, meaning the deployed board's *default* state
   * is the one that needs telling apart.
   */
  ok: boolean;
  groups: RoadmapGroup[];
  totals: {
    tasks: number;
    /** Keyed by status; every status present, zero-filled. */
    byStatus: Record<TaskStatus, number>;
  };
  fetchedAt: string;
  warnings: string[];
};
