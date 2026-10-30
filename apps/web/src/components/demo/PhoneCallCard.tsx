"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WebCallSession } from "retell-client-js-sdk";

import { getFirstName } from "@/lib/demo/first-name";

/**
 * The voice card on the owner's demo page (lib/demo/v2): one way to talk to
 * Aya, "Call Aya", and the call itself drawn as an iPhone call screen with
 * the clinic's Aya as the contact (owner, 30 October 2026: "just add
 * something like Call Aya and in fact it's an audio conversation ... a little
 * iphone feeling with Aya from their clinic. just one option").
 *
 * It is the browser call VoiceCard makes (components/agent-panel/VoiceCard.tsx,
 * "Talk here"): the Retell browser SDK, loaded on the click, pointed at this
 * demo's own route, which builds the call and holds the key. No phone number
 * and no form: the microphone prompt is the only step. A first name given
 * earlier on this visit still reaches the call, so Aya can greet by it.
 *
 * Mute and the red button work; the other round buttons are the phone's
 * furniture and do nothing: speaker drawn lit, the rest dimmed so they do not
 * invite a tap.
 */

type CallState = "idle" | "connecting" | "live" | "ended" | "error";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** The browser call's one request with the visitor's first name added; anything that is not a JSON object goes as it was. */
function withFirstName(init: RequestInit | undefined, firstName: string): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  try {
    const body: unknown = JSON.parse(init.body);
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return { ...init, body: JSON.stringify({ ...body, firstName }) };
    }
  } catch {
    // Not JSON: leave it.
  }
  return init;
}

const ICON = {
  phone: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
    </svg>
  ),
  mute: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.5 2.5M12 18v3M3 3l18 18" />
    </svg>
  ),
  keypad: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[5, 12, 19].flatMap((x) => [4, 10, 16].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" />))}
      <circle cx="12" cy="21.5" r="2" />
    </svg>
  ),
  speaker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  ),
  add: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="2" y="6" width="14" height="12" rx="2.5" />
      <path d="M17 10.5 22 7v10l-5-3.5z" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="10" r="3.2" />
      <path d="M6.2 18.4a7 7 0 0 1 11.6 0" />
    </svg>
  ),
  end: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 9c-2.2 0-4.3.4-6.2 1.1a1 1 0 0 0-.6.9v2.8a1 1 0 0 1-.8 1l-2.2.4a1 1 0 0 1-1.1-.6A3.4 3.4 0 0 1 1 13c.6-3 5.2-6 11-6s10.4 3 11 6c.1.6 0 1.1-.1 1.6a1 1 0 0 1-1.1.6l-2.2-.4a1 1 0 0 1-.8-1V11a1 1 0 0 0-.6-.9A17 17 0 0 0 12 9Z" />
    </svg>
  ),
};

/** One of the call screen's round buttons, its word under it. */
function RoundKey({
  label,
  icon,
  onClick,
  lit = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  lit?: boolean;
}) {
  const live = Boolean(onClick);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!live}
      aria-pressed={live ? lit : undefined}
      tabIndex={live ? 0 : -1}
      className={`flex flex-col items-center gap-1.5 ${live ? "cursor-pointer" : "cursor-default"} ${live || lit ? "" : "opacity-40"}`}
    >
      <span
        className={`grid size-[64px] place-items-center rounded-full transition-colors [&_svg]:size-[26px] ${
          lit ? "bg-white text-black" : "bg-white/[0.16] text-white backdrop-blur-sm"
        } ${live && !lit ? "hover:bg-white/25" : ""}`}
      >
        {icon}
      </span>
      <span className="text-[12.5px] font-medium text-white/90">{label}</span>
    </button>
  );
}

export function PhoneCallCard({ clinic, callRoute, locked = false }: { clinic: string; callRoute: string; locked?: boolean }) {
  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const sessionRef = useRef<WebCallSession | null>(null);

  // The call timer, only while live.
  useEffect(() => {
    if (state !== "live") return;
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [state]);

  // Leaving the page ends the call rather than leaving the microphone open.
  useEffect(() => () => void sessionRef.current?.end().catch(() => {}), []);

  const startCall = useCallback(async () => {
    if (locked || state === "connecting" || state === "live") return;
    setError(null);
    setElapsed(0);
    setMuted(false);
    setState("connecting");
    try {
      const { RetellClient } = await import("retell-client-js-sdk");
      const client = new RetellClient({
        // Never sent to Retell: our route sets the real Authorization header.
        key: "proxied",
        fetch: (url, init) => {
          const path = new URL(String(url)).pathname;
          const given = getFirstName();
          return fetch(`${callRoute}${path}`, given && path.endsWith("/create-web-call") ? withFirstName(init, given) : init);
        },
      });
      const session = client.createWebCall({
        // Ignored by our route, which picks the agent server-side.
        agent_id: "server-chosen",
        hooks: {
          onStatus: (status) => {
            if (status === "live") setState("live");
            if (status === "ended") setState((prev) => (prev === "error" ? prev : "ended"));
          },
          onError: (failure) => {
            const message = failure.message || "";
            setError(
              /permission|notallowed|denied/i.test(message)
                ? "Your browser blocked the microphone. Allow it for this page and try again."
                : /expired/i.test(message)
                  ? "This demo has expired."
                  : /limit|too many|a few calls/i.test(message)
                    ? message
                    : "The call couldn't connect. Try again in a moment.",
            );
            setState("error");
          },
        },
      });
      sessionRef.current = session;
      await session.ready.catch(() => {});
    } catch {
      setError("The call couldn't start in this browser. Try Chrome, Safari or Edge.");
      setState("error");
    }
  }, [callRoute, locked, state]);

  const endCall = useCallback(async () => {
    await sessionRef.current?.end().catch(() => {});
    sessionRef.current = null;
    setState("ended");
  }, []);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (muted) session.unmute();
    else session.mute();
    setMuted(!muted);
  }, [muted]);

  const onCall = state === "connecting" || state === "live";

  if (!onCall) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg bg-[#f2f1ef] px-4 py-10 text-center">
        <button
          type="button"
          onClick={startCall}
          disabled={locked}
          aria-label={`Call Aya at ${clinic}`}
          className="grid size-[88px] place-items-center rounded-full bg-white text-black shadow-md transition-transform hover:scale-[1.04] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-[34px]"
        >
          {ICON.phone}
        </button>
        <span className="text-[19px] font-medium text-[#6b6763]">Call Aya</span>
        <p className="max-w-[300px] text-[13px] leading-snug text-[#8a8580]" aria-live="polite">
          {locked
            ? "This demo has expired."
            : error
              ? error
              : state === "ended"
                ? `Call ended · ${formatElapsed(elapsed)}`
                : "Uses your microphone. Nothing is recorded."}
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-1 flex-col items-center overflow-hidden rounded-lg px-5 pt-9 pb-4 text-white"
      style={{ background: "radial-gradient(120% 80% at 50% 0%, #5b5048 0%, #3d3530 55%, #2a2421 100%)" }}
      role="region"
      aria-label={`Call with Aya at ${clinic}`}
    >
      <div className="text-center text-[27px] leading-tight font-normal tracking-[-0.01em] [text-wrap:balance]">Aya · {clinic}</div>
      <div className="mt-1 text-[15px] text-white/70 tabular-nums" aria-live="polite">
        {state === "live" ? formatElapsed(elapsed) : "calling…"}
      </div>

      <div className="mt-auto grid grid-cols-3 gap-x-7 gap-y-5 pt-10">
        <RoundKey label="mute" icon={ICON.mute} onClick={toggleMute} lit={muted} />
        <RoundKey label="keypad" icon={ICON.keypad} />
        {/* Lit, as on the phone: her voice does come out of the speakers. */}
        <RoundKey label="speaker" icon={ICON.speaker} lit />
        <RoundKey label="add call" icon={ICON.add} />
        <RoundKey label="FaceTime" icon={ICON.video} />
        <RoundKey label="contacts" icon={ICON.contacts} />
      </div>

      <button
        type="button"
        onClick={endCall}
        aria-label="End call"
        className="mt-8 grid size-[72px] place-items-center rounded-full bg-[#eb5545] text-white transition-colors hover:bg-[#d94a3b] [&_svg]:size-[30px]"
      >
        {ICON.end}
      </button>
      <span className="mt-4 h-[5px] w-[120px] rounded-full bg-white/80" aria-hidden />
    </div>
  );
}
