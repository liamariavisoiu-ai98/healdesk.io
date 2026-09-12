import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ActivityChart } from "@/components/admin/ActivityChart";
import { AreaBreakdown } from "@/components/admin/AreaBreakdown";
import { ChangeFeed } from "@/components/admin/ChangeFeed";
import { LiveIndicator } from "@/components/admin/LiveIndicator";
import { RoadmapBoard } from "@/components/admin/RoadmapBoard";
import type { Change } from "@/lib/admin/types";

/**
 * The rules the admin panels are supposed to keep, tested where they live.
 *
 * Every honesty bug found in this feature so far has been in a component and
 * not in a loader: a failed read drawn as a quiet fortnight, a guessed source
 * printed as a fact, a display cap reported as a failure, an unreadable roadmap
 * shown as a finished one. The loaders that feed them are well covered and the
 * components were not covered at all, which is exactly the wrong way round,
 * the loaders state the truth in fields, and it is the components that decide
 * whether the reader is told it.
 *
 * These render to static markup and read the text, because the text *is* the
 * claim. There is no DOM and no testing library: the question is never "did a
 * div appear", it is "does this sentence say something the payload supports".
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function change(n: number): Change {
  return {
    sha: `sha${n}`.padEnd(40, "0"),
    shortSha: `sha${n}`,
    subject: `Commit ${n}`,
    body: "",
    authorName: "someone",
    authoredAt: "2026-09-05T10:00:00.000Z",
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    files: [],
    areas: [],
    url: null,
  };
}

const NO_TASKS = {
  tasks: 0,
  byStatus: { ready: 0, vendor: 0, counsel: 0, decision: 0 },
} as const;

describe("an empty panel says which kind of empty it is", () => {
  test("the chart distinguishes a failed read from a quiet window", () => {
    // Both send `activity: []`. Only `ok` tells them apart, and the failed one
    // must not be described as an absence of work.
    const failed = text(h(ActivityChart, { activity: [], ok: false }));
    expect(failed).toContain("could not be read");
    expect(failed).not.toMatch(/no .*activity was reported/i);

    const quiet = text(
      h(ActivityChart, {
        activity: [
          { date: "2026-09-01", commits: 0, additions: 0, deletions: 0 },
        ],
        ok: true,
      }),
    );
    expect(quiet).toContain("No commits in this window");
    expect(quiet).not.toContain("could not be read");
  });

  test("the feed distinguishes a failed read from a quiet window", () => {
    const failed = text(h(ChangeFeed, { changes: [], ok: false }));
    expect(failed).toContain("could not be read");

    const quiet = text(h(ChangeFeed, { changes: [], ok: true, warnings: [] }));
    expect(quiet).toContain("No commits to show");
    expect(quiet).not.toContain("could not be read");
  });

  test("a clean empty window is not reported as trouble because a cap warned", () => {
    // The regression that started this: `warnings.length > 0` was standing in
    // for "the read failed", and a healthy read warns about benign things.
    const quiet = text(
      h(ChangeFeed, {
        changes: [],
        ok: true,
        warnings: ["Asked for 500 days; showing 365."],
      }),
    );
    expect(quiet).toContain("No commits");
    expect(quiet).not.toContain("could not be read");
  });

  test("the breakdown distinguishes a failed read from an untouched window", () => {
    const failed = text(h(AreaBreakdown, { ok: false, areas: [] }));
    expect(failed).toContain("could not be read");

    const quiet = text(h(AreaBreakdown, { ok: true, areas: [] }));
    expect(quiet).toContain("genuinely nothing");
    expect(quiet).not.toContain("could not be read");
  });

  test("the roadmap distinguishes an unreadable list from a finished one", () => {
    const failed = text(
      h(RoadmapBoard, { ok: false, groups: [], totals: NO_TASKS }),
    );
    expect(failed).toContain("could not be read");
    expect(failed).not.toContain("Nothing queued");

    const done = text(
      h(RoadmapBoard, { ok: true, groups: [], totals: NO_TASKS }),
    );
    expect(done).toContain("Nothing queued");
    expect(done).not.toContain("could not be read");
  });
});

describe("a cap is disclosed where the reader meets it", () => {
  test("a truncated feed says so at the foot of the list", () => {
    // The local backend counts every commit in the window and lists the newest
    // forty. Before this, the list simply stopped.
    const feed = text(
      h(ChangeFeed, {
        changes: Array.from({ length: 40 }, (_, index) => change(index)),
        ok: true,
        warnings: [],
        counted: 50,
      }),
    );
    expect(feed).toContain("newest 40 of 50");
  });

  test("a feed that lists everything it counted says nothing", () => {
    const feed = text(
      h(ChangeFeed, { changes: [change(1)], ok: true, counted: 1 }),
    );
    expect(feed).not.toContain("Listing the newest");
  });
});

describe("the status line states only what the payload supports", () => {
  const base = {
    fetchedAt: "2026-09-07T10:00:00.000Z",
    isRefreshing: false,
  } as const;

  test("a failed read never names a backend it did not reach", () => {
    const line = text(
      h(LiveIndicator, {
        ...base,
        source: "unknown",
        ok: false,
        warnings: ["GitHub answered 401 Unauthorized."],
      }),
    );
    expect(line).toContain("Could not read this repository");
    expect(line).not.toContain("Reading github.com");
    expect(line).not.toContain("Reading your local checkout");
  });

  test("github and the local checkout are never left ambiguous", () => {
    const github = text(
      h(LiveIndicator, { ...base, source: "github", ok: true, warnings: [] }),
    );
    expect(github).toContain("Reading github.com");
    expect(github).toContain("pushed history only");

    const local = text(
      h(LiveIndicator, { ...base, source: "local-git", ok: true, warnings: [] }),
    );
    expect(local).toContain("Reading your local checkout");
    // The one thing a reader of a local feed has to know: it is ahead of what
    // anybody else can see.
    expect(local).toContain("unpushed");
  });

  test("a warning over complete totals does not hedge the totals", () => {
    const complete = text(
      h(LiveIndicator, {
        ...base,
        source: "local-git",
        ok: true,
        complete: true,
        warnings: ["The feed lists the newest 40 of 50 commits in the window."],
      }),
    );
    expect(complete).toContain("account for the whole window");
    expect(complete).not.toContain("may be lower than the truth");

    const partial = text(
      h(LiveIndicator, {
        ...base,
        source: "github",
        ok: true,
        complete: false,
        warnings: ["The window holds 50 commits and this view covers 40."],
      }),
    );
    expect(partial).toContain("may be lower than the truth");
  });

  test("every warning reaches the reader, none is counted and dropped", () => {
    const warnings = ["first problem", "second problem", "third problem"];
    const line = text(
      h(LiveIndicator, { ...base, source: "github", ok: true, warnings }),
    );
    for (const warning of warnings) expect(line).toContain(warning);
    expect(line).toContain("3 things");
  });
});
