import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { TASK_STATUSES, type RoadmapPayload } from "@/lib/admin/types";

/**
 * The roadmap loader, tested for the promises it makes when it cannot read
 * anything.
 *
 * ## Why most of this is about the empty case
 *
 * `loadRoadmap` reads scripts/docs-site/tasks.mjs off disk, and that file is
 * not in git, `git ls-files scripts` is empty. So a fresh checkout, CI
 * included, has no task list at all, and the honest-empty path is not an edge
 * case here: it is the common one. What it must do there is well defined, and
 * it is what these tests hold it to. Return a payload rather than throwing,
 * zero-fill every status rather than omitting keys, and attach a warning that
 * names the file, so the board reads as "not read" rather than "no work left".
 *
 * ## What is only tested on a full checkout
 *
 * Group ordering needs the real list, so that suite skips, visibly, by name,
 * when the file is absent. Asserting an order against a hard-coded copy of the
 * groups would pass in CI while proving nothing, and would add the fourth
 * competing task list that tasks.mjs exists to prevent. A test that cannot run
 * honestly is worth less than one that says it did not run.
 *
 * `loadRoadmap` caches a successful read for the life of the process, so every
 * test below re-imports the module through `vi.resetModules()` rather than
 * sharing one memoised payload between them.
 */

/** Resolved from this file, not from cwd, which differs between vitest and next. */
const TASKS_URL = new URL(
  "../../../../../scripts/docs-site/tasks.mjs",
  import.meta.url,
);
const SOURCE_PRESENT = existsSync(fileURLToPath(TASKS_URL));

async function loadFresh(): Promise<RoadmapPayload> {
  vi.resetModules();
  const { loadRoadmap } = await import("./roadmap");
  return loadRoadmap();
}

const CWD = process.cwd();

afterEach(() => {
  if (process.cwd() !== CWD) process.chdir(CWD);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("the payload is shaped even when nothing could be read", () => {
  test("every status is present and counted, never missing", async () => {
    const { totals } = await loadFresh();

    // The chart indexes byStatus by every member of TaskStatus. A missing key
    // renders as `undefined`, a bar of unknown height, where the truth is
    // zero. This holds whether or not the source was found.
    let summed = 0;
    for (const status of TASK_STATUSES) {
      const count = totals.byStatus[status];
      expect(typeof count, status).toBe("number");
      expect(count, status).toBeGreaterThanOrEqual(0);
      summed += count;
    }

    expect(Object.keys(totals.byStatus).sort()).toEqual(
      [...TASK_STATUSES].sort(),
    );
    // The statuses account for every task. A task counted in the total but not
    // in any status would show as a gap in the board with no explanation.
    expect(summed).toBe(totals.tasks);
  });

  test("the totals agree with the groups", async () => {
    const payload = await loadFresh();
    const inGroups = payload.groups.reduce(
      (sum, group) => sum + group.tasks.length,
      0,
    );
    expect(inGroups).toBe(payload.totals.tasks);
  });

  test("it never throws, and stamps a real timestamp", async () => {
    // The changes panel shares the page. A task list that could not be read
    // must not take the whole admin view down with it.
    const payload = await loadFresh();
    expect(Array.isArray(payload.groups)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect(Number.isNaN(Date.parse(payload.fetchedAt))).toBe(false);
    // The board branches on this to decide whether an empty list is a clear
    // runway or a failed read. An undefined here renders as the former.
    expect(typeof payload.ok).toBe("boolean");
  });

  test.skipIf(typeof process.chdir !== "function")(
    "an unreadable source is an empty board that says so",
    async () => {
      // The loader walks up from cwd looking for the repo root. From the
      // filesystem root there is nothing above it to find, which is the same
      // position a serverless deploy is in: scripts/ is not traced into the
      // web app's build output.
      process.chdir("/");
      const payload = await loadFresh();
      process.chdir(CWD);

      // The whole point of the flag: this payload is an absence, and it says
      // so in a field rather than leaving the board to infer it from prose.
      expect(payload.ok).toBe(false);
      expect(payload.groups).toEqual([]);
      expect(payload.totals.tasks).toBe(0);
      expect(payload.totals.byStatus).toEqual({
        ready: 0,
        vendor: 0,
        counsel: 0,
        decision: 0,
      });

      // Zeros with no warning beside them are a claim that there is no work
      // left. The warning is the entire difference between "empty" and
      // "unknown", so it has to be there and it has to name the file.
      expect(payload.warnings.length).toBeGreaterThan(0);
      expect(payload.warnings.join(" ")).toContain("tasks.mjs");
    },
  );
});

describe.skipIf(!SOURCE_PRESENT)(
  "with scripts/docs-site/tasks.mjs on disk",
  () => {
    test("group order follows the file, and is not re-sorted", async () => {
      // That order is roughly execution order, send-today before delivery,
      // and it is the one thing the file encodes for free. Sorting by volume
      // or status would silently throw it away, and the board would still
      // look right.
      const loaded: unknown = await import(/* @vite-ignore */ TASKS_URL.href);
      const source = isRecord(loaded) ? loaded.GROUPS : null;
      expect(Array.isArray(source)).toBe(true);
      if (!Array.isArray(source)) return;

      const expected: string[] = [];
      for (const group of source as unknown[]) {
        if (isRecord(group) && typeof group.id === "string") {
          expected.push(group.id);
        }
      }
      expect(expected.length).toBeGreaterThan(0);

      const payload = await loadFresh();
      // Trailing entries are allowed: tasks naming an undeclared group are
      // collected into an appended "unfiled" group rather than dropped.
      expect(payload.groups.map((group) => group.id).slice(0, expected.length)).toEqual(
        expected,
      );
    });

    test("the board is not silently empty on a full checkout", async () => {
      // Guards the failure this whole module is built around: a loader that
      // returns a clean, warning-free, entirely empty board because the import
      // quietly went wrong. Every task carries a group and a known status.
      const payload = await loadFresh();

      // A real read says so. If this ever reports false on a full checkout the
      // board will announce that the roadmap is unreadable while showing it.
      expect(payload.ok).toBe(true);
      expect(payload.totals.tasks).toBeGreaterThan(0);
      for (const group of payload.groups) {
        for (const task of group.tasks) {
          expect(TASK_STATUSES, task.id).toContain(task.status);
          expect(task.group, task.id).toBe(group.id);
        }
      }
    });
  },
);
