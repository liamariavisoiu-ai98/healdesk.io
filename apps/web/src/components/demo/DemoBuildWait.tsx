"use client";

import { useEffect, useRef, useState } from "react";

import { type BuildEstimate, type BuildStage, type BuildStep, estimateBuild, secondsLeft } from "@/lib/demo/build-progress";
import { BUILD_BUDGET_MS } from "@/lib/demo/budget";
import { site } from "@/lib/site";

/**
 * The demo's own waiting screen while it is built (owner, 29 October 2026:
 * "the visual while waiting should look fancy, healdesk logo, prospect logo,
 * and show a little animation, pleasing to watch with a little countdown of
 * seconds left").
 *
 * The clinic's logo and healdesk's, joined by a line with light running from
 * one to the other (the site being read), above a ring that empties as the
 * build's minute runs down, with the seconds in its middle, and the step under
 * way below. The clinic's logo reaches the row a few seconds in, as soon as
 * its homepage has been read (lib/demo/build.ts); until then its initial
 * stands in, in its colour once that is known.
 *
 * The server says the stage and how long the build has run when it rendered;
 * the browser carries that forward on its own clock between the page's
 * refreshes, like `BuildProgress`. The seconds only fall, and at zero the ring
 * turns slowly and says it is nearly there: a slow site gets a few more
 * seconds, never a countdown below zero. Motion follows the visitor's
 * reduced-motion setting (globals.css, `.dw-*`).
 */

const STEPS: readonly BuildStep[] = ["read", "learn", "check"];

function stepLabel(step: BuildStep, host: string): string {
  if (step === "read") return `Reading ${host} and your Google listing`;
  if (step === "learn") return "Learning your treatments, prices and hours";
  return `Testing ${site.agent}’s answers before you see them`;
}

function laterStep(a: BuildStep, b: BuildStep): BuildStep {
  return STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b;
}

const RING = 84;
const CIRCUMFERENCE = 2 * Math.PI * RING;

function Tile({ children, label, caption }: { children: React.ReactNode; label: string; caption: React.ReactNode }) {
  return (
    <div className="dw-logo flex w-[88px] shrink-0 flex-col items-center gap-2 sm:w-24">
      <div className="grid size-[72px] place-items-center overflow-hidden rounded-lg bg-white p-2.5 shadow-md ring-1 ring-black/[0.06] sm:size-20" aria-label={label} role="img">
        {children}
      </div>
      <div className="flex h-4 max-w-full items-center justify-center text-[12.5px] font-semibold text-black/55">{caption}</div>
    </div>
  );
}

export function DemoBuildWait({
  stage,
  elapsedMs,
  host,
  name,
  logoUrl,
}: {
  stage: BuildStage;
  /** How long the build had run when the server answered. */
  elapsedMs: number;
  host: string;
  name: string;
  logoUrl: string | null;
}) {
  const [shown, setShown] = useState<BuildEstimate>(() => estimateBuild(stage, elapsedMs));
  const sawReading = useRef(false);
  const auditingSince = useRef<number | null>(null);

  useEffect(() => {
    if (stage === "building") sawReading.current = true;
    else if (sawReading.current && auditingSince.current === null) auditingSince.current = elapsedMs;
    const received = Date.now();
    const tick = () => {
      const next = estimateBuild(stage, elapsedMs + (Date.now() - received), auditingSince.current);
      setShown((prev) => ({
        percent: Math.max(prev.percent, next.percent),
        step: laterStep(prev.step, next.step),
        leftMs: Math.min(prev.leftMs, next.leftMs),
      }));
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [stage, elapsedMs]);

  const seconds = secondsLeft(shown.leftMs);
  const done = seconds <= 0;
  const emptied = done ? 0.72 : 1 - shown.leftMs / BUILD_BUDGET_MS;
  const initial = name.trim().charAt(0).toUpperCase() || "•";

  return (
    <div className="flex w-full max-w-[460px] flex-col items-center">
      {/* Their site, read into healdesk. */}
      <div className="flex items-start gap-2 sm:gap-3">
        <Tile label={`${name} logo`} caption={<span className="truncate">{name}</span>}>
          {logoUrl ? (
            <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="font-display grid size-full place-items-center rounded-md text-[30px] font-medium" style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}>
              {initial}
            </span>
          )}
        </Tile>
        <div className="dw-beam mt-[35px] w-[88px] sm:mt-[39px] sm:w-[128px]" style={{ ["--beam" as string]: "128px" }} aria-hidden>
          <span className="dw-beam-dot" />
          <span className="dw-beam-dot" />
          <span className="dw-beam-dot" />
        </div>
        <Tile label="healdesk" caption={<img src="/brand/healdesk-logo.webp" alt="" width={66} height={12} className="h-3 w-auto" />}>
          <img src="/brand/healdesk-app-icon-1024.png" alt="" width={64} height={64} className="size-full rounded-md object-contain" />
        </Tile>
      </div>

      {/* The countdown. */}
      <div className="relative mt-10 grid size-[200px] place-items-center">
        <span aria-hidden className="dw-halo" />
        <div className="dw-ring-wrap absolute inset-0" data-done={done ? "" : undefined}>
          <svg viewBox="0 0 200 200" className="size-full -rotate-90" aria-hidden>
            <circle cx="100" cy="100" r={RING} fill="none" stroke="rgb(0 0 0 / 0.08)" strokeWidth="8" />
            <circle
              className="dw-ring"
              cx="100"
              cy="100"
              r={RING}
              fill="none"
              stroke="var(--clinic)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * Math.min(1, Math.max(0, emptied))}
            />
          </svg>
        </div>
        <div
          className="relative flex flex-col items-center"
          role="timer"
          aria-live="off"
          aria-label={done ? "Nearly there" : `${seconds} seconds left`}
        >
          {done ? (
            <span className="font-display text-[26px] leading-tight font-medium">Nearly there</span>
          ) : (
            <>
              <span className="font-display text-[64px] leading-none font-medium tracking-[-0.03em] tabular-nums">{seconds}</span>
              <span className="text-muted mt-1 text-[14px] font-semibold tracking-wide uppercase">{seconds === 1 ? "second" : "seconds"}</span>
            </>
          )}
        </div>
      </div>

      {/* The step under way, and where it sits among the three. */}
      <p key={shown.step} className="dw-step mt-8 text-[17px] font-semibold" aria-live="polite">
        {stepLabel(shown.step, host)}
      </p>
      <div className="mt-3 flex gap-2" aria-hidden>
        {STEPS.map((step, i) => (
          <span
            key={step}
            className="h-1.5 rounded-full transition-[width,background-color] duration-base"
            style={{
              width: i === STEPS.indexOf(shown.step) ? 28 : 8,
              background: i <= STEPS.indexOf(shown.step) ? "var(--clinic)" : "rgb(0 0 0 / 0.12)",
            }}
          />
        ))}
      </div>
      <p className="text-muted mt-6 text-[15px] font-medium">Your demo opens on this page by itself.</p>
    </div>
  );
}
