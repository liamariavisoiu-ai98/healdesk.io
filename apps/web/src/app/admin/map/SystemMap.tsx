"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { boxOf, curveBetween, type Curve } from "@/lib/admin/map-geometry";
import {
  CANVAS,
  STATUS_WORDS,
  ZONES,
  type BridgeStatus,
  type BridgeView,
  type KeyHome,
  type KeyState,
  type KeyView,
  type MapView,
  type RotationState,
  type Todo,
  type TodoKind,
  type ToolDef,
} from "@/lib/admin/system-map";

/**
 * The system map: every tool as a box, every bridge as a curved line whose
 * arrow points the way data travels, coloured by whether the key it rides on
 * is in place. Tap a line or a box to see what it does, a real-life example,
 * and each key with its state and when to rotate it.
 *
 * ## Why a client component
 *
 * The picture is only readable if pointing at one line quietens the other
 * forty, and that is state the server cannot hold. Everything it draws was
 * worked out on the server by `assess()` and arrives as plain data: names,
 * colours and sentences, never a key. The one action, "I rotated it today",
 * is a server action that checks the session itself.
 *
 * ## Phones
 *
 * The diagram keeps its proportions and scrolls sideways inside its own card
 * below 900px, because a picture of forty bridges shrunk to a phone's width
 * is a smudge. Everything it says is also in the lists under it, which are
 * the phone's way in.
 */

export type RecordRotation = (keyId: string) => Promise<{ ok: true; on: string } | { ok: false; message: string }>;

/** Line colour per status: readable on white, and told apart by dash as well as hue. */
const STATUS_STYLE: Record<BridgeStatus, { stroke: string; dash?: string; width: number; tint: string }> = {
  working: { stroke: "#23915a", width: 2.6, tint: "#e3f4e8" },
  "needs-key": { stroke: "#c77c00", width: 2.8, tint: "#fff1d6" },
  off: { stroke: "#3a78c0", dash: "10 5", width: 2.4, tint: "#e2eefb" },
  broken: { stroke: "#da191a", width: 3.2, tint: "#fde2e2" },
  unknown: { stroke: "#8a99a6", width: 2.2, tint: "#eef1f4" },
  "to-build": { stroke: "#7a6bb0", dash: "3 6", width: 2.4, tint: "#eeeaf8" },
  parked: { stroke: "#b3bcc5", dash: "1 6", width: 2, tint: "#f3f4f6" },
  "not-checked": { stroke: "#5c6e7e", dash: "6 4", width: 2, tint: "#eef1f4" },
};

/** What each colour means, in the owner's words, in the order of the legend. */
const STATUS_MEANING: Record<BridgeStatus, string> = {
  working: "Every key it needs is in place. A ✓ means it was also tested live just now.",
  "needs-key": "Built and ready, waiting for you to add a key.",
  off: "Built, and switched off on purpose until something else is done first.",
  broken: "A live check failed, or two copies of a key disagree. Fix these first.",
  unknown: "Lives on the AWS host, which did not answer (usually standby).",
  "to-build": "Not built yet, or only half built.",
  parked: "Phase two: kept in the code, fenced out of v1.",
  "not-checked": "Its keys live where this page cannot look (your computer, GitHub's deploys).",
};

const LEGEND_ORDER: BridgeStatus[] = ["working", "needs-key", "off", "broken", "unknown", "to-build", "parked", "not-checked"];

/** Which bridges each status filter keeps bright. */
type Filter = "all" | "problems" | "patient" | "shop" | BridgeStatus;

const PROBLEMS: ReadonlySet<BridgeStatus> = new Set(["broken", "needs-key", "to-build", "unknown"]);

function keep(bridge: BridgeView, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "problems":
      return PROBLEMS.has(bridge.status);
    case "patient":
      return bridge.phi;
    case "shop":
      return !bridge.phi;
    default:
      return bridge.status === filter;
  }
}

const KEY_STATE: Record<KeyState, { word: string; tint: string; ink: string }> = {
  "in-place": { word: "In place", tint: "#e3f4e8", ink: "#145c37" },
  missing: { word: "Missing", tint: "#fff1d6", ink: "#7a4b00" },
  waiting: { word: "Waiting on purpose", tint: "#e2eefb", ink: "#1f4f86" },
  "optional-off": { word: "Optional, not added", tint: "#f1f1f1", ink: "#4a5a68" },
  unknown: { word: "Can't check now", tint: "#eef1f4", ink: "#4a5a68" },
  broken: { word: "Not working", tint: "#fde2e2", ink: "#9b1213" },
  "not-checked": { word: "Not checked here", tint: "#eef1f4", ink: "#4a5a68" },
  "per-clinic": { word: "One per clinic", tint: "#eeeaf8", ink: "#4b3d86" },
};

const ROTATION: Record<RotationState, { word: string; tint: string; ink: string } | null> = {
  ok: { word: "Up to date", tint: "#e3f4e8", ink: "#145c37" },
  "due-soon": { word: "Due soon", tint: "#fff1d6", ink: "#7a4b00" },
  overdue: { word: "Overdue", tint: "#fde2e2", ink: "#9b1213" },
  unrecorded: { word: "Not recorded", tint: "#f1f1f1", ink: "#4a5a68" },
  never: { word: "Never rotate", tint: "#fde2e2", ink: "#9b1213" },
  "only-if": { word: "Only if needed", tint: "#f1f1f1", ink: "#4a5a68" },
  public: null,
  "not-yet": null,
};

const TODO_HEADINGS: Record<TodoKind, string> = {
  fix: "Broken: fix these first",
  "add-key": "Keys to add",
  rotate: "Keys to rotate",
  build: "Still to build",
  check: "Couldn't check",
  waiting: "Waiting on purpose (nothing to do yet)",
};

const TODO_ORDER: TodoKind[] = ["fix", "add-key", "rotate", "build", "check", "waiting"];

const HOME_ORDER: KeyHome[] = ["vercel", "aws", "aws-ci", "computer", "clinic"];

type Selection = { kind: "bridge"; id: string } | { kind: "tool"; id: string } | null;

export function SystemMap({ view, recordRotation }: { view: MapView; recordRotation: RecordRotation }) {
  const tools = useMemo(() => new Map(view.tools.map((tool) => [tool.id, tool])), [view.tools]);
  const keys = useMemo(() => new Map(view.keys.map((key) => [key.id, key])), [view.keys]);
  const curves = useMemo(() => {
    const out = new Map<string, Curve>();
    for (const bridge of view.bridges) {
      out.set(bridge.id, curveBetween(boxOf(tools.get(bridge.from)!), boxOf(tools.get(bridge.to)!), bridge.bend ?? 0));
    }
    return out;
  }, [view.bridges, tools]);

  // Nothing is picked at first: the point of the page is the whole picture at
  // one look, and a pre-picked line would dim the other forty.
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Selection>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const focus = hover ?? selection;
  const lit = (bridge: BridgeView): boolean => {
    if (!keep(bridge, filter)) return false;
    if (!focus) return true;
    if (focus.kind === "bridge") return focus.id === bridge.id;
    return bridge.from === focus.id || bridge.to === focus.id;
  };
  const toolLit = (tool: ToolDef): boolean => {
    if (!focus && filter === "all") return true;
    return view.bridges.some((bridge) => lit(bridge) && (bridge.from === tool.id || bridge.to === tool.id)) || (focus?.kind === "tool" && focus.id === tool.id);
  };

  /** The worst status among a tool's bridges, for the dot in its corner. */
  const toolStatus = (tool: ToolDef): BridgeStatus | null => {
    const rank: BridgeStatus[] = ["broken", "needs-key", "unknown", "to-build", "off", "not-checked", "parked", "working"];
    const own = view.bridges.filter((bridge) => bridge.from === tool.id || bridge.to === tool.id).map((bridge) => bridge.status);
    return rank.find((status) => own.includes(status)) ?? null;
  };

  const select = (next: Selection) => {
    setSelection(next);
    if (typeof document !== "undefined") {
      document.getElementById("map-details")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  const selectedBridge = selection?.kind === "bridge" ? view.bridges.find((bridge) => bridge.id === selection.id) ?? null : null;
  const selectedTool = selection?.kind === "tool" ? tools.get(selection.id) ?? null : null;

  return (
    // grid-cols-1 is minmax(0, 1fr): without it the diagram's minimum width
    // stretches the column and the whole page scrolls sideways on a phone,
    // instead of the diagram scrolling inside its own card.
    <div className="mt-8 grid grid-cols-1 gap-8">
      <Summary view={view} filter={filter} setFilter={setFilter} />

      <p className={`max-w-[80ch] text-[15.6px] ${view.host.state === "answered" ? "text-muted" : "font-semibold"}`} role="status">
        {view.host.text}
        {view.rotationLog === "unavailable" ? " The rotation log could not be read, so no rotation dates are shown." : ""}
      </p>

      <section aria-labelledby="map-picture" className="border-line rounded-md border bg-white">
        <div className="border-line flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
          <h2 id="map-picture" className="text-sm font-bold tracking-[0.08em] uppercase">
            The whole system
          </h2>
          <FilterButtons filter={filter} setFilter={setFilter} />
          {focus || filter !== "all" ? (
            <button
              type="button"
              onClick={() => {
                setSelection(null);
                setFilter("all");
              }}
              className="text-muted hover:text-ink ml-auto min-h-11 text-sm font-semibold underline underline-offset-2"
            >
              Show everything
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
            className="block h-auto w-full min-w-[900px]"
            role="group"
            aria-label="A map of healdesk's tools and the bridges between them. Each line is listed with its details below."
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              {LEGEND_ORDER.map((status) => (
                <marker
                  key={status}
                  id={`arrow-${status}`}
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={STATUS_STYLE[status].stroke} />
                </marker>
              ))}
              <style>{`
                .hd-flow { stroke-dasharray: 0.1 22; animation: hd-flow 1.4s linear infinite; }
                @keyframes hd-flow { from { stroke-dashoffset: 22.1; } to { stroke-dashoffset: 0; } }
                @media (prefers-reduced-motion: reduce) { .hd-flow { animation: none; display: none; } }
                .hd-bridge:focus-visible .hd-hit { stroke: rgb(23 42 58 / 0.18); }
                .hd-tool:focus-visible rect.hd-box { stroke: #172a3a; stroke-width: 3; }
              `}</style>
            </defs>

            <Zones />

            {view.bridges.map((bridge) => {
              const curve = curves.get(bridge.id)!;
              const style = STATUS_STYLE[bridge.status];
              const on = lit(bridge);
              const picked = selection?.kind === "bridge" && selection.id === bridge.id;
              return (
                <g
                  key={bridge.id}
                  className="hd-bridge cursor-pointer outline-none"
                  role="button"
                  tabIndex={0}
                  aria-label={`Bridge ${bridge.n}: ${bridge.title}. ${STATUS_WORDS[bridge.status]}.`}
                  aria-pressed={picked}
                  opacity={on ? 1 : 0.12}
                  onClick={() => select({ kind: "bridge", id: bridge.id })}
                  onMouseEnter={() => setHover({ kind: "bridge", id: bridge.id })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select({ kind: "bridge", id: bridge.id });
                    }
                  }}
                >
                  <path className="hd-hit" d={curve.d} fill="none" stroke="transparent" strokeWidth={16} />
                  <path
                    d={curve.d}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={picked ? style.width + 1.6 : style.width}
                    strokeDasharray={style.dash}
                    strokeLinecap="round"
                    markerEnd={`url(#arrow-${bridge.status})`}
                    markerStart={bridge.both ? `url(#arrow-${bridge.status})` : undefined}
                  />
                  {bridge.status === "working" ? (
                    <path className="hd-flow" d={curve.d} fill="none" stroke="#0d5c34" strokeWidth={style.width + 3} strokeLinecap="round" />
                  ) : null}
                </g>
              );
            })}

            <ZoneLabels />

            {view.tools.map((tool) => (
              <ToolBox
                key={tool.id}
                tool={tool}
                status={toolStatus(tool)}
                dim={!toolLit(tool)}
                picked={selection?.kind === "tool" && selection.id === tool.id}
                onPick={() => select({ kind: "tool", id: tool.id })}
                onHover={(on) => setHover(on ? { kind: "tool", id: tool.id } : null)}
              />
            ))}

            {/* The numbers go on top of everything, so a line that passes behind
                a box can still be found and picked by its number. They repeat
                the line's own click, and are hidden from screen readers, which
                reach the same bridge through the line. */}
            {view.bridges.map((bridge) => {
              const curve = curves.get(bridge.id)!;
              const style = STATUS_STYLE[bridge.status];
              const picked = selection?.kind === "bridge" && selection.id === bridge.id;
              return (
                <g
                  key={bridge.id}
                  aria-hidden="true"
                  className="cursor-pointer"
                  opacity={lit(bridge) ? 1 : 0.12}
                  transform={`translate(${curve.middle.x} ${curve.middle.y})`}
                  onClick={() => select({ kind: "bridge", id: bridge.id })}
                  onMouseEnter={() => setHover({ kind: "bridge", id: bridge.id })}
                >
                  <circle r={picked ? 15 : 12.5} fill="#ffffff" stroke={style.stroke} strokeWidth={2} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={700} fill="#172a3a">
                    {bridge.n}
                  </text>
                  {bridge.proven ? (
                    <g transform="translate(11 -11)">
                      <circle r={7} fill={STATUS_STYLE.working.stroke} />
                      <path d="M -3.2 0 L -0.8 2.4 L 3.4 -2.4" stroke="#fff" strokeWidth={1.8} fill="none" strokeLinecap="round" />
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>

        <Legend />
      </section>

      <section id="map-details" aria-live="polite" className="scroll-mt-28">
        {selectedBridge ? (
          <BridgeDetails bridge={selectedBridge} tools={tools} keys={keys} recordRotation={recordRotation} />
        ) : selectedTool ? (
          <ToolDetails tool={selectedTool} bridges={view.bridges} onPick={(id) => select({ kind: "bridge", id })} />
        ) : (
          <p className="border-line text-muted rounded-md border border-dashed bg-white px-5 py-4 text-[15.6px]">
            Tap a line to see what travels along it, a real-life example, and its keys. Tap a box to see every line that
            touches it.
          </p>
        )}
      </section>

      <TodoList todos={view.todos} bridges={view.bridges} onPick={(id) => select({ kind: "bridge", id })} />

      <BridgeList bridges={view.bridges} tools={tools} onPick={(id) => select({ kind: "bridge", id })} />

      <KeyTable keys={view.keys} recordRotation={recordRotation} />

      <Retired />
    </div>
  );
}

// -----------------------------------------------------------------------------
// The picture's parts
// -----------------------------------------------------------------------------

function Zones() {
  const { patient, shop } = ZONES;
  return (
    <g aria-hidden="true" pointerEvents="none">
      <rect x={patient.x} y={patient.y} width={patient.w} height={patient.h} rx={22} fill="#dcefff" fillOpacity={0.45} stroke="#3a78c0" strokeOpacity={0.35} strokeDasharray="6 6" />
      <rect x={shop.x} y={shop.y} width={shop.w} height={shop.h} rx={22} fill="#f7f3ef" stroke="#c9b9a6" strokeDasharray="6 6" />
    </g>
  );
}

/** Drawn over the lines, with a white halo, so a line crossing a label never hides it. */
function ZoneLabels() {
  const { patient, shop } = ZONES;
  const halo = { stroke: "#ffffff", strokeWidth: 4, paintOrder: "stroke" as const, strokeLinejoin: "round" as const };
  return (
    <g aria-hidden="true" pointerEvents="none">
      <text x={patient.x + 18} y={patient.y + patient.h - 30} fontSize={13} fontWeight={700} fill="#1f4f86" {...halo}>
        PATIENT DATA LIVES ONLY HERE
      </text>
      <text x={patient.x + 18} y={patient.y + patient.h - 13} fontSize={12} fill="#1f4f86" {...halo}>
        our AWS account, under business associate agreements
      </text>
      <text x={shop.x + 18} y={shop.y + shop.h - 14} fontSize={13} fontWeight={700} fill="#6b5641" {...halo}>
        NO PATIENT DATA · Vercel
      </text>
    </g>
  );
}

function ToolBox({
  tool,
  status,
  dim,
  picked,
  onPick,
  onHover,
}: {
  tool: ToolDef;
  status: BridgeStatus | null;
  dim: boolean;
  picked: boolean;
  onPick: () => void;
  onHover: (on: boolean) => void;
}) {
  const box = boxOf(tool);
  const ours = tool.group === "ours";
  const people = tool.group === "people";
  return (
    <g
      className="hd-tool cursor-pointer outline-none"
      role="button"
      tabIndex={0}
      aria-label={`${tool.name}: ${tool.role}`}
      aria-pressed={picked}
      opacity={dim ? 0.35 : 1}
      onClick={onPick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick();
        }
      }}
    >
      <rect
        className="hd-box"
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={people ? box.h / 2 : ours ? 16 : 10}
        fill={ours ? "#172a3a" : tool.group === "aws" ? "#f4f9ff" : "#ffffff"}
        stroke={picked ? "#172a3a" : ours ? "#172a3a" : "rgb(23 42 58 / 0.3)"}
        strokeWidth={picked ? 3 : 1.4}
      />
      <text
        x={tool.x}
        y={tool.y - (ours ? 10 : 7)}
        textAnchor="middle"
        fontSize={ours ? 20 : 14.5}
        fontWeight={700}
        fill={ours ? "#ffffff" : "#172a3a"}
      >
        {tool.name}
      </text>
      <text x={tool.x} y={tool.y + (ours ? 16 : 13)} textAnchor="middle" fontSize={ours ? 12.5 : 11.2} fill={ours ? "#d7e0e8" : "#5c6e7e"}>
        {tool.role}
      </text>
      {status ? (
        <circle cx={box.x + box.w - 9} cy={box.y + 9} r={5} fill={STATUS_STYLE[status].stroke} stroke="#ffffff" strokeWidth={1.5}>
          <title>{STATUS_WORDS[status]}</title>
        </circle>
      ) : null}
    </g>
  );
}

function Legend() {
  return (
    <ul className="border-line grid gap-x-6 gap-y-2 border-t px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {LEGEND_ORDER.map((status) => (
        <li key={status} className="flex items-start gap-2">
          <svg width="34" height="14" aria-hidden="true" className="mt-1 shrink-0">
            <line x1="2" y1="7" x2="26" y2="7" stroke={STATUS_STYLE[status].stroke} strokeWidth={3} strokeDasharray={STATUS_STYLE[status].dash} strokeLinecap="round" />
            <path d="M 25 2 L 33 7 L 25 12 z" fill={STATUS_STYLE[status].stroke} />
          </svg>
          <span>
            <strong>{STATUS_WORDS[status]}.</strong> <span className="text-muted">{STATUS_MEANING[status]}</span>
          </span>
        </li>
      ))}
      <li className="text-muted flex items-start gap-2 sm:col-span-2 lg:col-span-4">
        The arrow points the way the information travels; an arrow at both ends means it goes both ways. The coloured dot on a
        box is the worst colour among its lines. Moving dots show a bridge that is connected.
      </li>
    </ul>
  );
}

function Summary({ view, filter, setFilter }: { view: MapView; filter: Filter; setFilter: (filter: Filter) => void }) {
  const tiles: BridgeStatus[] = ["working", "needs-key", "broken", "off", "to-build", "unknown"];
  return (
    <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {tiles.map((status) => (
        <button
          key={status}
          type="button"
          onClick={() => setFilter(filter === status ? "all" : status)}
          aria-pressed={filter === status}
          className="border-line hover:border-line-strong min-h-11 rounded-md border bg-white px-4 py-3 text-left transition-colors aria-pressed:ring-2 aria-pressed:ring-[#172a3a]"
          style={{ background: view.counts[status] > 0 ? STATUS_STYLE[status].tint : undefined }}
        >
          <span className="block text-[28px] leading-none font-bold tabular-nums">{view.counts[status]}</span>
          <span className="mt-1 block text-sm font-semibold">{STATUS_WORDS[status]}</span>
        </button>
      ))}
      <a
        href="#map-keys"
        className="border-line hover:border-line-strong min-h-11 rounded-md border bg-white px-4 py-3"
        style={{ background: view.rotationsDue > 0 ? STATUS_STYLE["needs-key"].tint : undefined }}
      >
        <span className="block text-[28px] leading-none font-bold tabular-nums">{view.rotationsDue}</span>
        <span className="mt-1 block text-sm font-semibold">Keys to rotate soon</span>
      </a>
    </section>
  );
}

function FilterButtons({ filter, setFilter }: { filter: Filter; setFilter: (filter: Filter) => void }) {
  const options: { value: Filter; label: string }[] = [
    { value: "all", label: "Everything" },
    { value: "problems", label: "Needs attention" },
    { value: "patient", label: "Carries patient data" },
    { value: "shop", label: "No patient data" },
  ];
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Highlight">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={filter === option.value}
          onClick={() => setFilter(option.value)}
          className="text-muted hover:text-ink aria-pressed:bg-ink inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold aria-pressed:text-white"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Details
// -----------------------------------------------------------------------------

function StatusPill({ status }: { status: BridgeStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-bold"
      style={{ background: STATUS_STYLE[status].tint, color: "#172a3a" }}
    >
      <span className="inline-block size-2.5 rounded-full" style={{ background: STATUS_STYLE[status].stroke }} />
      {STATUS_WORDS[status]}
    </span>
  );
}

function Pill({ word, tint, ink }: { word: string; tint: string; ink: string }) {
  return (
    <span className="inline-flex rounded-full px-2.5 py-0.5 text-[13px] font-bold whitespace-nowrap" style={{ background: tint, color: ink }}>
      {word}
    </span>
  );
}

function BridgeDetails({
  bridge,
  tools,
  keys,
  recordRotation,
}: {
  bridge: BridgeView;
  tools: Map<string, ToolDef>;
  keys: Map<string, KeyView>;
  recordRotation: RecordRotation;
}) {
  const from = tools.get(bridge.from)!;
  const to = tools.get(bridge.to)!;
  return (
    <article className="border-line rounded-md border bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-flex size-9 items-center justify-center rounded-full border-2 bg-white text-sm font-bold"
          style={{ borderColor: STATUS_STYLE[bridge.status].stroke }}
        >
          {bridge.n}
        </span>
        <h2 className="text-[22px] leading-tight font-bold">{bridge.title}</h2>
        <StatusPill status={bridge.status} />
        {bridge.testMode ? <Pill word="Stripe test mode: no real money yet" tint="#fff1d6" ink="#7a4b00" /> : null}
      </div>
      <p className="mt-3 text-[15.6px] font-semibold">
        {from.name} {bridge.both ? "⇄" : "→"} {to.name}
        <span className="text-muted font-normal"> · {bridge.phi ? "carries patient data, under the BAA" : "no patient data"}</span>
      </p>
      <p className="mt-1 max-w-[80ch] text-[15.6px]">{bridge.statusText}</p>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-muted text-xs font-bold tracking-[0.08em] uppercase">What travels</dt>
          <dd className="mt-1 text-[15.6px]">{bridge.carries}</dd>
        </div>
        <div>
          <dt className="text-muted text-xs font-bold tracking-[0.08em] uppercase">For example</dt>
          <dd className="mt-1 text-[15.6px]">{bridge.example}</dd>
        </div>
        {bridge.buildNote ? (
          <div className="sm:col-span-2">
            <dt className="text-muted text-xs font-bold tracking-[0.08em] uppercase">Still to do</dt>
            <dd className="mt-1 text-[15.6px]">{bridge.buildNote}</dd>
          </div>
        ) : null}
      </dl>

      <h3 className="text-muted mt-6 text-xs font-bold tracking-[0.08em] uppercase">
        {bridge.keys.length === 0 ? "Key" : bridge.keys.length === 1 ? "The key it rides on" : "The keys it rides on"}
      </h3>
      {bridge.keyless ? <p className="mt-2 max-w-[80ch] text-[15.6px]">{bridge.keyless}</p> : null}
      {bridge.keys.length > 0 ? (
        <ul className="mt-3 grid gap-3">
          {bridge.keys.map((id) => (
            <KeyRow key={id} keyView={keys.get(id)!} recordRotation={recordRotation} />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function KeyRow({ keyView, recordRotation }: { keyView: KeyView; recordRotation: RecordRotation }) {
  const state = KEY_STATE[keyView.state];
  const rotation = ROTATION[keyView.rotation.state];
  return (
    <li className="border-line rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold">{keyView.label}</span>
        <Pill {...state} />
        {rotation ? <Pill {...rotation} /> : null}
      </div>
      <p className="text-muted mt-1 text-sm break-words">
        {keyView.env ? <code className="text-ink font-mono">{keyView.env}</code> : null}
        {keyView.env ? " · " : ""}
        {keyView.homeLabel}
      </p>
      <p className="mt-1 text-sm">{keyView.stateText}</p>
      {keyView.rotation.state !== "public" ? <p className="mt-1 text-sm">{keyView.rotation.text}</p> : null}
      {keyView.rotation.how ? (
        <details className="mt-1 text-sm">
          <summary className="text-muted hover:text-ink min-h-11 cursor-pointer py-2 font-semibold">How to rotate it, and what happens meanwhile</summary>
          <p>{keyView.rotation.how}</p>
          {keyView.rotation.impact ? <p className="text-muted mt-1">{keyView.rotation.impact}</p> : null}
        </details>
      ) : null}
      {keyView.rotation.recordable ? <RotatedButton keyId={keyView.id} recordRotation={recordRotation} /> : null}
    </li>
  );
}

function RotatedButton({ keyId, recordRotation }: { keyId: string; recordRotation: RecordRotation }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const outcome = await recordRotation(keyId);
            setMessage(outcome.ok ? `Recorded as rotated on ${outcome.on}.` : outcome.message);
            if (outcome.ok) router.refresh();
          })
        }
        className="border-line hover:border-line-strong min-h-11 rounded-full border px-4 text-sm font-bold disabled:opacity-50"
      >
        {pending ? "Recording…" : "I rotated it today"}
      </button>
      {message ? (
        <span className="text-sm font-semibold" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}

function ToolDetails({ tool, bridges, onPick }: { tool: ToolDef; bridges: BridgeView[]; onPick: (id: string) => void }) {
  const own = bridges.filter((bridge) => bridge.from === tool.id || bridge.to === tool.id);
  return (
    <article className="border-line rounded-md border bg-white p-5 sm:p-6">
      <h2 className="text-[22px] leading-tight font-bold">{tool.name}</h2>
      <p className="text-muted mt-1 text-[15.6px]">
        {tool.role} ·{" "}
        {tool.side === "patient" ? "patient-data side" : tool.side === "shop" ? "no patient data" : "used by both sides"}
      </p>
      <h3 className="text-muted mt-5 text-xs font-bold tracking-[0.08em] uppercase">Its bridges</h3>
      <ul className="mt-2 grid gap-2">
        {own.map((bridge) => (
          <li key={bridge.id}>
            <BridgeButton bridge={bridge} onPick={onPick} />
          </li>
        ))}
      </ul>
    </article>
  );
}

function BridgeButton({ bridge, onPick, extra }: { bridge: BridgeView; onPick: (id: string) => void; extra?: string }) {
  return (
    <button
      type="button"
      onClick={() => onPick(bridge.id)}
      className="hover:bg-paper-2 flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left"
    >
      <span
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-white text-xs font-bold"
        style={{ borderColor: STATUS_STYLE[bridge.status].stroke }}
      >
        {bridge.n}
      </span>
      <span className="font-semibold">{bridge.title}</span>
      <StatusPill status={bridge.status} />
      {extra ? <span className="text-muted basis-full pl-10 text-sm">{extra}</span> : null}
    </button>
  );
}

// -----------------------------------------------------------------------------
// The lists
// -----------------------------------------------------------------------------

function TodoList({ todos, bridges, onPick }: { todos: Todo[]; bridges: BridgeView[]; onPick: (id: string) => void }) {
  const byKind = TODO_ORDER.map((kind) => ({ kind, items: todos.filter((todo) => todo.kind === kind) })).filter((group) => group.items.length > 0);
  return (
    <section aria-labelledby="map-left" className="border-line rounded-md border bg-white p-5 sm:p-6">
      <h2 id="map-left" className="text-sm font-bold tracking-[0.08em] uppercase">
        What&apos;s left
      </h2>
      {byKind.length === 0 ? (
        <p className="text-muted mt-3 text-[15.6px]">Nothing: every bridge is connected and no key is due.</p>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          {byKind.map((group) => (
            <div key={group.kind}>
              <h3 className="text-[17px] font-bold">
                {TODO_HEADINGS[group.kind]} <span className="text-muted font-semibold">({group.items.length})</span>
              </h3>
              <ul className="mt-2 grid gap-2">
                {group.items.map((todo, index) => {
                  const bridge = todo.bridge ? bridges.find((other) => other.id === todo.bridge) : undefined;
                  return (
                    <li key={`${group.kind}-${index}`} className="text-[15px]">
                      {bridge ? (
                        <button type="button" onClick={() => onPick(bridge.id)} className="hover:bg-paper-2 min-h-11 w-full rounded-md px-2 py-2 text-left">
                          <span className="mr-2 font-bold">#{bridge.n}</span>
                          {todo.text}
                        </button>
                      ) : (
                        <span className="block px-2 py-2">{todo.text}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BridgeList({ bridges, tools, onPick }: { bridges: BridgeView[]; tools: Map<string, ToolDef>; onPick: (id: string) => void }) {
  return (
    <section aria-labelledby="map-bridges" className="border-line rounded-md border bg-white p-5 sm:p-6">
      <h2 id="map-bridges" className="text-sm font-bold tracking-[0.08em] uppercase">
        Every bridge ({bridges.length})
      </h2>
      <ul className="mt-3 grid gap-1 lg:grid-cols-2">
        {bridges.map((bridge) => (
          <li key={bridge.id}>
            <BridgeButton
              bridge={bridge}
              onPick={onPick}
              extra={`${tools.get(bridge.from)!.name} ${bridge.both ? "⇄" : "→"} ${tools.get(bridge.to)!.name}${bridge.phi ? " · patient data" : ""}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeyTable({ keys, recordRotation }: { keys: KeyView[]; recordRotation: RecordRotation }) {
  return (
    <section id="map-keys" aria-labelledby="map-keys-title" className="border-line scroll-mt-28 rounded-md border bg-white p-5 sm:p-6">
      <h2 id="map-keys-title" className="text-sm font-bold tracking-[0.08em] uppercase">
        Every key, where it lives, and when to rotate it
      </h2>
      <p className="text-muted mt-2 max-w-[80ch] text-sm">
        Rotation schedules are suggestions until you adopt a policy. The date counts from the last time you pressed &ldquo;I
        rotated it today&rdquo;; a GitHub token&apos;s date is its real expiry, read from GitHub just now. This page never
        shows, stores or sends a key&apos;s value: it only checks whether each one is there.
      </p>
      {HOME_ORDER.map((home) => {
        const own = keys.filter((key) => key.home === home);
        if (own.length === 0) return null;
        return (
          <div key={home} className="mt-6">
            <h3 className="text-[17px] font-bold">
              {own[0]!.homeLabel} <span className="text-muted font-semibold">({own.length})</span>
            </h3>
            <ul className="mt-2 grid gap-2 lg:grid-cols-2">
              {own.map((key) => (
                <KeyRow key={key.id} keyView={key} recordRotation={recordRotation} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function Retired() {
  return (
    <section aria-labelledby="map-retired" className="text-muted max-w-[80ch] text-sm">
      <h2 id="map-retired" className="text-ink text-sm font-bold tracking-[0.08em] uppercase">
        Retired, and not on the map
      </h2>
      <p className="mt-2">
        Synthflow (replaced by Retell on 5 October 2026) and its two secrets, HEALDESK_VOICE_WEBHOOK_SECRET and
        HEALDESK_VOICE_TOOLS_SECRET; Twilio and Deepgram, still listed in .env.example but read by nothing. Delete any of
        these wherever they are still set.
      </p>
    </section>
  );
}
