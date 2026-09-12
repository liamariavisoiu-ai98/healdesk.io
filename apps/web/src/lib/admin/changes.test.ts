import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  REPO_AREAS,
  type ActivityDay,
  type ChangedFile,
  type RepoArea,
} from "@/lib/admin/types";

import { classifyArea, loadChanges } from "./changes";

/**
 * The pure parts of the change feed, tested without touching a network or a
 * checkout.
 *
 * Most of `loadChanges` is deliberately not tested here. One backend is the
 * GitHub API and the other shells out to `git log`, so a test of it would
 * either hit the network, making this suite depend on a rate limit and a
 * token, or mock both, which proves the mocks agree with each other and
 * nothing else. What is worth guarding is the shaping code that both backends
 * feed: path classification, the day rollup, and the subject/body split. All
 * three are pure, all three are wrong silently rather than loudly, and all
 * three rot the moment someone adds a directory or rewords a commit template.
 *
 * The one exception is at the bottom of this file, and it is there because the
 * property it guards cannot be reached any other way. Whether the aggregates
 * cover the window is the difference between the commits GitHub *listed* and
 * the commits the loader managed to *expand*, a difference that exists only
 * inside `loadFromGitHub` and is invisible in the records that come out of it,
 * because forty commits look exactly like forty commits whether or not there
 * were fifty. That gap shipped once: every total was computed from the newest
 * forty, `ok: true` said they were a measurement, and nothing said of what. A
 * stubbed `fetch` is the only place that regression can be caught, so it is
 * caught there, and the stub is deliberately thin, one list response, one
 * detail response, no attempt to model GitHub beyond the two fields this
 * question turns on.
 */

/* ------------------------------------------------------ module internals -- */

/**
 * `buildActivity` and `splitMessage` are module-private in changes.ts.
 *
 * They are reached by name here rather than through `loadChanges`, because the
 * only route to them through `loadChanges` is a network call, and properties
 * this load-bearing should not go untested whenever the network is down.
 *
 * If you are reading this because these suites failed: add `export` to
 * `function buildActivity` and `function splitMessage` in
 * apps/web/src/lib/admin/changes.ts. Nothing else needs to change, and this
 * indirection can then collapse into a plain named import.
 */
async function changesExports(): Promise<Record<string, unknown>> {
  const loaded: unknown = await import("./changes");
  if (!isRecord(loaded)) {
    throw new Error("lib/admin/changes.ts did not load as a module.");
  }
  return loaded;
}

function requireExport<T>(
  exports: Record<string, unknown>,
  name: string,
  signature: string,
): T {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new Error(
      `lib/admin/changes.ts does not export ${name}. Add the export keyword to ` +
        `it, the shape these tests call is ${name}${signature}, so the ` +
        `property below is tested directly rather than only through a network ` +
        `call.`,
    );
  }
  // The cast is the price of reaching for a module-private function. The
  // assertions are what check the shape named above is still the real one: a
  // changed argument order or return type fails here, loudly, with the source
  // printed.
  return value as unknown as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps the elements `unknown` rather than letting `any[]` in through the door. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isActivityDay(value: unknown): value is ActivityDay {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value.commits === "number" &&
    typeof value.additions === "number" &&
    typeof value.deletions === "number"
  );
}

/**
 * The rollup returns either the day array itself or a record carrying it as
 * `days` next to a count of the commits that fell outside the window. Both are
 * defensible and the gapless property is identical either way, so this accepts
 * both and fails with the actual value on anything else.
 *
 * It doubles as a check that every entry really is an `ActivityDay`: the chart
 * reads four fields off each one and would render `undefined` as a gap in the
 * line rather than an error.
 */
function activityDays(result: unknown): ActivityDay[] {
  const candidate = isRecord(result) && "days" in result ? result.days : result;

  if (!isUnknownArray(candidate) || !candidate.every(isActivityDay)) {
    throw new Error(
      `buildActivity returned neither ActivityDay[] nor { days: ActivityDay[] }: ${JSON.stringify(result)}`,
    );
  }
  return candidate;
}

/** Mirrors the module-private `CommitRecord` in changes.ts. */
type CommitRecordShape = {
  sha: string;
  authorName: string;
  authoredAt: string;
  message: string;
  url: string | null;
  files: ChangedFile[];
  filesChanged: number;
  additions: number;
  deletions: number;
};

type BuildActivity = (
  records: CommitRecordShape[],
  now: Date,
  windowDays: number,
) => unknown;

type SplitMessage = (message: string) => { subject: string; body: string };

function commit(
  authoredAt: string,
  additions: number,
  deletions: number,
): CommitRecordShape {
  return {
    sha: `sha-${authoredAt}`,
    authorName: "Test Author",
    authoredAt,
    message: "A commit",
    url: null,
    files: [],
    filesChanged: 0,
    additions,
    deletions,
  };
}

/* --------------------------------------------------------- classification -- */

/**
 * One example per RepoArea. The completeness check below is what stops this
 * table falling behind the union. A path filed under the wrong area does not
 * throw. It quietly moves a bar on the breakdown chart, which is a wrong
 * answer rendered as a fact.
 */
const CLASSIFICATIONS: ReadonlyArray<readonly [string, RepoArea]> = [
  ["apps/web/src/lib/admin/changes.ts", "apps/web"],
  ["apps/app/src/lib/crypto/envelope.ts", "apps/app"],
  ["packages/leadgen/src/pipeline.ts", "packages/leadgen"],
  ["packages/connectors/src/index.ts", "packages/connectors"],
  ["packages/catalog/src/plans.ts", "packages/catalog"],
  ["docs/hipaa-compliance.md", "docs"],
  ["scripts/docs-site/tasks.mjs", "scripts"],
  [".github/workflows/ci.yml", "ci"],
  ["README.md", "other"],
];

describe("classifyArea", () => {
  test("every area has a path that lands in it", () => {
    for (const [path, area] of CLASSIFICATIONS) {
      expect(classifyArea(path), path).toBe(area);
    }
  });

  test("the table above covers all nine areas", () => {
    // Without this, adding a tenth RepoArea passes every test in this file
    // while nothing anywhere proves a single path can reach it.
    const covered = new Set(CLASSIFICATIONS.map(([, area]) => area));
    for (const area of REPO_AREAS) {
      expect(covered.has(area), `no example path for ${area}`).toBe(true);
    }
  });

  test("matching is by path segment, not by string prefix", () => {
    // `startsWith("apps/web")` is the obvious implementation and it is wrong:
    // it files a hypothetical apps/webhooks under the marketing site. None of
    // these directories exist today, which is exactly why nobody would notice
    // the day one of them does.
    expect(classifyArea("apps/webhooks/route.ts")).toBe("other");
    expect(classifyArea("docsite/index.html")).toBe("other");
    expect(classifyArea("packages/catalogue/src/index.ts")).toBe("other");
  });

  test("an unmatched path is other, and nothing escapes the union", () => {
    // "other" is an honest bucket, not a guess at the nearest area. What this
    // guards is a classifier returning undefined or a bare string for an odd
    // path, which reaches the feed as an empty pill.
    for (const path of [
      "",
      "/",
      "apps",
      "package-lock.json",
      "turbo.json",
      ".DS_Store",
    ]) {
      expect(REPO_AREAS, path).toContain(classifyArea(path));
    }
    expect(classifyArea("README.md")).toBe("other");
  });
});

/* --------------------------------------------------------- the day rollup -- */

describe("the activity rollup is gapless", () => {
  let buildActivity: BuildActivity;

  beforeAll(async () => {
    buildActivity = requireExport<BuildActivity>(
      await changesExports(),
      "buildActivity",
      "(records, now, windowDays)",
    );
  });

  /** Fixed, because the buckets are UTC days and a floating "now" is a flake. */
  const NOW = new Date("2026-03-12T09:41:00.000Z");

  test("two commits on non-adjacent days still produce seven days", () => {
    const activity = activityDays(
      buildActivity(
        [
          commit("2026-03-11T04:05:00.000Z", 7, 55),
          commit("2026-03-08T23:10:00.000Z", 120, 4),
        ],
        NOW,
        7,
      ),
    );

    expect(activity).toHaveLength(7);
    expect(activity.map((day) => day.date)).toEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);

    const byDate = new Map(activity.map((day) => [day.date, day]));
    expect(byDate.get("2026-03-08")).toEqual({
      date: "2026-03-08",
      commits: 1,
      additions: 120,
      deletions: 4,
    });
    expect(byDate.get("2026-03-11")).toEqual({
      date: "2026-03-11",
      commits: 1,
      additions: 7,
      deletions: 55,
    });

    // The whole point. A sparkline built only from the days that had commits
    // draws a straight line from the 8th to the 11th and reads as steady work,
    // when what actually happened was two days of nothing.
    for (const date of [
      "2026-03-06",
      "2026-03-07",
      "2026-03-09",
      "2026-03-10",
      "2026-03-12",
    ]) {
      expect(byDate.get(date), date).toEqual({
        date,
        commits: 0,
        additions: 0,
        deletions: 0,
      });
    }
  });

  test("a commit outside the window is dropped, not clamped onto an edge day", () => {
    const activity = activityDays(
      buildActivity(
        [
          commit("2026-03-11T04:05:00.000Z", 7, 55),
          commit("2026-03-08T23:10:00.000Z", 120, 4),
          // Six weeks before the window opens. Clamping this onto the first day
          // would paint a 900-line spike on a day that had no work at all.
          commit("2026-02-01T12:00:00.000Z", 900, 900),
        ],
        NOW,
        7,
      ),
    );

    expect(activity).toHaveLength(7);
    expect(activity[0]).toEqual({
      date: "2026-03-06",
      commits: 0,
      additions: 0,
      deletions: 0,
    });

    expect(activity.reduce((sum, day) => sum + day.commits, 0)).toBe(2);
    expect(activity.reduce((sum, day) => sum + day.additions, 0)).toBe(127);
    expect(activity.reduce((sum, day) => sum + day.deletions, 0)).toBe(59);
  });

  test("several commits on one day are summed onto that day", () => {
    const activity = activityDays(
      buildActivity(
        [
          commit("2026-03-10T08:00:00.000Z", 10, 1),
          commit("2026-03-10T19:30:00.000Z", 5, 2),
        ],
        NOW,
        7,
      ),
    );

    expect(activity.find((day) => day.date === "2026-03-10")).toEqual({
      date: "2026-03-10",
      commits: 2,
      additions: 15,
      deletions: 3,
    });
  });

  test("an empty window is seven zeros, not an empty array", () => {
    // An honest absence still has a shape. A chart handed [] has to invent an
    // axis, and an invented axis is a rendered guess.
    const activity = activityDays(buildActivity([], NOW, 7));
    expect(activity).toHaveLength(7);
    expect(activity.every((day) => day.commits === 0)).toBe(true);
  });

  test("the window walks back across a month boundary", () => {
    // Naive date arithmetic, subtracting from the day-of-month number,
    // produces "2028-03-00" here. February, and leap years, are where it shows.
    const activity = activityDays(
      buildActivity([], new Date("2028-03-01T00:30:00.000Z"), 3),
    );
    expect(activity.map((day) => day.date)).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });
});

/* ------------------------------------------------------ subject and body -- */

describe("splitting a commit message", () => {
  let splitMessage: SplitMessage;

  beforeAll(async () => {
    splitMessage = requireExport<SplitMessage>(
      await changesExports(),
      "splitMessage",
      "(message)",
    );
  });

  test("the first blank line divides headline from reasoning", () => {
    const { subject, body } = splitMessage(
      [
        "Stop shipping 95 blank-copy rows in the campaign-ready files",
        "",
        "The exporter wrote a row per contact whether or not the copy step had",
        "produced anything for it.",
        "",
        "The alternative was filtering at send time, which hides the gap.",
      ].join("\n"),
    );

    expect(subject).toBe(
      "Stop shipping 95 blank-copy rows in the campaign-ready files",
    );
    expect(body).toContain("The exporter wrote a row per contact");
    expect(body).toContain("The alternative was filtering at send time");

    // The body is the reasoning and only the reasoning: the subject is not
    // repeated into it, and the blank separator line is not carried along as
    // leading whitespace, which the feed would render as a gap above the text.
    expect(body).not.toContain("Stop shipping 95 blank-copy rows");
    expect(body.trimStart()).toBe(body);

    // The paragraph break inside the body survives. It is the thing that makes
    // a long message readable once the feed expands it.
    expect(body).toMatch(/\n\s*\n/);
  });

  test("a one-line message has an empty body, not a duplicated subject", () => {
    const { subject, body } = splitMessage(
      "Add the CAN-SPAM footer and the procedure that makes it true",
    );

    expect(subject).toBe(
      "Add the CAN-SPAM footer and the procedure that makes it true",
    );
    // Empty. A feed that repeats the subject underneath itself as the "body"
    // is the failure this asserts against.
    expect(body).toBe("");
  });

  test("trailing newlines do not become a body", () => {
    // git hands over a trailing newline on almost every commit, and a body of
    // "\n\n" is truthy. It would expand the feed row onto nothing.
    const { subject, body } = splitMessage(
      "Fetch the booking page after all\n\n",
    );
    expect(subject).toBe("Fetch the booking page after all");
    expect(body).toBe("");
  });

  test("a subject wrapped over two lines is joined, not truncated", () => {
    const { subject, body } = splitMessage(
      "Reframe the copy toward what they gain,\nand offer the right surfaces",
    );

    expect(subject).toBe(
      "Reframe the copy toward what they gain, and offer the right surfaces",
    );
    expect(body).toBe("");
  });

  test("CRLF is handled, because a message can arrive either way", () => {
    const { subject, body } = splitMessage(
      "Match the wording to the reader\r\n\r\nThe reader is an office manager.",
    );
    expect(subject).toBe("Match the wording to the reader");
    expect(body).toBe("The reader is an office manager.");
  });

  test("an empty message gets a placeholder subject, never a blank one", () => {
    // A blank row in the feed reads as a rendering bug. Something has to be
    // said, and what is said must not be a guess assembled from the diff.
    const { subject, body } = splitMessage("   \n  \n ");
    expect(subject.trim().length).toBeGreaterThan(0);
    expect(body).toBe("");
  });
});

/* ------------------------------------------------- what the read covered -- */

/**
 * A GitHub read that could not account for the whole window has to say so in
 * the payload, not only in a warning.
 *
 * The bug these guard: `assemble` was handed the commits that were expanded,
 * the newest `limit` of the page, and stamped `ok: true` on totals computed
 * from them. The strip then printed that number in the brand gradient as the
 * month's work and the chart drew the days before it as zero-commit days. The
 * warning naming the shortfall was correct the whole time and no component can
 * read a sentence.
 *
 * Every test uses its own `HEALDESK_REPO` and its own shas. The loader's caches
 * are module-scoped and keyed by repo, a shared name would let one test read
 * another's payload out of the 15-second cache and pass without calling the
 * stub at all.
 */
describe("the GitHub backend states what it did not count", () => {
  const ORIGIN = "https://api.github.com";

  type StubCommit = { sha: string; authoredAt: string };

  /**
   * The window is measured back from the clock, so fixtures have to be too.
   * Noon UTC keeps a day-boundary rounding error from moving a commit onto the
   * day either side of the one the assertions name.
   */
  function daysAgo(days: number): Date {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    date.setUTCHours(12, 0, 0, 0);
    return date;
  }

  const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

  /** The two fields this question turns on, in GitHub's shapes. */
  function stubFetch(repo: string, commits: StubCommit[]): void {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubEnv("HEALDESK_REPO", repo);

    const listPrefix = `${ORIGIN}/repos/${repo.replace("/", "/")}/commits?`;
    const detailPrefix = `${ORIGIN}/repos/${repo.replace("/", "/")}/commits/`;

    vi.stubGlobal("fetch", (input: unknown): Promise<Response> => {
      const url = String(input);

      if (url.startsWith(listPrefix)) {
        return Promise.resolve(
          Response.json(commits.map(({ sha }) => ({ sha }))),
        );
      }

      if (url.startsWith(detailPrefix)) {
        const sha = url.slice(detailPrefix.length);
        const found = commits.find((commit) => commit.sha === sha);
        if (!found) return Promise.resolve(new Response("no", { status: 404 }));
        return Promise.resolve(
          Response.json({
            sha: found.sha,
            html_url: `https://github.com/${repo}/commit/${found.sha}`,
            commit: {
              author: { name: "Test Author", date: found.authoredAt },
              message: "A commit\n\nWith a body.",
            },
            files: [
              {
                filename: "apps/web/src/page.tsx",
                status: "modified",
                additions: 10,
                deletions: 2,
              },
            ],
            stats: { additions: 10, deletions: 2 },
          }),
        );
      }

      // Anything else is the test asking a question it did not mean to ask.
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("a window holding more commits than were expanded is not complete", async () => {
    // Three commits in the window; the caller can afford to expand two. Every
    // total below therefore describes two commits out of three.
    const newest = daysAgo(1);
    const middle = daysAgo(2);
    const oldest = daysAgo(8);

    stubFetch("test-owner/capped", [
      { sha: "cap1", authoredAt: newest.toISOString() },
      { sha: "cap2", authoredAt: middle.toISOString() },
      { sha: "cap3", authoredAt: oldest.toISOString() },
    ]);

    const payload = await loadChanges({ windowDays: 29, limit: 2 });

    // The read worked. That is what `ok` means and it is still true.
    expect(payload.ok).toBe(true);
    expect(payload.source).toBe("github");
    expect(payload.totals.commits).toBe(2);

    // …and this is the part that was missing.
    expect(payload.totals.complete).toBe(false);
    expect(payload.coverage).not.toBeNull();
    expect(payload.coverage?.inWindow).toBe(3);
    expect(payload.coverage?.inWindowAtLeast).toBe(false);
    // The oldest day the numbers actually reach: the second commit's day, not
    // the third's and not the start of the window.
    expect(payload.coverage?.from).toBe(dayKey(middle));

    // The warning is kept as well. It says it in words for the reader who
    // opens the list, but it is no longer the only place the fact exists.
    expect(payload.warnings.join(" ")).toContain("newest 2");
  });

  test("a window whose commits were all expanded is complete", async () => {
    stubFetch("test-owner/whole", [
      { sha: "whole1", authoredAt: daysAgo(1).toISOString() },
      { sha: "whole2", authoredAt: daysAgo(2).toISOString() },
    ]);

    const payload = await loadChanges({ windowDays: 28, limit: 40 });

    expect(payload.ok).toBe(true);
    expect(payload.totals.commits).toBe(2);
    expect(payload.totals.complete).toBe(true);
    // Null rather than an object of nulls: there is no shortfall to describe,
    // and a component that reads it must not find one.
    expect(payload.coverage).toBeNull();
  });

  test("a commit that could not be expanded also breaks completeness", async () => {
    // The detail call for `miss2` 404s, so it is left out of the totals. The
    // list said three, the numbers describe two, and the payload says so,
    // this is the same failure as the cap, arriving through another door.
    stubFetch("test-owner/partial", [
      { sha: "part1", authoredAt: daysAgo(1).toISOString() },
      { sha: "part2", authoredAt: daysAgo(2).toISOString() },
      { sha: "part3", authoredAt: daysAgo(3).toISOString() },
    ]);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (input: unknown): Promise<Response> => {
      if (String(input).endsWith("/part2")) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return original(input as string);
    });

    const payload = await loadChanges({ windowDays: 27, limit: 40 });

    expect(payload.ok).toBe(true);
    expect(payload.totals.commits).toBe(2);
    expect(payload.totals.complete).toBe(false);
    expect(payload.coverage?.inWindow).toBe(3);
  });

  test("the chart is never handed a zero day the read did not measure", async () => {
    // The contract the chart depends on: every day it draws as zero either sits
    // inside the covered range or sits before `coverage.from`, where it is
    // hatched rather than drawn. A zero day after the boundary is a real zero.
    const covered = daysAgo(2);
    stubFetch("test-owner/chart", [
      { sha: "chart1", authoredAt: daysAgo(1).toISOString() },
      { sha: "chart2", authoredAt: covered.toISOString() },
      { sha: "chart3", authoredAt: daysAgo(9).toISOString() },
    ]);

    const payload = await loadChanges({ windowDays: 26, limit: 2 });
    const from = payload.coverage?.from;

    expect(from).toBe(dayKey(covered));
    expect(payload.activity.length).toBeGreaterThan(0);

    const counted = payload.activity
      .filter((day) => from !== undefined && from !== null && day.date >= from)
      .reduce((sum, day) => sum + day.commits, 0);

    // Everything the totals counted falls inside the covered range, so nothing
    // outside it is a measured zero.
    expect(counted).toBe(payload.totals.commits);
  });
});
