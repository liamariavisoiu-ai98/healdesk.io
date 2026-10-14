"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { layoutBundles, nodeOfTool, type Lane } from "@/lib/admin/map-layout";
import { STATUS_WORDS, STORIES, type BridgeStatus, type MapView } from "@/lib/admin/system-map";

import { Icon } from "./icons";
import { MapDrawer, type RecordRotation } from "./MapDrawer";
import { MapLists } from "./MapLists";
import { MapStage, usePrefersReducedMotion, type Selection } from "./MapStage";
import { inLens, LEGEND_ORDER, LENSES, STATUS_MEANING, STATUS_STYLE, type Lens } from "./map-ui";

export type { RecordRotation };

/**
 * The system map, put together: how healthy the whole thing is at a glance,
 * the picture (which can be narrowed to one purpose or played as a story),
 * a panel with the details of whatever is tapped, and the lists.
 *
 * Everything it draws was worked out on the server by `assess()` and arrives
 * as plain data: names, colours and sentences, never a key. The one action,
 * "I rotated it today", is a server action that checks the session itself.
 */

/** How long a story lingers on each step: long enough to read the sentence. */
const STEP_MS = 4600;

type Story = { id: string; step: number; playing: boolean };

export function SystemMap({ view, recordRotation }: { view: MapView; recordRotation: RecordRotation }) {
  const layout = useMemo(() => layoutBundles(), []);
  const bridges = useMemo(() => new Map(view.bridges.map((bridge) => [bridge.id, bridge])), [view.bridges]);
  const tools = useMemo(() => new Map(view.tools.map((tool) => [tool.id, tool])), [view.tools]);
  const reducedMotion = usePrefersReducedMotion();

  const [lens, setLens] = useState<Lens>("all");
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<Selection | null>(null);
  const [story, setStory] = useState<Story | null>(null);

  const storyDef = story ? STORIES.find((candidate) => candidate.id === story.id)! : null;
  const storyBridge = story && storyDef ? storyDef.steps[story.step]!.bridge : null;

  // A playing story moves on by itself, and stops at its last step.
  useEffect(() => {
    if (!story?.playing || !storyDef) return;
    const timer = window.setTimeout(() => {
      setStory((current) => {
        if (!current) return current;
        const last = current.step >= storyDef.steps.length - 1;
        return last ? { ...current, playing: false } : { ...current, step: current.step + 1 };
      });
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [story, storyDef]);

  const close = useCallback(() => setSelection(null), []);

  const touches = (bridgeId: string, focus: Selection): boolean => {
    const bridge = bridges.get(bridgeId)!;
    switch (focus.kind) {
      case "hub":
      case "group":
        return nodeOfTool(bridge.from) === focus.id || nodeOfTool(bridge.to) === focus.id;
      case "tool":
        return bridge.from === focus.id || bridge.to === focus.id;
      case "bundle":
        return layout.bundles.find((bundle) => bundle.id === focus.id)?.bridges.includes(bridgeId) ?? false;
      case "bridge":
        return bridge.id === focus.id;
    }
  };

  const focus = hover ?? selection;
  const isLit = (bridgeId: string): boolean => {
    if (storyBridge) return bridgeId === storyBridge;
    if (!inLens(bridges.get(bridgeId)!, lens, status)) return false;
    return focus ? touches(bridgeId, focus) : true;
  };
  const dimming = Boolean(storyBridge || lens !== "all" || status || focus);

  const storyLane = laneFor(storyBridge, bridges.get(storyBridge ?? "")?.from, layout.bundles);

  const select = (next: Selection) => {
    setStory(null);
    setSelection(next);
  };

  return (
    <div className="mt-8 grid grid-cols-1 gap-6">
      <Overview view={view} status={status} setStatus={setStatus} />

      <section
        aria-label="The whole system"
        className="overflow-hidden rounded-lg border border-[rgb(23_42_58/0.1)] bg-white shadow-md"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-[rgb(23_42_58/0.08)] px-4 py-3 sm:px-5">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1 rounded-lg bg-[#f1f3f6] p-1">
            {LENSES.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={lens === option.id}
                onClick={() => {
                  setStory(null);
                  setLens(option.id);
                }}
                className="min-h-10 rounded-full px-3.5 text-[13.5px] font-bold text-[#5c6e7e] transition-colors hover:text-[#172a3a] aria-pressed:bg-white aria-pressed:text-[#172a3a] aria-pressed:shadow-sm"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
            <span className="mr-1 text-[12px] font-bold tracking-[0.1em] text-[#5c6e7e] uppercase">Play a story</span>
            {STORIES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={story?.id === entry.id}
                onClick={() => {
                  setSelection(null);
                  setStory({ id: entry.id, step: 0, playing: true });
                }}
                className="flex min-h-10 items-center gap-1.5 rounded-full border border-[rgb(23_42_58/0.12)] px-3 text-[13px] font-bold text-[#172a3a] hover:border-[rgb(23_42_58/0.3)] aria-pressed:border-[#172a3a] aria-pressed:bg-[#172a3a] aria-pressed:text-white"
              >
                <Icon name="play" className="size-3" />
                {entry.title}
              </button>
            ))}
          </div>
        </div>

        {story && storyDef ? (
          <StoryBar
            title={storyDef.title}
            step={story.step}
            steps={storyDef.steps.map((step) => ({
              text: step.text,
              status: bridges.get(step.bridge)!.status,
              statusText: bridges.get(step.bridge)!.statusText,
            }))}
            playing={story.playing}
            onStep={(step) => setStory({ ...story, step, playing: false })}
            onToggle={() =>
              setStory({
                ...story,
                playing: !story.playing,
                step: !story.playing && story.step >= storyDef.steps.length - 1 ? 0 : story.step,
              })
            }
            onClose={() => setStory(null)}
            onOpen={() => setSelection({ kind: "bridge", id: storyDef.steps[story.step]!.bridge })}
          />
        ) : null}

        <p className="px-4 pt-3 text-[13px] font-semibold text-[#5c6e7e] sm:hidden">Swipe sideways to see the whole map, or use the lists below.</p>
        <div className="p-2 sm:p-3">
          <MapStage
            bridges={bridges}
            tools={tools}
            layout={layout}
            isLit={isLit}
            dimming={dimming}
            selection={selection}
            storyLane={storyLane}
            reducedMotion={reducedMotion}
            onSelect={select}
            onHover={setHover}
          />
        </div>

        <Legend />
      </section>

      <div id="map-lists" className="scroll-mt-28">
        <MapLists view={view} tools={tools} onSelect={select} recordRotation={recordRotation} />
      </div>

      <p className="max-w-[80ch] text-[13.5px] text-[#5c6e7e]">
        <strong className="text-[#172a3a]">Retired, and not on the map:</strong> Synthflow (replaced by Retell on 5 October 2026)
        and its two secrets, HEALDESK_VOICE_WEBHOOK_SECRET and HEALDESK_VOICE_TOOLS_SECRET; Twilio and Deepgram, still listed in
        .env.example but read by nothing. Delete any of these wherever they are still set.
      </p>

      <MapDrawer selection={selection} view={view} layout={layout} onClose={close} onSelect={select} recordRotation={recordRotation} />
    </div>
  );
}

/** The lane a story's step plays along: the bundle holding the bridge, in its direction of travel. */
function laneFor(bridgeId: string | null, from: string | undefined, bundles: ReturnType<typeof layoutBundles>["bundles"]): { lane: Lane; bridge: string } | null {
  if (!bridgeId || !from) return null;
  for (const bundle of bundles) {
    const lane = bundle.lanes.find((candidate) => candidate.bridges.includes(bridgeId) && candidate.from === nodeOfTool(from));
    if (lane) return { lane, bridge: bridgeId };
  }
  return null;
}

// -----------------------------------------------------------------------------
// The overview
// -----------------------------------------------------------------------------

const HOST: Record<MapView["host"]["state"], { label: string; dot: string; ink: string }> = {
  answered: { label: "AWS host answering: its keys are read live", dot: "#1f9d5c", ink: "#125f37" },
  silent: { label: "AWS host not answering: its keys can't be checked", dot: "#94a3b3", ink: "#475569" },
  refused: { label: "AWS host refused the signed call", dot: "#dc2626", ink: "#9b1213" },
  unconfigured: { label: "This deployment can't reach the AWS host", dot: "#d4860b", ink: "#7a4b00" },
};

function Overview({ view, status, setStatus }: { view: MapView; status: BridgeStatus | null; setStatus: (status: BridgeStatus | null) => void }) {
  const total = view.bridges.length;
  const working = view.counts.working;
  const tiles: BridgeStatus[] = ["needs-key", "broken", "to-build", "off", "unknown"];
  const host = HOST[view.host.state];
  return (
    <section aria-label="At a glance" className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="flex items-center gap-5 rounded-lg border border-[rgb(23_42_58/0.1)] bg-white p-5">
        <HealthRing counts={view.counts} total={total} />
        <div className="min-w-0">
          <p className="text-[12.5px] font-bold tracking-[0.1em] text-[#5c6e7e] uppercase">Connections working</p>
          <p className="font-display mt-1 text-[38px] leading-none font-semibold text-[#172a3a]">
            {working}
            <span className="text-[20px] text-[#5c6e7e]"> of {total}</span>
          </p>
          <p className="mt-2.5 flex items-start gap-2 text-[13px] font-semibold" style={{ color: host.ink }} title={view.host.text}>
            <span className="relative mt-1 inline-flex size-2.5 shrink-0">
              {view.host.state === "answered" ? (
                <span className="absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden" style={{ background: host.dot, animationDuration: "2.4s" }} />
              ) : null}
              <span className="relative inline-block size-2.5 rounded-full" style={{ background: host.dot }} />
            </span>
            {host.label}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => {
          const style = STATUS_STYLE[tile];
          const n = view.counts[tile];
          return (
            <button
              key={tile}
              type="button"
              aria-pressed={status === tile}
              onClick={() => setStatus(status === tile ? null : tile)}
              title={STATUS_MEANING[tile]}
              className="flex min-h-[100px] flex-col justify-between rounded-md border px-4 py-3 text-left transition-shadow hover:shadow-md aria-pressed:ring-2 aria-pressed:ring-[#172a3a]"
              style={{ background: n > 0 ? style.tint : "#ffffff", borderColor: n > 0 ? `${style.stroke}40` : "rgb(23 42 58 / 0.1)" }}
            >
              <span className="flex items-center justify-between" style={{ color: n > 0 ? style.ink : "#9aa8b5" }}>
                <span className="text-[30px] leading-none font-bold tabular-nums">{n}</span>
                <Icon name={style.icon} className="size-[18px]" strokeWidth={2.2} />
              </span>
              <span className="text-[13.5px] font-bold" style={{ color: n > 0 ? style.ink : "#5c6e7e" }}>
                {STATUS_WORDS[tile]}
              </span>
            </button>
          );
        })}
        <a
          href="#map-lists"
          className="flex min-h-[100px] flex-col justify-between rounded-md border px-4 py-3 transition-shadow hover:shadow-md"
          style={{
            background: view.rotationsDue > 0 ? STATUS_STYLE["needs-key"].tint : "#ffffff",
            borderColor: view.rotationsDue > 0 ? `${STATUS_STYLE["needs-key"].stroke}40` : "rgb(23 42 58 / 0.1)",
          }}
        >
          <span className="flex items-center justify-between" style={{ color: view.rotationsDue > 0 ? STATUS_STYLE["needs-key"].ink : "#9aa8b5" }}>
            <span className="text-[30px] leading-none font-bold tabular-nums">{view.rotationsDue}</span>
            <Icon name="clock" className="size-[18px]" strokeWidth={2.2} />
          </span>
          <span className="text-[13.5px] font-bold" style={{ color: view.rotationsDue > 0 ? STATUS_STYLE["needs-key"].ink : "#5c6e7e" }}>
            Keys to rotate soon
          </span>
        </a>
      </div>
    </section>
  );
}

/** A ring of every connection, one arc per status, drawn in once. */
function HealthRing({ counts, total }: { counts: MapView["counts"]; total: number }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const gap = total > 1 ? 1.4 : 0;
  // Each arc starts where the ones before it end.
  const arcs = LEGEND_ORDER.filter((status) => counts[status] > 0).map((status, index, shown) => {
    const before = shown.slice(0, index).reduce((sum, earlier) => sum + (counts[earlier] / total) * circumference, 0);
    return { status, index, start: before, length: (counts[status] / total) * circumference };
  });
  return (
    <svg viewBox="0 0 100 100" className="size-[108px] shrink-0 -rotate-90" role="img" aria-label={`${counts.working} of ${total} connections working`}>
      <style>{`
        @keyframes hdm-ring { from { stroke-dasharray: 0 ${circumference.toFixed(2)}; } }
        .hdm-ring { animation: hdm-ring var(--duration-slower) var(--ease-out) both; }
        @media (prefers-reduced-motion: reduce) { .hdm-ring { animation: none; } }
      `}</style>
      <circle cx="50" cy="50" r={radius} fill="none" stroke="#eef1f5" strokeWidth="11" />
      {arcs.map((arc) => (
        <circle
          key={arc.status}
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={STATUS_STYLE[arc.status].stroke}
          strokeWidth="11"
          strokeDasharray={`${Math.max(0, arc.length - gap).toFixed(2)} ${circumference.toFixed(2)}`}
          strokeDashoffset={(-arc.start).toFixed(2)}
          className="hdm-ring"
          style={{ animationDelay: `${arc.index * 90}ms` }}
        />
      ))}
    </svg>
  );
}

// -----------------------------------------------------------------------------
// The story bar and the legend
// -----------------------------------------------------------------------------

function StoryBar({
  title,
  step,
  steps,
  playing,
  onStep,
  onToggle,
  onClose,
  onOpen,
}: {
  title: string;
  step: number;
  steps: { text: string; status: BridgeStatus; statusText: string }[];
  playing: boolean;
  onStep: (step: number) => void;
  onToggle: () => void;
  onClose: () => void;
  onOpen: () => void;
}) {
  const current = steps[step]!;
  const ok = current.status === "working";
  return (
    <div className="flex flex-wrap items-start gap-4 border-b border-[rgb(23_42_58/0.08)] bg-[#172a3a] px-4 py-4 text-white sm:px-5">
      <style>{`
        @keyframes hdm-caption { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .hdm-caption { animation: hdm-caption var(--duration-slow) var(--ease-out) both; }
        @media (prefers-reduced-motion: reduce) { .hdm-caption { animation: none; } }
      `}</style>
      <div className="min-w-0 flex-1 basis-[420px]" role="status" aria-live="polite">
        <p className="text-[12px] font-bold tracking-[0.12em] text-white/60 uppercase">
          {title} · step {step + 1} of {steps.length}
        </p>
        <p key={step} className="hdm-caption mt-1 text-[17px] leading-snug font-semibold">
          {current.text}
        </p>
        <p className="mt-1.5 flex items-start gap-1.5 text-[13.5px]" style={{ color: ok ? "#86efac" : "#fcd34d" }}>
          <Icon name={ok ? "check" : STATUS_STYLE[current.status].icon} className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
          <span>{ok ? "This step works today." : `This step can't happen yet. ${current.statusText}`}</span>
        </p>
        <div className="mt-2 flex items-center">
          {steps.map((entry, index) => (
            <button key={index} type="button" onClick={() => onStep(index)} aria-label={`Step ${index + 1}`} aria-current={index === step} className="grid h-8 w-7 place-items-center">
              <span
                className="block h-1.5 rounded-full transition-all duration-base"
                style={{
                  width: index === step ? 22 : 8,
                  background: index === step ? "#ffffff" : STATUS_STYLE[entry.status].stroke,
                  opacity: index === step ? 1 : 0.85,
                }}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onStep(Math.max(0, step - 1))}
          disabled={step === 0}
          className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40"
          aria-label="Previous step"
        >
          <Icon name="prev" className="size-4" strokeWidth={2.4} />
        </button>
        <button type="button" onClick={onToggle} className="grid size-11 place-items-center rounded-full bg-white text-[#172a3a] hover:bg-white/90" aria-label={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} className="size-4" strokeWidth={2.4} />
        </button>
        <button
          type="button"
          onClick={() => onStep(Math.min(steps.length - 1, step + 1))}
          disabled={step === steps.length - 1}
          className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40"
          aria-label="Next step"
        >
          <Icon name="next" className="size-4" strokeWidth={2.4} />
        </button>
        <button type="button" onClick={onOpen} className="ml-1 min-h-11 rounded-full bg-white/10 px-4 text-[13.5px] font-bold hover:bg-white/20">
          Details
        </button>
        <button type="button" onClick={onClose} className="grid size-11 place-items-center rounded-full hover:bg-white/10" aria-label="End the story">
          <Icon name="close" className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[rgb(23_42_58/0.08)] px-4 py-3 text-[13px] sm:px-5">
      {LEGEND_ORDER.map((status) => (
        <span key={status} className="flex items-center gap-2" title={STATUS_MEANING[status]}>
          <svg width="30" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="22" y2="5" stroke={STATUS_STYLE[status].stroke} strokeWidth={2.6} strokeDasharray={STATUS_STYLE[status].dash} strokeLinecap="round" />
            <path d="M 21 1.5 L 28 5 L 21 8.5 z" fill={STATUS_STYLE[status].stroke} />
          </svg>
          <span className="font-semibold text-[#172a3a]">{STATUS_WORDS[status]}</span>
        </span>
      ))}
      <span className="basis-full text-[#5c6e7e] xl:ml-auto xl:basis-auto">
        Arrows show which way information travels; a drifting dot means connected. Tap anything to see its keys.
      </span>
    </div>
  );
}
