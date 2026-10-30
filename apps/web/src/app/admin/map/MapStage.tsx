"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  BANDS,
  CARD,
  GROUP_AT,
  nodeRect,
  STAGE,
  toolsIn,
  worst,
  type Bundle,
  type HubId,
  type Lane,
  type Layout,
  type NodeId,
} from "@/lib/admin/map-layout";
import { GROUPS, STATUS_WORDS, type Band, type BridgeStatus, type BridgeView, type GroupDef, type ToolDef } from "@/lib/admin/system-map";

import { Glyph, Icon } from "./icons";
import { FLOW_SPEED, STATUS_STYLE } from "./map-ui";

/**
 * The picture: three bands, two hubs, twelve category cards, and one line
 * per pair of things that talk, a lane for each direction.
 *
 * ## Motion, and how little of it
 *
 * Only connected lanes move: a single small dot drifts along each at walking
 * pace (a second on busy lanes), so the eye reads "this works, and this is
 * the way it goes" without being pulled about. Problems never move; they get
 * a still badge with a symbol. The page eases in once, the two hubs breathe
 * very slowly, and a story plays only when asked. With reduced motion
 * switched on in the system, none of it runs and nothing is lost: the
 * arrows still say the direction.
 *
 * ## One stage, scaled
 *
 * Cards are HTML, for real type, and lines are SVG; both are placed on the
 * same 1400 × 1000 stage (lib/admin/map-layout.ts), which is scaled to the
 * width available. Below about 870px it stops shrinking and scrolls sideways
 * inside its own frame, because a smaller picture stops being readable.
 */

export type Selection =
  | { kind: "hub"; id: HubId }
  | { kind: "group"; id: string }
  | { kind: "tool"; id: string }
  | { kind: "bundle"; id: string }
  | { kind: "bridge"; id: string };

const MIN_SCALE = 0.62;

/** Each band's accent: the patient side blue, what is shared slate, the shop side warm. */
/** Each band's colour at its top edge, solid, for what sits on it above the lines. */
const BAND_PAPER: Record<Band, string> = { patient: "#f1f7fe", shared: "#f6f7f9", shop: "#fdf8f2" };

export const BAND_ACCENT: Record<Band, { ink: string; tint: string; field: string; edge: string }> = {
  patient: { ink: "#255d99", tint: "#e5effa", field: "linear-gradient(180deg, #f1f7fe 0%, #f7fbff 100%)", edge: "#cfe0f3" },
  shared: { ink: "#475569", tint: "#eef1f5", field: "linear-gradient(180deg, #f6f7f9 0%, #fafbfc 100%)", edge: "#dfe4ea" },
  shop: { ink: "#93591a", tint: "#f8eedf", field: "linear-gradient(180deg, #fdf8f2 0%, #fffcf8 100%)", edge: "#eedfcb" },
};

function useScale(frame: React.RefObject<HTMLDivElement | null>): number | null {
  const [scale, setScale] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setScale(Math.max(MIN_SCALE, Math.min(1, element.clientWidth / STAGE.width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);
  return scale;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function MapStage({
  bridges,
  tools,
  layout,
  isLit,
  dimming,
  selection,
  storyLane,
  reducedMotion,
  onSelect,
  onHover,
}: {
  bridges: Map<string, BridgeView>;
  tools: Map<string, ToolDef>;
  layout: Layout;
  /** Whether a bridge stays bright under the current lens, selection or story. */
  isLit: (bridgeId: string) => boolean;
  /** Whether anything is narrowed at all: when not, nothing is dimmed. */
  dimming: boolean;
  selection: Selection | null;
  /** The lane a story is playing along, and which bridge. */
  storyLane: { lane: Lane; bridge: string } | null;
  reducedMotion: boolean;
  onSelect: (selection: Selection) => void;
  onHover: (selection: Selection | null) => void;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const scale = useScale(frame);

  const nameOf = (node: NodeId): string => tools.get(node)?.name ?? GROUPS.find((group) => group.id === node)?.name ?? node;
  const statusOf = (ids: readonly string[]): BridgeStatus => worst(ids.map((id) => bridges.get(id)!.status)) ?? "working";

  /** Every bridge touching a node, as drawn: for card colours and counts. */
  const byNode = useMemo(() => {
    const out = new Map<NodeId, string[]>();
    for (const bundle of layout.bundles) {
      for (const node of [bundle.a, bundle.b]) out.set(node, [...(out.get(node) ?? []), ...bundle.bridges]);
    }
    for (const [node, ids] of Object.entries(layout.internal)) out.set(node as NodeId, [...(out.get(node as NodeId) ?? []), ...(ids ?? [])]);
    return out;
  }, [layout]);

  const nodeLit = (node: NodeId): boolean => {
    if (!dimming) return true;
    if (selection && (selection.kind === "hub" || selection.kind === "group") && selection.id === node) return true;
    return (byNode.get(node) ?? []).some(isLit);
  };
  const toolLit = (toolId: string): boolean => {
    if (!dimming) return true;
    if (selection?.kind === "tool" && selection.id === toolId) return true;
    return [...bridges.values()].some((bridge) => (bridge.from === toolId || bridge.to === toolId) && isLit(bridge.id));
  };
  const toolStatus = (toolId: string): BridgeStatus | null =>
    worst([...bridges.values()].filter((bridge) => bridge.from === toolId || bridge.to === toolId).map((bridge) => bridge.status));

  return (
    <div ref={frame} className="relative w-full overflow-x-auto overflow-y-hidden" style={{ height: scale ? STAGE.height * scale : undefined }}>
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: STAGE.width,
          height: STAGE.height,
          transform: `scale(${scale ?? 1})`,
          opacity: scale ? 1 : 0,
          transition: "opacity var(--duration-slow) var(--ease-standard)",
        }}
        onMouseLeave={() => onHover(null)}
      >
        <style>{`
          @keyframes hdm-rise { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
          @keyframes hdm-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
          @keyframes hdm-fade { from { opacity: 0; } to { opacity: 1; } }
          @keyframes hdm-breathe { 0%, 100% { box-shadow: 0 0 0 0 var(--hdm-glow); } 50% { box-shadow: 0 0 0 9px transparent; } }
          .hdm-rise { animation: hdm-rise var(--duration-slow) var(--ease-out) both; }
          .hdm-draw { animation: hdm-draw var(--duration-slower) var(--ease-in-out) both; }
          .hdm-fade { animation: hdm-fade var(--duration-slow) var(--ease-standard) both; }
          .hdm-breathe { animation: hdm-breathe 4.8s ease-in-out infinite; }
          .hdm-dim { transition: opacity var(--duration-base) var(--ease-standard); }
          @media (prefers-reduced-motion: reduce) { .hdm-rise, .hdm-draw, .hdm-fade, .hdm-breathe { animation: none !important; } }
        `}</style>

        <Bands />

        <svg width={STAGE.width} height={STAGE.height} viewBox={`0 0 ${STAGE.width} ${STAGE.height}`} className="absolute inset-0" aria-hidden="false" role="group" aria-label="Connections">
          <defs>
            {(Object.keys(STATUS_STYLE) as BridgeStatus[]).map((status) => (
              <marker key={status} id={`hdm-arrow-${status}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 1 L 9 5 L 0 9 z" fill={STATUS_STYLE[status].stroke} />
              </marker>
            ))}
            <filter id="hdm-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {layout.bundles.map((bundle, index) => (
            <BundleLines
              key={bundle.id}
              bundle={bundle}
              names={[nameOf(bundle.a), nameOf(bundle.b)]}
              order={index}
              statusOf={statusOf}
              lit={!dimming || bundle.bridges.some(isLit)}
              picked={selection?.kind === "bundle" && selection.id === bundle.id}
              reducedMotion={reducedMotion}
              story={Boolean(storyLane)}
              workingCount={(lane) => lane.bridges.filter((id) => bridges.get(id)!.status === "working").length}
              onSelect={() => onSelect({ kind: "bundle", id: bundle.id })}
              onHover={(on) => onHover(on ? { kind: "bundle", id: bundle.id } : null)}
            />
          ))}

          {storyLane ? <StoryComet key={`${storyLane.bridge}`} lane={storyLane.lane} status={bridges.get(storyLane.bridge)!.status} reducedMotion={reducedMotion} /> : null}
        </svg>

        {(["app", "web"] as const).map((hub, index) => (
          <HubCard
            key={hub}
            hub={hub}
            tool={tools.get(hub)!}
            ids={byNode.get(hub) ?? []}
            bridges={bridges}
            lit={nodeLit(hub)}
            picked={selection?.kind === "hub" && selection.id === hub}
            order={index}
            onSelect={() => onSelect({ kind: "hub", id: hub })}
            onHover={(on) => onHover(on ? { kind: "hub", id: hub } : null)}
          />
        ))}

        {GROUPS.map((group, index) => (
          <GroupCard
            key={group.id}
            group={group}
            tools={toolsIn(group.id).map((id) => tools.get(id)!)}
            status={statusOf(byNode.get(group.id) ?? [])}
            ids={byNode.get(group.id) ?? []}
            bridges={bridges}
            lit={nodeLit(group.id)}
            toolLit={toolLit}
            toolStatus={toolStatus}
            picked={selection?.kind === "group" && selection.id === group.id}
            pickedTool={selection?.kind === "tool" ? selection.id : null}
            order={index + 2}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Bands
// -----------------------------------------------------------------------------

function Bands() {
  return (
    <>
      {(Object.keys(BANDS) as Band[]).map((band) => {
        const area = BANDS[band];
        const accent = BAND_ACCENT[band];
        return (
          <div
            key={band}
            className="absolute rounded-lg border"
            style={{ left: area.x, top: area.y, width: area.w, height: area.h, background: accent.field, borderColor: accent.edge }}
          >
            {/* Above the lines, on the band's own colour, so a line that has to
                cross a band's label passes behind it rather than through it. */}
            <div
              className={`absolute z-[1] flex items-baseline gap-2 rounded-sm px-1.5 py-0.5 ${band === "shared" ? "top-[18px] left-[18px] max-w-[260px] flex-col gap-1" : "top-3 left-[18px]"}`}
              style={{ background: BAND_PAPER[band] }}
            >
              <span className="text-xs font-bold tracking-[0.14em] uppercase" style={{ color: accent.ink }}>
                {area.title}
              </span>
              <span className="text-xs" style={{ color: accent.ink, opacity: 0.8 }}>
                {area.note}
              </span>
            </div>
          </div>
        );
      })}
      {/* The patient-data line itself: where the patient side ends. */}
      <div
        className="absolute flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs font-bold shadow-sm"
        style={{ left: BANDS.shared.x + 24, top: BANDS.shared.y - 13, color: BAND_ACCENT.patient.ink, borderColor: BAND_ACCENT.patient.edge }}
      >
        <Icon name="shield" className="size-3.5" strokeWidth={2.2} />
        The patient-data line: no system below it holds patient data
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

function BundleLines({
  bundle,
  names,
  order,
  statusOf,
  lit,
  picked,
  reducedMotion,
  story,
  workingCount,
  onSelect,
  onHover,
}: {
  bundle: Bundle;
  names: [string, string];
  order: number;
  statusOf: (ids: readonly string[]) => BridgeStatus;
  lit: boolean;
  picked: boolean;
  reducedMotion: boolean;
  story: boolean;
  workingCount: (lane: Lane) => number;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const status = statusOf(bundle.bridges);
  const sealed = bundle.id === "app~web";
  const count = bundle.bridges.length;
  const label = `${names[0]} and ${names[1]}: ${count} ${count === 1 ? "connection" : "connections"}, ${STATUS_WORDS[status].toLowerCase()}`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={picked}
      className="hdm-dim cursor-pointer outline-none"
      opacity={lit ? 1 : 0.13}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {bundle.lanes.map((lane) => {
        const laneStatus = statusOf(lane.bridges);
        const style = STATUS_STYLE[laneStatus];
        const delay = 260 + order * 55;
        const flowing = !reducedMotion && !story && workingCount(lane) > 0;
        const dots = workingCount(lane) >= 3 ? 2 : 1;
        const duration = Math.max(3.2, lane.length / FLOW_SPEED);
        return (
          <g key={lane.id}>
            {/* A wide, faint track: the line's body, and an easy target. */}
            <path d={lane.d} fill="none" stroke={style.stroke} strokeOpacity={picked ? 0.2 : 0.1} strokeWidth={picked ? 14 : 10} strokeLinecap="round" className="hdm-fade" style={{ animationDelay: `${delay}ms` }} />
            {style.dash ? (
              <path
                d={lane.d}
                fill="none"
                stroke={style.stroke}
                strokeWidth={picked ? 3 : 2.2}
                strokeDasharray={style.dash}
                strokeLinecap="round"
                markerEnd={`url(#hdm-arrow-${laneStatus})`}
                className="hdm-fade"
                style={{ animationDelay: `${delay}ms` }}
              />
            ) : (
              <path
                d={lane.d}
                fill="none"
                stroke={style.stroke}
                strokeWidth={picked ? 3 : 2.2}
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray="1"
                markerEnd={`url(#hdm-arrow-${laneStatus})`}
                className="hdm-draw"
                style={{ animationDelay: `${delay}ms` }}
              />
            )}
            {flowing
              ? Array.from({ length: dots }, (_, dot) => (
                  <circle key={dot} r={3} fill="#ffffff" stroke={style.stroke} strokeWidth={1.6}>
                    <animateMotion
                      dur={`${duration.toFixed(2)}s`}
                      begin={`-${((duration * (dot + 0.35 + order * 0.17)) / dots) % duration}s`}
                      repeatCount="indefinite"
                      path={lane.d}
                      calcMode="linear"
                    />
                  </circle>
                ))
              : null}
          </g>
        );
      })}
      {sealed ? (
        // Seated on the patient-data line itself, which is the one place
        // this bridge crosses, rather than halfway along it.
        <Seal x={bundle.middle.x} y={BANDS.shared.y - 6} status={status} />
      ) : status !== "working" ? (
        <g transform={`translate(${bundle.middle.x} ${bundle.middle.y})`} className="hdm-fade" style={{ animationDelay: `${700 + order * 55}ms` }}>
          <circle r={13} fill="#ffffff" stroke={STATUS_STYLE[status].stroke} strokeWidth={2} />
          <Glyph name={STATUS_STYLE[status].icon} x={0} y={0} size={14} color={STATUS_STYLE[status].stroke} />
        </g>
      ) : null}
    </g>
  );
}

/** The one bridge between the two apps across the patient-data line: a sealed envelope, signed both ends. */
function Seal({ x, y, status }: { x: number; y: number; status: BridgeStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <g transform={`translate(${x} ${y})`} className="hdm-fade" style={{ animationDelay: "900ms" }}>
      <rect x={-74} y={-15} width={148} height={30} rx={15} fill="#ffffff" stroke={style.stroke} strokeWidth={1.8} />
      <Glyph name="lock" x={-54} y={0} size={15} color={style.stroke} />
      <text x={-40} y={0} dominantBaseline="central" fontSize={12.5} fontWeight={700} fill="#172a3a">
        Sealed envelopes
      </text>
    </g>
  );
}

function StoryComet({ lane, status, reducedMotion }: { lane: Lane; status: BridgeStatus; reducedMotion: boolean }) {
  const style = STATUS_STYLE[status];
  const ok = status === "working";
  return (
    <g pointerEvents="none">
      <path d={lane.d} fill="none" stroke={style.stroke} strokeWidth={5} strokeLinecap="round" strokeOpacity={0.9} markerEnd={`url(#hdm-arrow-${status})`} />
      {reducedMotion ? null : (
        <circle r={ok ? 7 : 6} fill={ok ? "#ffffff" : style.stroke} stroke={style.stroke} strokeWidth={2.5} filter="url(#hdm-glow)">
          <animateMotion dur="1.7s" repeatCount="indefinite" path={lane.d} calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.25 1" />
        </circle>
      )}
    </g>
  );
}

// -----------------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------------

function connectedCount(ids: readonly string[], bridges: Map<string, BridgeView>): { working: number; total: number } {
  const unique = [...new Set(ids)];
  return { working: unique.filter((id) => bridges.get(id)!.status === "working").length, total: unique.length };
}

function HubCard({
  hub,
  tool,
  ids,
  bridges,
  lit,
  picked,
  order,
  onSelect,
  onHover,
}: {
  hub: HubId;
  tool: ToolDef;
  ids: readonly string[];
  bridges: Map<string, BridgeView>;
  lit: boolean;
  picked: boolean;
  order: number;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const rect = nodeRect(hub);
  const { working, total } = connectedCount(ids, bridges);
  const healthy = working === total;
  const patient = hub === "app";
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      aria-pressed={picked}
      className={`hdm-dim absolute rounded-md p-4 text-left text-white shadow-lg outline-none focus-visible:ring-4 focus-visible:ring-[#9cc3ee] ${picked ? "ring-4 ring-[#9cc3ee]" : ""}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        background: patient ? "linear-gradient(135deg, #12304d 0%, #1c4a73 100%)" : "linear-gradient(135deg, #2a2118 0%, #4a3826 100%)",
        opacity: lit ? 1 : 0.25,
      }}
    >
      <span
        className="hdm-breathe pointer-events-none absolute inset-0 rounded-md"
        style={{ ["--hdm-glow" as string]: healthy ? "rgb(31 157 92 / .35)" : "rgb(212 134 11 / .38)" } as React.CSSProperties}
      />
      <span className="hdm-rise flex items-center gap-3" style={{ animationDelay: `${order * 70}ms` }}>
        <span className="grid size-11 shrink-0 place-items-center rounded-sm bg-white/12 ring-1 ring-white/15">
          <Icon name={tool.icon} className="size-6" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg leading-tight font-bold tracking-[-0.01em]">{tool.name}</span>
          <span className="block text-xs text-white/70">{tool.role}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 self-start text-xs font-semibold whitespace-nowrap text-white/85" title={`${working} of ${total} connected`}>
          <span className="inline-block size-2 rounded-full" style={{ background: healthy ? "#4ade80" : "#fbbf24" }} />
          {working}/{total}
        </span>
      </span>
      <span className="mt-3 flex items-center gap-2 text-xs font-semibold">
        <span className="flex items-center gap-1.5 rounded-full bg-white/12 px-2.5 py-1 whitespace-nowrap ring-1 ring-white/15">
          <Icon name={patient ? "shield" : "store"} className="size-3.5" strokeWidth={2.2} />
          {patient ? "Holds patient data, under BAAs" : "Never holds patient data"}
        </span>
      </span>
    </button>
  );
}

function GroupCard({
  group,
  tools,
  status,
  ids,
  bridges,
  lit,
  toolLit,
  toolStatus,
  picked,
  pickedTool,
  order,
  onSelect,
  onHover,
}: {
  group: GroupDef;
  tools: ToolDef[];
  status: BridgeStatus;
  ids: readonly string[];
  bridges: Map<string, BridgeView>;
  lit: boolean;
  toolLit: (toolId: string) => boolean;
  toolStatus: (toolId: string) => BridgeStatus | null;
  picked: boolean;
  pickedTool: string | null;
  order: number;
  onSelect: (selection: Selection) => void;
  onHover: (selection: Selection | null) => void;
}) {
  const rect = nodeRect(group.id);
  const accent = BAND_ACCENT[group.band];
  const { working, total } = connectedCount(ids, bridges);
  return (
    // Two layers on purpose: the outer one dims, the inner one rises in once.
    // On a single element the entrance animation's last frame would hold its
    // opacity at 1 and the card would never dim.
    <div className="hdm-dim absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: lit ? 1 : 0.25 }}>
      <div
        className={`hdm-rise h-full rounded-md border bg-white shadow-sm ${picked ? "ring-[3px]" : ""}`}
        style={{
          borderColor: picked ? accent.ink : "rgb(23 42 58 / 0.1)",
          ["--tw-ring-color" as string]: `${accent.ink}55`,
          animationDelay: `${120 + order * 60}ms`,
        } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => onSelect({ kind: "group", id: group.id })}
          onMouseEnter={() => onHover({ kind: "group", id: group.id })}
          onMouseLeave={() => onHover(null)}
          aria-pressed={picked}
          className="flex w-full items-center gap-2.5 rounded-t-md px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#172a3a]"
          style={{ height: CARD.head }}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-sm" style={{ background: accent.tint, color: accent.ink }}>
            <Icon name={group.icon} className="size-4" strokeWidth={2} />
          </span>
          <span className="min-w-0 truncate text-sm font-bold text-[#172a3a]">{group.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#5c6e7e]" title={`${working} of ${total} connected`}>
            <span className="inline-block size-2 rounded-full" style={{ background: STATUS_STYLE[status].stroke }} />
            {working}/{total}
          </span>
        </button>
        <div className="grid px-3" style={{ gridTemplateColumns: `repeat(${GROUP_AT[group.id].cols}, minmax(0, 1fr))`, gap: CARD.gap }}>
          {tools.map((tool) => {
            const own = toolStatus(tool.id);
            const chosen = pickedTool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                title={`${tool.name}: ${tool.role}`}
                onClick={() => onSelect({ kind: "tool", id: tool.id })}
                onMouseEnter={() => onHover({ kind: "tool", id: tool.id })}
                onMouseLeave={() => onHover(null)}
                aria-pressed={chosen}
                className={`hdm-dim flex min-w-0 items-center gap-2 rounded-sm px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#172a3a] ${chosen ? "bg-[#172a3a] text-white" : "bg-[#f4f6f9] text-[#172a3a] hover:bg-[#e9eef4]"}`}
                style={{ height: CARD.chip, opacity: toolLit(tool.id) ? 1 : 0.4 }}
              >
                <Icon name={tool.icon} className={`size-4 shrink-0 ${chosen ? "text-white" : "text-[#5c6e7e]"}`} />
                <span className="min-w-0 truncate text-xs font-semibold">{tool.name}</span>
                {own ? <span className="ml-auto inline-block size-2 shrink-0 rounded-full" style={{ background: STATUS_STYLE[own].stroke }} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

