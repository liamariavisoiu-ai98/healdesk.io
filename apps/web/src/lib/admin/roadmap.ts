/**
 * The roadmap half of the admin view: what is still coming.
 *
 * ## Why this reads scripts/docs-site/tasks.mjs instead of holding its own copy
 *
 * That file's own header says the repo already had two competing task lists and
 * the fix was to collapse them into one. A hand-copied array here would be the
 * third, and it would be wrong within a week, the copy nobody remembers to
 * update is the copy the owner ends up reading. So this module owns no task
 * data at all. It owns the loading, the validation and the shaping, and nothing
 * else. If a task is missing from the board, the fix is in tasks.mjs.
 *
 * ## Why a dynamic import of a file URL, and not a plain import
 *
 * tasks.mjs sits outside apps/web/src, is plain ESM with no types, and is
 * emphatically not part of this app's module graph. A static `import` would ask
 * the bundler to reach up out of the app and inline a 200KB script into the
 * server bundle, which either fails to resolve or succeeds and quietly pins a
 * build-time snapshot of the list into the deployment. Instead we find the repo
 * root at runtime, build a file:// URL and hand it to a dynamic `import()`
 * marked `webpackIgnore`/`turbopackIgnore`, which both bundlers leave alone.
 * Node then loads it as the ordinary ES module it is.
 *
 * ## Why there is no text-parsing fallback
 *
 * The obvious backup, read the file as a string and pull the tasks out with a
 * regex or a hand-rolled parser, is writing a second, worse JavaScript engine
 * and trusting it with the only copy of the plan. It would not fail loudly; it
 * would silently return 60 of the tasks, or mangle a `plain` line assembled
 * from concatenated string fragments, and the board would look fine. A board
 * that is honestly empty and names the file it could not read is worth more
 * than a board that is confidently incomplete. So: no parser. Load it or say
 * you could not.
 *
 * ## What that costs, stated plainly
 *
 * `scripts/` is not part of the web app's output file tracing, so on a
 * standalone or serverless deploy this module will not find tasks.mjs and the
 * roadmap will be empty with a warning attached. That is the expected state off
 * a full checkout, not a bug to hunt. Fixing it means either tracing the file
 * into the build or moving the list behind an API, both are decisions for
 * whoever deploys this, not defaults to smuggle in here.
 *
 * ## Honesty rules this module follows
 *
 * - It never throws. A failure is an empty payload plus a warning; the changes
 *   panel on the same page must not go dark because a task list did not load.
 * - `totals.byStatus` is always zero-filled for every status, so a chart never
 *   guards for a missing key. Those zeros are not a claim that there is no work
 *   the warning next to them is what says the list was not read, and the UI
 *   is expected to show it.
 * - `fetchedAt` is stamped when tasks.mjs was actually read, and deliberately
 *   does not move forward on a cache hit. Restamping it on every request would
 *   render a guess about freshness as a fact.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  TASK_STATUSES,
  type RoadmapGroup,
  type RoadmapPayload,
  type RoadmapTask,
  type TaskStatus,
} from "@/lib/admin/types";

/** The manifest `name` that identifies the monorepo root, not a workspace. */
const ROOT_PACKAGE_NAME = "healdesk";

/** Written out for warnings; the on-disk path is joined per-segment below. */
const TASKS_LABEL = "scripts/docs-site/tasks.mjs";

/**
 * Where tasks whose `group` is not one of the declared GROUPS end up.
 *
 * The alternative was dropping them, which loses real work from the board and
 * makes the total lie. Inventing a group is only acceptable because the blurb
 * says outright that it was invented and why.
 */
const UNFILED_GROUP = {
  id: "unfiled",
  title: "Unfiled",
  blurb:
    "These tasks name a group that scripts/docs-site/tasks.mjs does not define. They are shown here rather than dropped, so the count stays true.",
} as const;

/* ------------------------------------------------------------- validation -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which would leak `any` into
 * every element below. This keeps the elements `unknown` so each one has to be
 * checked before it is used.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

/** A trimmed non-empty string, or null. Blank and absent mean the same here. */
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Names a few ids in a warning without letting it run to a hundred of them. */
function nameSome(ids: readonly string[], max = 5): string {
  const shown = ids.slice(0, max).join(", ");
  return ids.length > max ? `${shown} and ${ids.length - max} more` : shown;
}

/* ------------------------------------------------------------------ shell -- */

/**
 * Written out rather than derived from TASK_STATUSES so the *compiler* is what
 * guarantees a key for every member of TaskStatus. A runtime loop would give
 * the same object today and no error the day the union grows.
 */
function zeroFilledStatusCounts(): Record<TaskStatus, number> {
  return { ready: 0, vendor: 0, counsel: 0, decision: 0 };
}

function emptyPayload(warnings: string[], fetchedAt: string): RoadmapPayload {
  return {
    // Not read. Without this the board cannot tell an unreadable task list from
    // a finished one, and the deployed default is the unreadable one.
    ok: false,
    groups: [],
    totals: { tasks: 0, byStatus: zeroFilledStatusCounts() },
    fetchedAt,
    warnings,
  };
}

/* ------------------------------------------------------------- locating it -- */

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    );
    if (!isRecord(manifest) || manifest.name !== ROOT_PACKAGE_NAME) return false;

    // Both conditions, because a stray package.json named "healdesk" outside
    // the checkout should not send us looking for tasks that are not there.
    const docsSite = await stat(join(dir, "scripts", "docs-site"));
    return docsSite.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir`. The caller passes `process.cwd()`; cwd is apps/web
 * under `next dev` and the repo root under some CI runners, so neither can be
 * assumed, hence the walk rather than a fixed number of `..` segments, which
 * breaks silently when the app moves one directory deeper.
 *
 * The directory is a parameter rather than `process.cwd()` read in here, and
 * that is not style. Turbopack traces filesystem access statically, and
 * `resolve(process.cwd())` in a module the server bundle imports is read as
 * "this route may touch any path under the project", so the build pulled the
 * *entire* repository into the server output and said so:
 *
 *   Warning: Dynamic filesystem access causes tracing of the whole project
 *
 * Which would have made the header comment above wrong in the worst direction:
 * it promises that `scripts/` is not shipped and the roadmap is therefore empty
 * off a full checkout, while the build was quietly shipping everything, so the
 * board's behaviour when deployed depended on a bundler warning nobody read.
 * `lib/admin/changes.ts` takes the directory as an argument for the same reason
 * and draws no warning; this now matches it.
 */
async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    if (await isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // Hit the filesystem root.
    dir = parent;
  }
}

/* --------------------------------------------------------------- loading -- */

type SourceLists = { groups: unknown[]; tasks: unknown[] };
type SourceResult =
  | { ok: true; lists: SourceLists }
  | { ok: false; warning: string };

async function importTaskList(): Promise<SourceResult> {
  const root = await findRepoRoot(process.cwd());
  if (!root) {
    return {
      ok: false,
      warning: `Could not find the repo root above ${process.cwd()}, so ${TASKS_LABEL} was never read. The roadmap is unknown here, not empty.`,
    };
  }

  const tasksPath = join(root, "scripts", "docs-site", "tasks.mjs");
  try {
    const file = await stat(tasksPath);
    if (!file.isFile()) {
      return {
        ok: false,
        warning: `${TASKS_LABEL} exists at ${tasksPath} but is not a file. The roadmap is unknown here, not empty.`,
      };
    }
  } catch {
    return {
      ok: false,
      warning: `${TASKS_LABEL} is not present at ${tasksPath}. scripts/ is not traced into the web app's build output, so the roadmap is unavailable anywhere but a full checkout.`,
    };
  }

  let loaded: unknown;
  try {
    loaded = await import(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      pathToFileURL(tasksPath).href
    );
  } catch (error) {
    return {
      ok: false,
      warning: `Could not load ${TASKS_LABEL}: ${describeError(error)}. The roadmap is unknown here, not empty.`,
    };
  }

  if (!isRecord(loaded)) {
    return {
      ok: false,
      warning: `${TASKS_LABEL} did not load as a module. The roadmap is unknown here, not empty.`,
    };
  }

  const groups = loaded.GROUPS;
  const tasks = loaded.TASKS;
  if (!isUnknownArray(groups) || !isUnknownArray(tasks)) {
    return {
      ok: false,
      warning: `${TASKS_LABEL} loaded but does not export the GROUPS and TASKS arrays this view reads. The roadmap is unknown here, not empty.`,
    };
  }

  return { ok: true, lists: { groups, tasks } };
}

/* --------------------------------------------------------------- shaping -- */

type BuildResult = { payload: RoadmapPayload; sourceRead: boolean };

async function build(): Promise<BuildResult> {
  const fetchedAt = new Date().toISOString();

  try {
    const source = await importTaskList();
    if (!source.ok) {
      return {
        payload: emptyPayload([source.warning], fetchedAt),
        sourceRead: false,
      };
    }

    const warnings: string[] = [];

    // Groups first, in the order they are written. That order is roughly
    // execution order, send-today before delivery, and re-sorting it by
    // volume or status would throw away the one thing the file encodes for
    // free.
    const groups: RoadmapGroup[] = [];
    const groupIndex = new Map<string, RoadmapGroup>();
    let malformedGroups = 0;

    for (const raw of source.lists.groups) {
      if (!isRecord(raw)) {
        malformedGroups += 1;
        continue;
      }
      const id = readText(raw.id);
      const title = readText(raw.title);
      if (!id || !title || groupIndex.has(id)) {
        malformedGroups += 1;
        continue;
      }
      // A missing blurb is left blank rather than filled with something
      // plausible; the heading still carries the meaning.
      const group: RoadmapGroup = {
        id,
        title,
        blurb: readText(raw.blurb) ?? "",
        tasks: [],
      };
      groups.push(group);
      groupIndex.set(id, group);
    }

    if (malformedGroups > 0) {
      warnings.push(
        `${malformedGroups} group(s) in ${TASKS_LABEL} were skipped for a missing or duplicate id or title.`,
      );
    }

    const tasks: RoadmapTask[] = [];
    const unfiled: RoadmapTask[] = [];
    const missingPlain: string[] = [];
    const unknownStatus: string[] = [];
    let malformedTasks = 0;

    for (const raw of source.lists.tasks) {
      if (!isRecord(raw)) {
        malformedTasks += 1;
        continue;
      }

      const id = readText(raw.id);
      const title = readText(raw.title);
      const group = readText(raw.group);
      if (!id || !title || !group) {
        malformedTasks += 1;
        continue;
      }

      // Status cannot be guessed, "probably ready" is exactly the kind of
      // invented fact this codebase refuses to render, so an unrecognised one
      // drops the task and says so.
      if (!isTaskStatus(raw.status)) {
        unknownStatus.push(id);
        continue;
      }

      const plain = readText(raw.plain);
      if (!plain) missingPlain.push(id);

      // `why`, `steps` and `source` are dropped here on purpose: this view
      // shows the one-line explanation, not the runbook. The runbook lives in
      // the docs site, which is where someone doing the task will be.
      const task: RoadmapTask = {
        id,
        group,
        status: raw.status,
        blockedBy: readText(raw.blockedBy),
        title,
        effort: readText(raw.effort),
        plain: plain ?? "",
      };

      tasks.push(task);
      const target = groupIndex.get(group);
      if (target) target.tasks.push(task);
      else unfiled.push(task);
    }

    if (malformedTasks > 0) {
      warnings.push(
        `${malformedTasks} task(s) in ${TASKS_LABEL} were skipped for a missing id, title or group.`,
      );
    }
    if (unknownStatus.length > 0) {
      warnings.push(
        `${unknownStatus.length} task(s) were skipped for a status this view does not know: ${nameSome(unknownStatus)}.`,
      );
    }
    if (missingPlain.length > 0) {
      warnings.push(
        `${missingPlain.length} task(s) have no plain-English line in ${TASKS_LABEL}: ${nameSome(missingPlain)}.`,
      );
    }

    // A blockedBy pointing at a task that is not on the board would draw a
    // dependency line to nothing. Cut the line, keep the task, name the ids.
    const known = new Set(tasks.map((task) => task.id));
    const dangling: string[] = [];
    for (const task of tasks) {
      if (task.blockedBy !== null && !known.has(task.blockedBy)) {
        dangling.push(`${task.id} → ${task.blockedBy}`);
        task.blockedBy = null;
      }
    }
    if (dangling.length > 0) {
      warnings.push(
        `${dangling.length} dependency link(s) point at a task that is not in the list and were dropped rather than drawn: ${nameSome(dangling)}.`,
      );
    }

    if (unfiled.length > 0) {
      groups.push({ ...UNFILED_GROUP, tasks: unfiled });
      warnings.push(
        `${unfiled.length} task(s) name a group ${TASKS_LABEL} does not define; they are grouped under "${UNFILED_GROUP.title}".`,
      );
    }

    const byStatus = zeroFilledStatusCounts();
    for (const task of tasks) byStatus[task.status] += 1;

    return {
      payload: {
        // The file was found, imported and parsed. Whatever `warnings` says
        // about individual tasks, these groups are a real reading of it.
        ok: true,
        groups,
        totals: { tasks: tasks.length, byStatus },
        fetchedAt,
        warnings,
      },
      // Nothing usable came back if the file parsed to no tasks at all; treat
      // that as unread so the next request tries again rather than caching a
      // blank board for the life of the process.
      sourceRead: tasks.length > 0,
    };
  } catch (error) {
    // The paths above are meant to cover every failure. This is the promise
    // that a bug in one of them still cannot take down the admin page.
    return {
      payload: emptyPayload(
        [
          `Reading ${TASKS_LABEL} failed unexpectedly: ${describeError(error)}. The roadmap is unknown here, not empty.`,
        ],
        fetchedAt,
      ),
      sourceRead: false,
    };
  }
}

/* ----------------------------------------------------------------- cache -- */

/**
 * Module scope, kept for the life of the process. The task list changes when
 * the repo changes, which on a server means a new deployment; re-reading it on
 * every poll of the admin page would buy nothing.
 *
 * The cost, named: Node's ESM registry caches tasks.mjs too, so editing it
 * while `next dev` is running has no effect until the dev server restarts. That
 * is a worse trade for the person editing tasks than for the person watching
 * the board, and the board is who this is for.
 *
 * Failures are not cached, so a transient one heals on the next request.
 */
let cached: RoadmapPayload | null = null;
let inFlight: Promise<RoadmapPayload> | null = null;

export async function loadRoadmap(): Promise<RoadmapPayload> {
  if (cached) return cached;

  // Share one read between concurrent requests instead of racing several.
  if (!inFlight) {
    inFlight = build().then((result) => {
      if (result.sourceRead) cached = result.payload;
      inFlight = null;
      return result.payload;
    });
  }

  return inFlight;
}
