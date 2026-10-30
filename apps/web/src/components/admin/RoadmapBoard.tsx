"use client";

import { useMemo, useState } from "react";

import { TASK_STATUSES } from "@/lib/admin/types";
import type {
  RoadmapGroup,
  RoadmapPayload,
  RoadmapTask,
  TaskStatus,
} from "@/lib/admin/types";

/**
 * What is still ahead, grouped the way the handover document groups it.
 *
 * The commit feed answers "what changed". This answers "what has not", which is
 * the harder half to look at honestly, and the reason the two live on one page.
 *
 * ## Why the status colours are four, and why none of them is alone
 *
 * Four statuses, four hues, and every chip carries its word as well. Colour on
 * its own fails for roughly one man in twelve, fails again in a screenshot
 * pasted into a black-and-white document, and fails a third time for anyone who
 * has not memorised which hue means "waiting on a lawyer". The dot is the fast
 * scan; the label is the fact.
 *
 * The hexes were chosen against the warm paper ground rather than guessed, and
 * validated for lightness band, chroma floor, colour-vision separation and
 * contrast:
 *
 *   validate_palette.js "#5A9A16,#14539E,#C94E96,#8A4A0C" --mode light
 *   → all checks pass, and still pass with --surface "#FFFBFF" --pairs all
 *
 * The obvious palette, green / blue / purple / orange, fails: purple and blue
 * collapse into each other under deuteranopia (ΔE 2.6 against a floor of 6).
 * The set below separates by lightness where hue cannot: a light green and a
 * dark amber sit at opposite ends of the one axis that survives.
 *
 * These four are the only hexes in the admin area outside the design tokens,
 * and they are here for the reason a chart palette is: nine words cannot be
 * told apart at a glance, four colours can.
 *
 * ## Why the filter is a row and not a sidebar
 *
 * The board is already a two-level structure, groups containing tasks. A third
 * column of controls beside it turns a reading surface into an application.
 * Four toggles fit on one line above the content, where they read as a caption
 * on what is below rather than as a control panel.
 */

const STATUS_META: Record<
  TaskStatus,
  { label: string; hex: string; meaning: string }
> = {
  ready: { label: "Ready", hex: "#5A9A16", meaning: "Nothing blocks it." },
  vendor: {
    label: "Vendor",
    hex: "#14539E",
    meaning: "Waiting on a third party.",
  },
  counsel: {
    label: "Counsel",
    hex: "#C94E96",
    meaning: "Waiting on a lawyer.",
  },
  decision: {
    label: "Decision",
    hex: "#8A4A0C",
    meaning: "Needs a decision from you.",
  },
};

const ALL_STATUSES: ReadonlySet<TaskStatus> = new Set(TASK_STATUSES);
const NO_GROUPS_OPEN: ReadonlySet<string> = new Set<string>();

export type RoadmapBoardProps = {
  /**
   * From `RoadmapPayload.ok`, whether the task list was actually read.
   *
   * An empty board has two causes that produce identical data: every task is
   * done, or the file could not be read. This is the only thing that tells them
   * apart, and getting it wrong means either celebrating a finished roadmap
   * that does not exist or hiding a broken read behind a tick.
   */
  ok: boolean;
  groups: RoadmapGroup[];
  totals: RoadmapPayload["totals"];
};

export function RoadmapBoard({ ok, groups, totals }: RoadmapBoardProps) {
  const [selected, setSelected] =
    useState<ReadonlySet<TaskStatus>>(ALL_STATUSES);

  // Null means "the reader has not touched this yet", which is what lets the
  // first group default to open even though `groups` may arrive after the first
  // render. A `useState` initialiser would have captured an empty list.
  const [openIds, setOpenIds] = useState<ReadonlySet<string> | null>(null);
  const firstGroupId = groups[0]?.id ?? null;
  const open =
    openIds ?? (firstGroupId === null ? NO_GROUPS_OPEN : new Set([firstGroupId]));

  // Dependencies are stated by title, never by id, an id is a fact about the
  // task file, not about the work.
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const task of group.tasks) map.set(task.id, task.title);
    }
    return map;
  }, [groups]);

  const filtered = useMemo(
    () =>
      groups.map((group) => ({
        group,
        tasks: group.tasks.filter((task) => selected.has(task.status)),
      })),
    [groups, selected],
  );

  const shown = filtered.reduce((sum, entry) => sum + entry.tasks.length, 0);
  const isFiltered = selected.size !== TASK_STATUSES.length;

  function toggleStatus(status: TaskStatus) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function toggleGroup(id: string) {
    setOpenIds((previous) => {
      // `previous` is null while the default (first group open) is still in
      // force, so resolve it the same way the render does before mutating.
      const base =
        previous ??
        (firstGroupId === null ? NO_GROUPS_OPEN : new Set([firstGroupId]));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (groups.length === 0) {
    // Two different facts, and the board states whichever one is true rather
    // than describing both and asking the reader to work it out.
    return (
      <div className="border-line rounded-md border border-dashed px-5 py-8 text-center">
        <p className="font-display text-xl font-medium">
          {ok ? "Nothing queued" : "The roadmap could not be read"}
        </p>
        <p className="text-muted mx-auto mt-2 max-w-[46ch] text-sm font-medium">
          {ok
            ? "The task list was read and there is nothing left in it. This is a clear runway, not a failure to look."
            : "The task list could not be read, so this is blank rather than empty. Nothing here says the work is done. On a deployed instance the task file is usually not shipped with the app, which is the most likely reason."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary strip, every number here is the server's, not a re-count. */}
      <div className="border-line flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border bg-white px-4 py-3.5">
        <p className="flex items-baseline gap-2">
          <span className="font-figure text-brand-gradient text-3xl leading-none font-semibold tabular-nums">
            {totals.tasks}
          </span>
          <span className="text-muted text-sm font-semibold">
            tasks ahead
          </span>
        </p>

        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {TASK_STATUSES.map((status) => (
            <li
              key={status}
              className="flex items-baseline gap-1.5 text-sm font-semibold"
              title={STATUS_META[status].meaning}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 translate-y-[-1px] rounded-full"
                style={{ backgroundColor: STATUS_META[status].hex }}
              />
              <span className="tabular-nums">{totals.byStatus[status]}</span>
              <span className="text-muted">{STATUS_META[status].label}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Filter row */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-muted mr-1 text-xs font-bold tracking-[0.12em] uppercase">
          Show
        </span>

        {TASK_STATUSES.map((status) => {
          const meta = STATUS_META[status];
          const isOn = selected.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={isOn}
              onClick={() => toggleStatus(status)}
              title={meta.meaning}
              className={[
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-bold transition-colors",
                isOn
                  ? "text-ink"
                  : "border-line text-muted hover:border-line-strong bg-transparent",
              ].join(" ")}
              style={
                isOn
                  ? {
                      borderColor: `color-mix(in srgb, ${meta.hex} 50%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${meta.hex} 13%, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: isOn ? meta.hex : "var(--color-line-strong)",
                }}
              />
              {meta.label}
              <span className="tabular-nums opacity-60">
                {totals.byStatus[status]}
              </span>
            </button>
          );
        })}

        {isFiltered ? (
          <button
            type="button"
            onClick={() => setSelected(ALL_STATUSES)}
            className="text-muted hover:text-ink ml-1 text-sm font-bold underline decoration-1 underline-offset-4 transition-colors"
          >
            Show all
          </button>
        ) : null}

        <span className="text-muted ml-auto text-sm font-semibold tabular-nums">
          {shown} of {totals.tasks} shown
        </span>
      </div>

      {selected.size === 0 ? (
        <p className="border-line text-muted mt-4 rounded-md border border-dashed px-5 py-6 text-center text-sm font-medium">
          Every status is switched off, so nothing is listed. That is the filter,
          not the roadmap.
        </p>
      ) : (
        <div className="mt-4 space-y-2.5">
          {filtered.map(({ group, tasks }) => (
            <GroupPanel
              key={group.id}
              group={group}
              tasks={tasks}
              isOpen={open.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
              titleById={titleById}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- a group -- */

function GroupPanel({
  group,
  tasks,
  isOpen,
  onToggle,
  titleById,
}: {
  group: RoadmapGroup;
  tasks: RoadmapTask[];
  isOpen: boolean;
  onToggle: () => void;
  titleById: ReadonlyMap<string, string>;
}) {
  const panelId = `roadmap-group-${group.id}`;
  const isEmptyUnderFilter = tasks.length === 0;
  const hiddenCount = group.tasks.length - tasks.length;

  return (
    <section className="border-line overflow-hidden rounded-md border bg-white">
      <button
        type="button"
        onClick={onToggle}
        disabled={isEmptyUnderFilter}
        aria-expanded={isOpen && !isEmptyUnderFilter}
        aria-controls={panelId}
        className={[
          "flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors",
          isEmptyUnderFilter ? "cursor-default opacity-55" : "hover:bg-paper/70",
        ].join(" ")}
      >
        <span
          aria-hidden
          className={[
            "text-muted mt-[3px] inline-block shrink-0 text-base transition-transform",
            isOpen && !isEmptyUnderFilter ? "rotate-90" : "",
          ].join(" ")}
        >
          {"›"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="font-display block text-lg leading-snug font-medium tracking-[-0.012em]">
            {group.title}
          </span>
          <span className="text-muted mt-1 block text-sm leading-relaxed font-medium">
            {group.blurb}
          </span>
        </span>

        <span className="text-muted shrink-0 text-xs font-bold tabular-nums">
          {isEmptyUnderFilter
            ? `0 of ${group.tasks.length} tasks`
            : hiddenCount > 0
              ? `${tasks.length} of ${group.tasks.length} tasks`
              : `${group.tasks.length} tasks`}
        </span>
      </button>

      {isOpen && !isEmptyUnderFilter ? (
        <ul id={panelId} className="border-line border-t px-4">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} titleById={titleById} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ a task -- */

function TaskRow({
  task,
  titleById,
}: {
  task: RoadmapTask;
  titleById: ReadonlyMap<string, string>;
}) {
  const blockedByTitle =
    task.blockedBy === null ? null : (titleById.get(task.blockedBy) ?? null);

  return (
    <li className="border-line flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1 basis-[22rem]">
        <p className="text-base leading-snug font-bold">{task.title}</p>
        <p className="text-muted mt-1 text-sm leading-relaxed font-medium">
          {task.plain}
        </p>

        {task.blockedBy === null ? null : (
          <p className="text-muted mt-1.5 text-sm font-medium">
            <span className="text-ink font-bold">Waits on</span>{" "}
            {blockedByTitle ??
              // The id resolves to nothing in this payload. Printing the raw id
              // would be a dead reference dressed up as an answer.
              "a task that is not in this list: the dependency is real, the target is missing."}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {task.effort === null ? null : (
          <span
            className="bg-paper-2 text-ink rounded-full px-2.5 py-[3px] text-xs font-semibold whitespace-nowrap"
            title="Estimated effort, as written by hand"
          >
            <span className="sr-only">Estimated effort: </span>
            {task.effort}
          </span>
        )}
        <StatusChip status={task.status} />
      </div>
    </li>
  );
}

function StatusChip({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];

  return (
    <span
      className="text-ink inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-xs font-bold whitespace-nowrap"
      style={{
        borderColor: `color-mix(in srgb, ${meta.hex} 50%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${meta.hex} 13%, transparent)`,
      }}
      title={meta.meaning}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: meta.hex }}
      />
      {meta.label}
    </span>
  );
}
