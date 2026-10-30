"use client";

import { useEffect, useRef, useState } from "react";

import { type BuildStage, type BuildStep, estimateBuild } from "@/lib/demo/build-progress";
import { site } from "@/lib/site";

/**
 * The demo's own waiting screen while it is built.
 *
 * It used to count down a minute, and real builds take two or three, so the
 * prospect watched it reach zero and wait (owner, 30 October 2026: "it shows
 * a countdown of 1min but takes 2/3mins ... add some pleasing animation
 * behind, apple like that explain, must look expensive and branded healdesk.
 * they need to understand that we're scanning their site and testing Aya's
 * answers"). Now it promises no seconds: it shows what is happening.
 *
 * The clinic's logo and healdesk's, joined by light running from one to the
 * other, above a glass card playing the step under way: their website being
 * scanned, its treatments, prices and hours lifting off it, then Aya being
 * asked a patient's questions and each answer checked. A slow bar fills
 * towards the end without reaching it, and the line under it says how long
 * a build usually takes.
 *
 * The server says the stage and how long the build has run when it rendered;
 * the browser carries that forward on its own clock between the page's
 * refreshes. Motion follows the visitor's reduced-motion setting (globals.css,
 * `.dw-*`).
 */

const STEPS: readonly BuildStep[] = ["read", "learn", "check"];

function stepLabel(step: BuildStep, host: string): string {
  if (step === "read") return `Scanning ${host} and your Google listing`;
  if (step === "learn") return "Learning your treatments, prices and hours";
  return `Testing ${site.agent}’s answers before you see them`;
}

function laterStep(a: BuildStep, b: BuildStep): BuildStep {
  return STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b;
}

/** Fills towards 96% and never reaches the end: a build's length is not known in advance. */
function barShare(elapsedMs: number, step: BuildStep): number {
  const floor = step === "check" ? 0.55 : step === "learn" ? 0.25 : 0.04;
  const eased = 1 - Math.exp(-elapsedMs / 75_000);
  return Math.min(0.96, Math.max(floor, eased));
}

/** What a scan finds on a clinic's website, lifting off the page. */
const FOUND = ["Treatments", "Prices", "Hours", "Team", "FAQs"] as const;

/** A patient's questions and Aya's checked answers, played in turn. */
const TESTS = [
  { q: "How much is a consultation?", a: "Here’s what we charge, from your price list." },
  { q: "Are you open on Saturday?", a: "Yes, these are our Saturday hours." },
  { q: "Can I book for Thursday?", a: "Let me find you a time on Thursday." },
] as const;

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

/** Their website, being scanned. */
function ScanScene({ host }: { host: string }) {
  return (
    <div className="dw-scene absolute inset-0 flex flex-col" aria-hidden>
      <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-3.5 py-2.5">
        <span className="size-2 rounded-full bg-[#ff5f57]" />
        <span className="size-2 rounded-full bg-[#febc2e]" />
        <span className="size-2 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate rounded-full bg-black/[0.05] px-3 py-0.5 text-[11.5px] font-medium text-black/55">{host}</span>
      </div>
      <div className="relative flex-1 overflow-hidden px-4 py-3.5">
        <div className="space-y-2.5">
          <span className="block h-3 w-1/2 rounded-full bg-black/[0.09]" />
          <span className="block h-2 w-[85%] rounded-full bg-black/[0.06]" />
          <span className="block h-2 w-[70%] rounded-full bg-black/[0.06]" />
          <div className="flex gap-2.5 pt-1.5">
            <span className="block h-12 flex-1 rounded-md bg-black/[0.05]" />
            <span className="block h-12 flex-1 rounded-md bg-black/[0.05]" />
            <span className="block h-12 flex-1 rounded-md bg-black/[0.05]" />
          </div>
          <span className="block h-2 w-[78%] rounded-full bg-black/[0.06]" />
          <span className="block h-2 w-[60%] rounded-full bg-black/[0.06]" />
        </div>
        <span className="dw-scan" />
        <div className="absolute inset-x-0 bottom-3 flex flex-wrap justify-center gap-1.5 px-3">
          {FOUND.map((label, i) => (
            <span key={label} className="dw-chip rounded-full bg-white px-2.5 py-1 text-[11.5px] font-semibold shadow-md ring-1 ring-black/[0.06]" style={{ animationDelay: `${i * 0.7}s` }}>
              <span className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: "var(--clinic)" }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Aya, asked a patient's questions, each answer checked. */
function TestScene() {
  return (
    <div className="dw-scene absolute inset-0 overflow-hidden px-3.5 py-3.5" aria-hidden>
      {TESTS.map((t, i) => (
        <div key={t.q} className="dw-test absolute inset-x-3.5 top-3.5 space-y-2" style={{ animationDelay: `${i * 3}s` }}>
          <div className="ml-auto w-fit max-w-[80%] rounded-lg rounded-br-sm bg-[#0a84ff] px-3 py-1.5 text-[12.5px] font-medium text-white">{t.q}</div>
          <div className="flex items-end gap-1.5">
            <img src="/hero-frames-2/g_20.webp" alt="" className="size-6 shrink-0 rounded-full object-cover" style={{ objectPosition: "50% 30%" }} />
            <div className="w-fit max-w-[78%] rounded-lg rounded-bl-sm bg-black/[0.06] px-3 py-1.5 text-[12.5px] text-black/80">{t.a}</div>
          </div>
          <div className="dw-check ml-8 flex w-fit items-center gap-1 rounded-full bg-[#e8f8ee] px-2 py-0.5 text-[11px] font-semibold text-[#1f8a4c]">
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            Checked against your website
          </div>
        </div>
      ))}
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
  const [shown, setShown] = useState(() => ({ step: estimateBuild(stage, elapsedMs).step, elapsed: elapsedMs }));
  const sawReading = useRef(false);
  const auditingSince = useRef<number | null>(null);

  useEffect(() => {
    if (stage === "building") sawReading.current = true;
    else if (sawReading.current && auditingSince.current === null) auditingSince.current = elapsedMs;
    const received = Date.now();
    const tick = () => {
      const elapsed = elapsedMs + (Date.now() - received);
      const next = estimateBuild(stage, elapsed, auditingSince.current);
      setShown((prev) => ({ step: laterStep(prev.step, next.step), elapsed: Math.max(prev.elapsed, elapsed) }));
    };
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [stage, elapsedMs]);

  const initial = name.trim().charAt(0).toUpperCase() || "•";
  const share = barShare(shown.elapsed, shown.step);
  const testing = shown.step === "check";

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

      {/* What is happening, played on a glass card. */}
      <div className="relative mt-9 w-full max-w-[380px]">
        <span aria-hidden className="dw-halo" />
        <div className="relative h-[232px] overflow-hidden rounded-lg bg-white/80 shadow-lg ring-1 ring-black/[0.06] backdrop-blur-xl">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/70 to-transparent" />
          {testing ? <TestScene key="test" /> : <ScanScene key="scan" host={host} />}
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

      <div className="mt-6 h-1 w-full max-w-[280px] overflow-hidden rounded-full bg-black/[0.08]" role="progressbar" aria-label="Building your demo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span className="dw-bar block h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--clinic)" }} />
      </div>
      <p className="text-muted mt-4 text-[15px] font-medium">Usually about two minutes. Your demo opens on this page by itself.</p>
    </div>
  );
}
