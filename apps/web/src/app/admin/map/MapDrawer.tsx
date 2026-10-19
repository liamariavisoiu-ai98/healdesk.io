"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { nodeOfTool, type Layout } from "@/lib/admin/map-layout";
import {
  GROUPS,
  STATUS_WORDS,
  THEMES,
  type BridgeStatus,
  type BridgeView,
  type KeyView,
  type MapView,
  type ToolDef,
} from "@/lib/admin/system-map";

import { Icon, type AnyIcon } from "./icons";
import { BAND_ACCENT, type Selection } from "./MapStage";
import { KEY_STATE, LEGEND_ORDER, ROTATION_STATE, STATUS_STYLE } from "./map-ui";

export type RecordRotation = (keyId: string) => Promise<{ ok: true; on: string } | { ok: false; message: string }>;

/**
 * What opens beside the map when something on it is tapped: a category, a
 * hub, a tool, a line or one bridge. Every bridge is shown as its own small
 * line, from one thing to another with the key it rides on, which is the
 * per-key picture the big map folds into one line per pair.
 *
 * A side panel rather than a page below the map, so the picture stays in
 * view while its parts are read; on a phone it covers the screen and closes
 * with the same button or Escape.
 */
export function MapDrawer({
  selection,
  view,
  layout,
  onClose,
  onSelect,
  recordRotation,
}: {
  selection: Selection | null;
  view: MapView;
  layout: Layout;
  onClose: () => void;
  onSelect: (selection: Selection) => void;
  recordRotation: RecordRotation;
}) {
  const panel = useRef<HTMLElement | null>(null);
  const open = selection !== null;

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selection, onClose]);

  const tools = new Map(view.tools.map((tool) => [tool.id, tool]));
  const keys = new Map(view.keys.map((key) => [key.id, key]));
  const content = selection ? describe(selection, view, layout, tools) : null;

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Details"
      aria-hidden={!open}
      inert={!open}
      className="fixed top-0 right-0 z-[70] flex h-dvh w-full flex-col border-l border-[rgb(23_42_58/0.1)] bg-white shadow-lg outline-none sm:w-[480px]"
      style={{ transform: open ? "translateX(0)" : "translateX(104%)", transition: "transform var(--duration-slow) var(--ease-out)" }}
    >
      {content ? (
        <>
          <header className="flex items-start gap-3 border-b border-[rgb(23_42_58/0.08)] px-5 py-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-sm" style={{ background: content.accent.tint, color: content.accent.ink }}>
              <Icon name={content.icon} className="size-5" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-bold tracking-[0.12em] uppercase" style={{ color: content.accent.ink }}>
                {content.kicker}
              </p>
              <h2 className="text-[21px] leading-tight font-bold text-[#172a3a]">{content.title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid size-11 shrink-0 place-items-center rounded-full text-[#5c6e7e] hover:bg-[#f1f3f6] hover:text-[#172a3a]"
              aria-label="Close details"
            >
              <Icon name="close" className="size-5" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-5 pt-4 pb-10">
            {content.blurb ? <p className="text-[15px] text-[#3c4f60]">{content.blurb}</p> : null}
            <StatusTally bridges={content.bridges.map((id) => view.bridges.find((bridge) => bridge.id === id)!)} />
            {content.tools.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {content.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => onSelect({ kind: "tool", id: tool.id })}
                    className="flex min-h-11 items-center gap-2 rounded-full border border-[rgb(23_42_58/0.12)] bg-white px-3 text-[13.5px] font-semibold hover:border-[rgb(23_42_58/0.3)]"
                  >
                    <Icon name={tool.icon} className="size-4 text-[#5c6e7e]" />
                    {tool.name}
                  </button>
                ))}
              </div>
            ) : null}
            <h3 className="mt-6 text-[11.5px] font-bold tracking-[0.12em] text-[#5c6e7e] uppercase">
              {content.bridges.length === 1 ? "The connection" : `Its ${content.bridges.length} connections`}
            </h3>
            <ul className="mt-2 grid gap-2.5">
              {content.bridges.map((id) => (
                <li key={id}>
                  <BridgeCard
                    bridge={view.bridges.find((bridge) => bridge.id === id)!}
                    tools={tools}
                    keys={keys}
                    open={content.bridges.length === 1}
                    recordRotation={recordRotation}
                  />
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </aside>
  );
}

type Described = {
  kicker: string;
  title: string;
  blurb: string | null;
  icon: AnyIcon;
  accent: { ink: string; tint: string };
  tools: ToolDef[];
  bridges: string[];
};

const NEUTRAL = { ink: "#172a3a", tint: "#eef1f5" };

function describe(selection: Selection, view: MapView, layout: Layout, tools: Map<string, ToolDef>): Described {
  const touching = (test: (bridge: BridgeView) => boolean) => view.bridges.filter(test).map((bridge) => bridge.id);
  switch (selection.kind) {
    case "hub": {
      const tool = tools.get(selection.id)!;
      const patient = selection.id === "app";
      return {
        kicker: patient ? "Our app · patient side" : "Our app · shop side",
        title: tool.name,
        blurb: patient
          ? "app.healdesk.io, on our AWS account. It answers every patient, keeps bookings and conversations, and holds patient data only under business associate agreements."
          : "healdesk.io, on Vercel. The marketing site, the demos, checkout and this console. It never holds patient data and has no database.",
        icon: tool.icon,
        accent: BAND_ACCENT[patient ? "patient" : "shop"],
        tools: [],
        bridges: touching((bridge) => bridge.from === selection.id || bridge.to === selection.id),
      };
    }
    case "group": {
      const group = GROUPS.find((candidate) => candidate.id === selection.id)!;
      return {
        kicker: `Category · ${group.band === "patient" ? "patient side" : group.band === "shop" ? "shop side" : "shared"}`,
        title: group.name,
        blurb: group.blurb,
        icon: group.icon,
        accent: BAND_ACCENT[group.band],
        tools: view.tools.filter((tool) => tool.category === group.id),
        bridges: touching((bridge) => nodeOfTool(bridge.from) === group.id || nodeOfTool(bridge.to) === group.id),
      };
    }
    case "tool": {
      const tool = tools.get(selection.id)!;
      const group = GROUPS.find((candidate) => candidate.id === tool.category);
      return {
        kicker: group ? group.name : "Tool",
        title: tool.name,
        blurb: tool.role,
        icon: tool.icon,
        accent: group ? BAND_ACCENT[group.band] : NEUTRAL,
        tools: [],
        bridges: touching((bridge) => bridge.from === tool.id || bridge.to === tool.id),
      };
    }
    case "bundle": {
      const bundle = layout.bundles.find((candidate) => candidate.id === selection.id)!;
      const name = (node: string) => tools.get(node)?.name ?? GROUPS.find((group) => group.id === node)?.name ?? node;
      return {
        kicker: "Line",
        title: `${name(bundle.a)} and ${name(bundle.b)}`,
        blurb: null,
        icon: "link",
        accent: NEUTRAL,
        tools: [],
        bridges: bundle.bridges,
      };
    }
    case "bridge": {
      const bridge = view.bridges.find((candidate) => candidate.id === selection.id)!;
      const theme = THEMES.find((candidate) => candidate.id === bridge.theme)!;
      return {
        kicker: `Connection ${bridge.n} · ${theme.name}`,
        title: bridge.title,
        blurb: null,
        icon: "key",
        accent: NEUTRAL,
        tools: [],
        bridges: [bridge.id],
      };
    }
  }
}

function StatusTally({ bridges }: { bridges: BridgeView[] }) {
  const counts = LEGEND_ORDER.map((status) => ({ status, n: bridges.filter((bridge) => bridge.status === status).length })).filter((entry) => entry.n > 0);
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {counts.map(({ status, n }) => (
        <StatusPill key={status} status={status} prefix={`${n}`} />
      ))}
    </div>
  );
}

export function StatusPill({ status, prefix }: { status: BridgeStatus; prefix?: string }) {
  const style = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold whitespace-nowrap" style={{ background: style.tint, color: style.ink }}>
      <Icon name={style.icon} className="size-3.5" strokeWidth={2.4} />
      {prefix ? `${prefix} ${STATUS_WORDS[status].toLowerCase()}` : STATUS_WORDS[status]}
    </span>
  );
}

// -----------------------------------------------------------------------------
// One bridge
// -----------------------------------------------------------------------------

export function BridgeCard({
  bridge,
  tools,
  keys,
  open: openAtFirst,
  recordRotation,
}: {
  bridge: BridgeView;
  tools: Map<string, ToolDef>;
  keys: Map<string, KeyView>;
  open: boolean;
  recordRotation: RecordRotation;
}) {
  const [open, setOpen] = useState(openAtFirst);
  const style = STATUS_STYLE[bridge.status];
  const from = tools.get(bridge.from)!;
  const to = tools.get(bridge.to)!;
  return (
    <article className="overflow-hidden rounded-md border bg-white" style={{ borderColor: open ? `${style.stroke}66` : "rgb(23 42 58 / 0.1)" }}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[#fafbfc]">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full" style={{ background: style.tint, color: style.ink }}>
          <Icon name={style.icon} className="size-3.5" strokeWidth={2.4} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-snug font-bold text-[#172a3a]">{bridge.title}</span>
          <span className="mt-0.5 block text-[12.5px] text-[#5c6e7e]">
            {from.name} {bridge.both ? "⇄" : "→"} {to.name} · {STATUS_WORDS[bridge.status]}
            {bridge.proven ? " · tested live" : ""}
          </span>
        </span>
        <Icon name="next" className={`mt-1 size-4 shrink-0 text-[#5c6e7e] transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? (
        <div className="border-t border-[rgb(23_42_58/0.07)] px-4 pt-3 pb-4">
          <KeyLine bridge={bridge} from={from} to={to} keys={bridge.keys.map((id) => keys.get(id)!)} />
          <p className="mt-3 text-[14px] text-[#172a3a]">{bridge.statusText}</p>
          {bridge.testMode ? (
            <p className="mt-2 inline-flex rounded-full bg-[#fff2d9] px-2.5 py-1 text-[12.5px] font-bold text-[#7a4b00]">Stripe test mode: no real money yet</p>
          ) : null}
          <dl className="mt-3 grid gap-3">
            <div>
              <dt className="text-[11px] font-bold tracking-[0.12em] text-[#5c6e7e] uppercase">What travels</dt>
              <dd className="mt-0.5 text-[14px]">{bridge.carries}</dd>
            </div>
            <div className="rounded-sm bg-[#f6f8fa] px-3 py-2.5">
              <dt className="text-[11px] font-bold tracking-[0.12em] text-[#5c6e7e] uppercase">For example</dt>
              <dd className="mt-0.5 text-[14px]">{bridge.example}</dd>
            </div>
            {bridge.buildNote ? (
              <div>
                <dt className="text-[11px] font-bold tracking-[0.12em] text-[#5c6e7e] uppercase">{bridge.build === "built" ? "Worth knowing" : "Still to do"}</dt>
                <dd className="mt-0.5 text-[14px]">{bridge.buildNote}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-[11px] font-bold tracking-[0.12em] text-[#5c6e7e] uppercase">{bridge.phi ? "Patient data" : "No patient data"}</dt>
              <dd className="mt-0.5 text-[14px]">
                {bridge.phi
                  ? (bridge.phiNote ?? "Carries what a patient said or did, so it runs only under business associate agreements.")
                  : "Nothing about a patient travels here."}
              </dd>
            </div>
          </dl>
          {bridge.keyless ? <p className="mt-3 text-[14px] text-[#3c4f60]">{bridge.keyless}</p> : null}
          {bridge.keys.length > 0 ? (
            <ul className="mt-3 grid gap-2">
              {bridge.keys.map((id) => (
                <KeyRow key={id} keyView={keys.get(id)!} recordRotation={recordRotation} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * One bridge as a small picture: where it starts, where it ends, the way the
 * information goes, and the keys it rides on. The dot moves only when the
 * bridge is connected.
 */
function KeyLine({ bridge, from, to, keys }: { bridge: BridgeView; from: ToolDef; to: ToolDef; keys: KeyView[] }) {
  const style = STATUS_STYLE[bridge.status];
  const flowing = bridge.status === "working";
  return (
    <div className="rounded-sm border border-[rgb(23_42_58/0.08)] bg-[#fbfcfd] p-3">
      <div className="flex items-center gap-2">
        <End tool={from} />
        <div className="relative h-6 flex-1">
          <style>{`
            @keyframes hdm-slide { from { left: 0%; } to { left: 100%; } }
            @media (prefers-reduced-motion: reduce) { .hdm-slide { animation: none !important; display: none; } }
          `}</style>
          <div className="absolute top-1/2 right-1 left-1 -translate-y-1/2" style={{ borderTop: `2.5px ${style.dash ? "dashed" : "solid"} ${style.stroke}` }} />
          <Icon name="next" className="absolute top-1/2 -right-1 size-4 -translate-y-1/2" strokeWidth={3} />
          {bridge.both ? <Icon name="prev" className="absolute top-1/2 -left-1 size-4 -translate-y-1/2" strokeWidth={3} /> : null}
          {flowing ? (
            <span
              className="hdm-slide absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white"
              style={{ borderColor: style.stroke, animation: "hdm-slide 2.6s linear infinite" }}
            />
          ) : null}
          <span className="sr-only">
            {from.name} {bridge.both ? "and" : "to"} {to.name}
          </span>
        </div>
        <End tool={to} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {keys.length === 0 ? (
          <span className="text-[12.5px] font-semibold text-[#5c6e7e]">No key of ours</span>
        ) : (
          keys.map((key) => {
            const state = KEY_STATE[key.state];
            return (
              <span key={key.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-bold" style={{ background: state.tint, color: state.ink }} title={`${key.label}: ${state.word}`}>
                <Icon name="key" className="size-3.5" strokeWidth={2.2} />
                {key.env ? <span className="font-mono text-[11.5px]">{key.env}</span> : <span>{key.label}</span>}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

function End({ tool }: { tool: ToolDef }) {
  return (
    <span className="flex max-w-[42%] min-w-0 items-center gap-1.5 rounded-sm bg-white px-2 py-1.5 text-[12.5px] font-bold text-[#172a3a] ring-1 ring-[rgb(23_42_58/0.1)]">
      <Icon name={tool.icon} className="size-4 shrink-0 text-[#5c6e7e]" />
      <span className="truncate">{tool.name}</span>
    </span>
  );
}

export function KeyRow({ keyView, recordRotation }: { keyView: KeyView; recordRotation: RecordRotation }) {
  const state = KEY_STATE[keyView.state];
  const rotation = ROTATION_STATE[keyView.rotation.state];
  return (
    <li className="rounded-sm border border-[rgb(23_42_58/0.1)] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="key" className="size-4 text-[#5c6e7e]" />
        <span className="text-[14px] font-bold">{keyView.label}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <span className="rounded-full px-2 py-0.5 text-[12px] font-bold" style={{ background: state.tint, color: state.ink }}>
          {state.word}
        </span>
        {rotation ? (
          <span className="rounded-full px-2 py-0.5 text-[12px] font-bold" style={{ background: rotation.tint, color: rotation.ink }}>
            {rotation.word}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12.5px] break-words text-[#5c6e7e]">
        {keyView.env ? <code className="font-mono text-[#172a3a]">{keyView.env}</code> : null}
        {keyView.env ? " · " : ""}
        {keyView.homeLabel}
      </p>
      <p className="mt-1 text-[13.5px]">{keyView.stateText}</p>
      {keyView.rotation.state !== "public" ? <p className="mt-1 text-[13.5px]">{keyView.rotation.text}</p> : null}
      {keyView.rotation.how ? (
        <details className="mt-1 text-[13.5px]">
          <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-[#5c6e7e] hover:text-[#172a3a]">How to rotate it, and what happens meanwhile</summary>
          <p>{keyView.rotation.how}</p>
          {keyView.rotation.impact ? <p className="mt-1 text-[#5c6e7e]">{keyView.rotation.impact}</p> : null}
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
        className="min-h-11 rounded-full border border-[rgb(23_42_58/0.15)] px-4 text-[13.5px] font-bold hover:border-[rgb(23_42_58/0.35)] disabled:opacity-50"
      >
        {pending ? "Recording…" : "I rotated it today"}
      </button>
      {message ? (
        <span className="text-[13px] font-semibold" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
