"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Specialty } from "@/lib/specialties";

const PHONE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

const BAR_COUNT = 28;
const LINE_DELAY_MS = 1_600;

/**
 * Scripted playback of an inbound call.
 *
 * Deliberately not live: a real voice demo needs mic permission and a media
 * pipeline, and neither belongs on a marketing page. The scripted version sets
 * the expectation for what the phone agent does; the chat panel next to it is
 * where visitors get to poke at a real model.
 */
export function VoiceDemo({ specialty }: { specialty: Specialty }) {
  const [visibleLines, setVisibleLines] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const totalLines = specialty.voice.length;

  const start = useCallback(() => {
    setVisibleLines(0);
    setSeconds(0);
    setPlaying(true);
  }, []);

  // Restart whenever the specialty changes so the strip selection feels live.
  useEffect(() => {
    start();
  }, [specialty.id, start]);

  // Reveal one line at a time.
  useEffect(() => {
    if (!playing) return;
    if (visibleLines >= totalLines) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(
      () => setVisibleLines((count) => count + 1),
      visibleLines === 0 ? 500 : LINE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [playing, visibleLines, totalLines]);

  // Call timer, running only while the call is "connected".
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(interval);
  }, [playing]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visibleLines]);

  const finished = !playing && visibleLines >= totalLines;
  const timestamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="border-line flex h-[500px] flex-col overflow-hidden rounded-[18px] border bg-white">
      <div className="border-line flex items-center gap-2.5 border-b px-[18px] py-3.5">
        <span className="bg-orange/[0.12] text-red grid size-[30px] shrink-0 place-items-center rounded-[9px] [&_svg]:size-4">
          {PHONE_ICON}
        </span>
        <span className="text-sm font-bold">Phone call</span>
        <span className="text-muted ml-auto text-[12.5px] font-semibold tabular-nums">
          Inbound · {timestamp}
        </span>
      </div>

      {/* Waveform. Decorative — the transcript carries the meaning. */}
      <div className="flex items-center gap-3.5 px-[18px] pt-4 pb-3">
        <div className="flex h-[26px] flex-1 items-center gap-[3px]" aria-hidden>
          {Array.from({ length: BAR_COUNT }, (_, index) => (
            <span
              key={index}
              className={[
                "bg-orange max-w-[4px] flex-1 rounded",
                playing ? "animate-pulse opacity-100" : "opacity-50",
              ].join(" ")}
              style={{
                height: playing ? `${20 + ((index * 37) % 70)}%` : "20%",
                animationDelay: `${(index % 4) * 0.12}s`,
                transition: "height 220ms ease",
              }}
            />
          ))}
        </div>
      </div>

      <div
        ref={transcriptRef}
        className="scroll-subtle flex flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pb-5"
      >
        {specialty.voice.slice(0, visibleLines).map((line, index) => (
          <div
            key={`${specialty.id}-${index}`}
            className="animate-in fade-in slide-in-from-bottom-2 duration-300"
            style={{ animation: "none" }}
          >
            <p
              className={[
                "mb-[3px] text-[11px] font-bold tracking-[0.08em] uppercase",
                line.agent ? "text-red" : "text-muted",
              ].join(" ")}
            >
              {line.agent ? "healdesk" : "Caller"}
            </p>
            <p className="text-[14.5px] leading-[1.45]">{line.text}</p>
          </div>
        ))}
      </div>

      <div className="border-line flex items-center justify-between border-t px-[18px] py-3">
        <span className="text-muted text-[12.5px] font-semibold">
          {finished ? "Booked in 4 turns" : playing ? "Connected" : "Ready"}
        </span>
        <button
          type="button"
          onClick={start}
          className="text-ink hover:text-red text-[13px] font-bold transition-colors"
        >
          {finished ? "Replay call" : "Restart"}
        </button>
      </div>
    </div>
  );
}
