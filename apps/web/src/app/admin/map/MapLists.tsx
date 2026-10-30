"use client";

import { useState } from "react";

import { THEMES, type BridgeView, type KeyHome, type KeyView, type MapView, type TodoKind, type ToolDef } from "@/lib/admin/system-map";

import { Icon, type AnyIcon } from "./icons";
import { KeyRow, StatusPill, type RecordRotation } from "./MapDrawer";
import type { Selection } from "./MapStage";

/**
 * Everything the picture says, as lists, under three tabs: what is left to
 * do, every key with its rotation, and every connection by what it is for.
 * The lists are also the way in on a phone, where the picture scrolls.
 */

const TODO: Record<TodoKind, { title: string; blurb: string; icon: AnyIcon; tint: string; ink: string }> = {
  fix: { title: "Fix first", blurb: "A live check failed, or two copies of a key disagree.", icon: "alert", tint: "#fde4e4", ink: "#9b1213" },
  "add-key": { title: "Keys to add", blurb: "Built and waiting for its key.", icon: "key", tint: "#fff2d9", ink: "#7a4b00" },
  rotate: { title: "Keys to rotate", blurb: "Due within two weeks, or overdue.", icon: "clock", tint: "#fff2d9", ink: "#7a4b00" },
  build: { title: "Still to build", blurb: "Not built yet, or only half built, whatever colour its line shows now.", icon: "wrench", tint: "#efeafc", ink: "#4b3a8a" },
  check: { title: "Couldn't check", blurb: "Something this page could not reach, or an engine too old to answer it.", icon: "question", tint: "#eef1f5", ink: "#475569" },
  waiting: { title: "Waiting on purpose", blurb: "Nothing to do yet: each waits for something else first.", icon: "pause", tint: "#e3eefb", ink: "#1f4f86" },
};

const TODO_ORDER: readonly TodoKind[] = ["fix", "add-key", "rotate", "build", "check", "waiting"];
const HOME_ORDER: readonly KeyHome[] = ["vercel", "aws", "aws-ci", "github", "computer", "clinic"];

type Tab = "left" | "keys" | "all";

export function MapLists({
  view,
  tools,
  onSelect,
  recordRotation,
}: {
  view: MapView;
  tools: Map<string, ToolDef>;
  onSelect: (selection: Selection) => void;
  recordRotation: RecordRotation;
}) {
  const [tab, setTab] = useState<Tab>("left");
  const actionable = view.todos.filter((todo) => todo.kind !== "waiting").length;
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "left", label: "What's left", count: actionable },
    { id: "keys", label: "Keys & rotation", count: view.keys.length },
    { id: "all", label: "Every connection", count: view.bridges.length },
  ];

  return (
    <section aria-label="Lists" className="rounded-lg border border-[rgb(23_42_58/0.1)] bg-white">
      <div role="tablist" aria-label="Lists" className="flex flex-wrap gap-1 border-b border-[rgb(23_42_58/0.08)] px-3 pt-3">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            id={`map-tab-${entry.id}`}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            aria-controls={`map-panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={`-mb-px flex min-h-11 items-center gap-2 rounded-t-sm border-b-2 px-4 text-sm font-bold transition-colors ${tab === entry.id ? "border-[#172a3a] text-[#172a3a]" : "border-transparent text-[#5c6e7e] hover:text-[#172a3a]"}`}
          >
            {entry.label}
            <span className={`rounded-full px-2 py-0.5 text-xs ${tab === entry.id ? "bg-[#172a3a] text-white" : "bg-[#eef1f5] text-[#475569]"}`}>{entry.count}</span>
          </button>
        ))}
      </div>
      <div id={`map-panel-${tab}`} role="tabpanel" aria-labelledby={`map-tab-${tab}`} className="p-4 sm:p-6">
        {tab === "left" ? <Left view={view} onSelect={onSelect} /> : null}
        {tab === "keys" ? <Keys keys={view.keys} recordRotation={recordRotation} rotationLog={view.rotationLog} /> : null}
        {tab === "all" ? <All bridges={view.bridges} tools={tools} onSelect={onSelect} /> : null}
      </div>
    </section>
  );
}

function Left({ view, onSelect }: { view: MapView; onSelect: (selection: Selection) => void }) {
  const groups = TODO_ORDER.map((kind) => ({ kind, items: view.todos.filter((todo) => todo.kind === kind) })).filter((group) => group.items.length > 0);
  if (groups.length === 0) {
    return <p className="text-sm text-[#5c6e7e]">Nothing left: every connection is in place and no key is due.</p>;
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {groups.map((group) => {
        const meta = TODO[group.kind];
        return (
          <div key={group.kind} className="rounded-md border border-[rgb(23_42_58/0.08)] p-4">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-sm" style={{ background: meta.tint, color: meta.ink }}>
                <Icon name={meta.icon} className="size-4" strokeWidth={2.2} />
              </span>
              <div>
                <h3 className="text-sm font-bold">
                  {meta.title} <span className="font-semibold text-[#5c6e7e]">· {group.items.length}</span>
                </h3>
                <p className="text-xs text-[#5c6e7e]">{meta.blurb}</p>
              </div>
            </div>
            <ul className="mt-3 grid gap-1">
              {group.items.map((todo, index) => {
                const bridge = todo.bridge ? view.bridges.find((candidate) => candidate.id === todo.bridge) : undefined;
                return (
                  <li key={`${group.kind}-${index}`}>
                    <button
                      type="button"
                      disabled={!bridge}
                      onClick={() => bridge && onSelect({ kind: "bridge", id: bridge.id })}
                      className="flex min-h-11 w-full items-start gap-2 rounded-sm px-2.5 py-2 text-left text-xs hover:bg-[#f5f7fa] disabled:hover:bg-transparent"
                    >
                      <span className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full" style={{ background: meta.ink }} />
                      <span>{todo.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

type KeyFilter = "all" | "action" | "rotation";

function Keys({ keys, recordRotation, rotationLog }: { keys: KeyView[]; recordRotation: RecordRotation; rotationLog: MapView["rotationLog"] }) {
  const [filter, setFilter] = useState<KeyFilter>("all");
  const shown = keys.filter((key) => {
    if (filter === "action") return key.state === "missing" || key.state === "broken";
    if (filter === "rotation") return key.rotation.state === "overdue" || key.rotation.state === "due-soon" || key.rotation.state === "unrecorded";
    return true;
  });
  const options: { id: KeyFilter; label: string }[] = [
    { id: "all", label: "All keys" },
    { id: "action", label: "Missing or broken" },
    { id: "rotation", label: "Rotation to do or record" },
  ];
  return (
    <div>
      <p className="max-w-[80ch] text-xs text-[#5c6e7e]">
        This page never shows, stores or sends a key&apos;s value: it only checks whether each one is there. Rotation schedules are
        suggestions until you adopt a policy; each counts from the day you press &ldquo;I rotated it today&rdquo;, and a GitHub
        token&apos;s date is its real expiry.
        {rotationLog === "unavailable" ? " The rotation log in the marketing Sheet could not be read, so no dates are shown." : ""}
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
            className="min-h-11 rounded-full border border-[rgb(23_42_58/0.12)] px-4 text-xs font-bold text-[#5c6e7e] hover:text-[#172a3a] aria-pressed:border-[#172a3a] aria-pressed:bg-[#172a3a] aria-pressed:text-white"
          >
            {option.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="mt-5 text-sm text-[#5c6e7e]">None.</p> : null}
      {HOME_ORDER.map((home) => {
        const own = shown.filter((key) => key.home === home);
        if (own.length === 0) return null;
        return (
          <div key={home} className="mt-6">
            <h3 className="text-sm font-bold">
              {own[0]!.homeLabel} <span className="font-semibold text-[#5c6e7e]">· {own.length}</span>
            </h3>
            <ul className="mt-2 grid gap-2 lg:grid-cols-2">
              {own.map((key) => (
                <KeyRow key={key.id} keyView={key} recordRotation={recordRotation} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function All({ bridges, tools, onSelect }: { bridges: BridgeView[]; tools: Map<string, ToolDef>; onSelect: (selection: Selection) => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {THEMES.map((theme) => (
        <div key={theme.id}>
          <h3 className="text-sm font-bold">{theme.name}</h3>
          <p className="text-xs text-[#5c6e7e]">{theme.blurb}</p>
          <ul className="mt-3 grid gap-1">
            {bridges
              .filter((bridge) => bridge.theme === theme.id)
              .map((bridge) => (
                <li key={bridge.id}>
                  <button type="button" onClick={() => onSelect({ kind: "bridge", id: bridge.id })} className="flex min-h-11 w-full flex-col gap-1 rounded-sm px-2.5 py-2 text-left hover:bg-[#f5f7fa]">
                    <span className="text-xs font-semibold">{bridge.title}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-[#5c6e7e]">
                      <StatusPill status={bridge.status} />
                      {tools.get(bridge.from)!.name} {bridge.both ? "⇄" : "→"} {tools.get(bridge.to)!.name}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
