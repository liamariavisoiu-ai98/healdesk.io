"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { WebCallSession } from "retell-client-js-sdk";

import { AyaPortrait, type CallVisualState } from "@/components/agent-panel/AyaPortrait";
import { NameGate } from "@/components/agent-panel/NameGate";
import { CALL_CONSENT } from "@/lib/consent";
import { countryByIso, DIAL_COUNTRIES, formatNational, splitNumber, toInternational } from "@/lib/dial-countries";
import { getFirstName, rememberFirstName, subscribeFirstName } from "@/lib/demo/first-name";
import { site } from "@/lib/site";

/**
 * The voice card, three ways to reach the assistant in AYA's voice: talk to
 * it from the browser, call the demo line from your own phone, or have it
 * ring you.
 *
 * It was the personalised demo's ("Peachy", components/demo/ClinicVoicePanel.tsx
 * on the demo/port branch), where it answers as the clinic. On 9 October 2026
 * the owner asked for the homepage's card to look exactly like it, so both
 * pages draw this one and differ only in what the props say: whose voice it
 * is, which route starts the browser call, whether the demo line needs the
 * caller's number first, and what the call-me request carries.
 *
 * AYA's face sits where a phone icon would, and tells the call as it goes
 * (the owner's M2, AyaPortrait.tsx): the aura quickening while it connects,
 * ripples while she listens, her ring swelling with her voice while she
 * speaks, and the same state in words beside her.
 *
 * ## Talk here
 *
 * The Retell browser SDK is loaded only when the button is pressed (it pulls
 * in WebRTC code nobody needs until then) and is pointed at our own route for
 * its single control request (`fetch` override): the route builds the call
 * and holds the key, so nothing secret or steerable is in this bundle. The
 * microphone prompt happens on that click, as browsers require.
 *
 * Her words are captioned under her face as she says them (owner, 12 October
 * 2026): the call's own data channel sends the conversation so far with each
 * turn (`onUpdate`), and the card shows her last line. They are only shown:
 * held in this component while the call runs and dropped when it ends, never
 * sent or kept anywhere, so "Nothing is recorded" stays true.
 *
 * ## Call us
 *
 * On the personalised demo the prospect first says which number they will
 * call from; it is saved on the demo (`callerRoute`, api/demo/[slug]/caller),
 * and when that number rings the demo line the line's inbound webhook
 * (api/voice-demo/inbound) answers as their clinic. Any other caller reaches
 * AYA, which is all the homepage needs, so there the tab is just the number.
 * Nothing is dialled by us, so there is no consent tick on this tab.
 *
 * ## Call me
 *
 * The same consent shape everywhere, because it is the same legal act: an AI
 * voice ringing a number somebody typed. Unticked by default, a sibling of the
 * button, the exact words of CALL_CONSENT, and the server refuses without them
 * (api/callback). The phone field may be prefilled from the operator's
 * request; the tick never is. Do not make the box default-checked, do not
 * fold the agreement into the button, and do not shorten the label without
 * bumping its version (lib/consent.ts has the reasoning). Since 12 October
 * 2026 the box is drawn as a switch (still a checkbox, off until the visitor
 * turns it on, beside the same words).
 *
 * ## The start of a personalised demo (`askName`, 24 October 2026)
 *
 * On the personalised demo page only, before a call starts on any of the three
 * ways, one pill (NameGate.tsx) says "Let's start" with a loading icon, asks
 * "What's your name?", and on the answer turns into the line the visitor waits
 * on, its dots moving: "AYA will be with you in a moment…" before the browser
 * call, "AYA will call you in a moment…" above the call-me form,
 * "AYA will answer in a moment…" over the dial card. The name is kept for the
 * visit in sessionStorage (lib/demo/first-name.ts), so "Call again" and the
 * other ways do not ask twice, and "Not Sam? Change" asks again. It reaches
 * the call as `firstName` in the browser call's one request, and as the call-me
 * request's `name`; the server cleans it again either way. The call-me form
 * drops its optional first-name field then, since the pill has already taken
 * it. The homepage does not ask: it talks to owners who have given nothing.
 *
 * ## The owner's picks of 12 October 2026
 *
 *   - The three ways are an iOS segmented control, a pill sliding to the one
 *     chosen, each with its icon.
 *   - Once a call connects her face shrinks to the top of the card and the
 *     call rises under it: her captions, a strip of things to ask her, and
 *     iOS's round call buttons (mute, captions, the red end).
 *   - "Call us" is a dial card: the number large, a green call button, and on
 *     a desktop a QR code that dials it from the visitor's phone.
 *   - "Call me" has a country picker with each country's flag, writes the
 *     number as it is typed (lib/dial-countries.ts), and once the call is
 *     placed shows the visitor's phone ringing, a ring running round it,
 *     until it is answered or the time it takes has passed.
 */

type CallState = "idle" | "connecting" | "live" | "ended" | "error";
type Mode = "talk" | "dial" | "callme";

/** "+18885551234" as "(888) 555-1234", the way a US number is written. */
function formatUs(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STATE_WORDS: Record<Exclude<CallVisualState, "idle">, string> = {
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
};

/** Things to ask her while the call runs: what a patient would ask. */
const ASK_HER = [
  "What does a consultation cost?",
  "Can I come in Thursday afternoon?",
  "Do you take a deposit?",
  "Are you open on Saturdays?",
  "Can I speak to someone?",
] as const;

/** How long the "ringing" shows before it offers to try again: a call takes a few seconds to place and ring. */
const RING_SECONDS = 40;

const ICON = {
  talk: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  ),
  dial: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
    </svg>
  ),
  callme: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
      <path d="M16 2v6h6M22 2l-6 6" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  micOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.5 2.5M12 18v3M3 3l18 18" />
    </svg>
  ),
  captions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17.5 10.2a2.5 2.5 0 1 0 0 3.6" strokeLinecap="round" />
    </svg>
  ),
  end: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 9c-2.2 0-4.3.4-6.2 1.1a1 1 0 0 0-.6.9v2.8a1 1 0 0 1-.8 1l-2.2.4a1 1 0 0 1-1.1-.6A3.4 3.4 0 0 1 1 13c.6-3 5.2-6 11-6s10.4 3 11 6c.1.6 0 1.1-.1 1.6a1 1 0 0 1-1.1.6l-2.2-.4a1 1 0 0 1-.8-1V11a1 1 0 0 0-.6-.9A17 17 0 0 0 12 9Z" />
    </svg>
  ),
};

/** One of iOS's round call buttons, its word under it. */
function CallButton({
  label,
  onClick,
  active = false,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={danger ? undefined : active} className="voice-key group flex flex-col items-center gap-1.5">
      <span
        className={`grid size-14 place-items-center rounded-full transition-colors duration-fast [&_svg]:size-6 ${
          danger ? "bg-[#ff3b30] text-white group-hover:bg-[#e6352b]" : active ? "bg-ink text-white" : "bg-black/[0.06] text-ink group-hover:bg-black/[0.1]"
        }`}
      >
        {children}
      </span>
      <span className="text-muted text-[12.5px] font-semibold">{label}</span>
    </button>
  );
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

export function VoiceCard({
  name,
  portraitLabel,
  callRoute,
  callerRoute,
  demoLine,
  ringNote,
  callbackExtra,
  prefillPhone = null,
  locked = false,
  idleTitle = true,
  aura = "halo",
  askName = false,
}: {
  /** Whose line it answers: the clinic's name, or AYA. */
  name: string;
  /** Under her face: "AYA · Peachy Studio's AI assistant". None on healdesk's own card. */
  portraitLabel?: string;
  /** "Call AYA" over the button before a call. Off on healdesk's own card (owner, 12 October 2026). */
  idleTitle?: boolean;
  /** What surrounds her face (AyaPortrait). */
  aura?: "halo" | "soul";
  /**
   * The route the SDK's control request goes to, before the path the SDK
   * would have used on Retell ("/v3/create-web-call").
   */
  callRoute: string;
  /** Where "Call us" saves the caller's number first. Without it, the tab is just the number. */
  callerRoute?: string;
  /** The demo line, E.164, or null when none is configured (the tab is then hidden). */
  demoLine: string | null;
  /** Under "Have it ring your phone": why it is calling, and that it never dials a patient. */
  ringNote: string;
  /** Anything else the call-me request carries, e.g. the demo's slug. */
  callbackExtra?: Record<string, string>;
  prefillPhone?: string | null;
  locked?: boolean;
  /** Ask for a first name before any call starts (the personalised demo page only). */
  askName?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("talk");
  const [dialFrom, setDialFrom] = useState(prefillPhone ?? "");
  const [dialSaving, setDialSaving] = useState(false);
  const [dialReady, setDialReady] = useState<string | null>(callerRoute ? null : "");
  const [dialError, setDialError] = useState<string | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [talking, setTalking] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const sessionRef = useRef<WebCallSession | null>(null);

  /** Her last line, captioned while the call runs. */
  const [caption, setCaption] = useState("");
  const [captions, setCaptions] = useState(true);
  /** The demo line as a QR code that dials it, drawn when the tab opens. */
  const [qr, setQr] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  /** The name given on this visit (askName only); the server cannot know it, so it is null until the page is in the browser. */
  const callerName = useSyncExternalStore(subscribeFirstName, getFirstName, () => null);
  const nameChecked = useSyncExternalStore(subscribeFirstName, () => true, () => false);
  /** "Let's start" has played once on this page: later gates open straight on the question. */
  const [introSeen, setIntroSeen] = useState(false);
  const [country, setCountry] = useState(() => splitNumber(prefillPhone).iso);
  const [phone, setPhone] = useState(() => splitNumber(prefillPhone).national);
  /** The call-me request went through this long ago: the ringing shows until RING_SECONDS. */
  const [ringing, setRinging] = useState(false);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // The call timer, only while live.
  useEffect(() => {
    if (state !== "live") return;
    const started = Date.now() - elapsed * 1000;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
    // `elapsed` is this timer's own output, read only as its starting point: zero for a new call.
    // Re-running on it would restart the interval every second, and the timer would fall behind.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- written by the interval it starts
  }, [state]);

  // Leaving the page ends the call rather than leaving the microphone open.
  useEffect(() => () => void sessionRef.current?.end().catch(() => {}), []);

  // The QR code for the dial card, made in the browser the first time the tab is opened.
  useEffect(() => {
    if (mode !== "dial" || !demoLine || qr) return;
    let alive = true;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(`tel:${demoLine}`, { margin: 0, width: 240, color: { dark: "#172a3aff", light: "#ffffff00" } }))
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [demoLine, mode, qr]);

  // The visitor's phone, ringing, for as long as a call takes to reach it.
  useEffect(() => {
    if (sent === null) return;
    const id = window.setTimeout(() => setRinging(false), RING_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [sent]);

  const startCall = useCallback(async () => {
    if (locked || state === "connecting" || state === "live") return;
    setCallError(null);
    setElapsed(0);
    setMuted(false);
    setTalking(false);
    setCaption("");
    setState("connecting");
    try {
      const { RetellClient } = await import("retell-client-js-sdk");
      const client = new RetellClient({
        // Never sent to Retell: our route sets the real Authorization header.
        key: "proxied",
        fetch: (url, init) => {
          const path = new URL(String(url)).pathname;
          const given = askName ? getFirstName() : null;
          return fetch(`${callRoute}${path}`, given && path.endsWith("/create-web-call") ? withFirstName(init, given) : init);
        },
      });
      const session = client.createWebCall({
        // Ignored by our route, which picks the agent server-side.
        agent_id: "server-chosen",
        audio: { emitRawAudioSamples: true },
        hooks: {
          onStatus: (status) => {
            if (status === "live") setState("live");
            if (status === "ended") {
              setState((prev) => (prev === "error" ? prev : "ended"));
              setLevel(0);
              setTalking(false);
              setCaption("");
            }
          },
          // Her last line, for the captions; only ever held here (see "Talk here").
          onUpdate: (event) => {
            const said = [...(event.transcript ?? [])].reverse().find((line) => line.role === "agent")?.content;
            if (said) setCaption(said);
          },
          onAgentStartTalking: () => setTalking(true),
          onAgentStopTalking: () => {
            setTalking(false);
            setLevel(0);
          },
          onAudio: (samples) => {
            let sum = 0;
            for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
            setLevel(Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 6));
          },
          onError: (error) => {
            const message = error.message || "";
            setCallError(
              /permission|notallowed|denied/i.test(message)
                ? "Your browser blocked the microphone. Allow it for this page and try again."
                : /expired/i.test(message)
                  ? "This demo has expired."
                  : /limit|too many|a few calls/i.test(message)
                    ? message
                    : "The call couldn't connect. Try again in a moment.",
            );
            setState("error");
            setTalking(false);
          },
        },
      });
      sessionRef.current = session;
      await session.ready.catch(() => {});
    } catch {
      setCallError("The call couldn't start in this browser. Try Chrome, Safari or Edge.");
      setState("error");
    }
  }, [askName, callRoute, locked, state]);

  const endCall = useCallback(async () => {
    await sessionRef.current?.end().catch(() => {});
    sessionRef.current = null;
    setState("ended");
    setLevel(0);
    setTalking(false);
    setCaption("");
  }, []);

  const giveName = useCallback((given: string) => rememberFirstName(given), []);
  const forgetName = useCallback(() => rememberFirstName(null), []);

  const markIntroSeen = useCallback(() => setIntroSeen(true), []);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (muted) session.unmute();
    else session.mute();
    setMuted(!muted);
  }, [muted]);

  const requestCall = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (submitting || locked) return;
      if (!consent) {
        setFormError("Turn on the agreement so we're allowed to call you.");
        return;
      }
      setSubmitting(true);
      setFormError(null);
      try {
        const response = await fetch("/api/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: toInternational(countryByIso(country), phone),
            name: (askName ? callerName : firstName) || undefined,
            consent: true,
            consentVersion: CALL_CONSENT.version,
            ...callbackExtra,
          }),
        });
        const data = (await response.json().catch(() => null)) as { error?: string; last4?: string } | null;
        if (!response.ok) {
          setFormError(data?.error ?? "We couldn't place the call. Try again.");
          return;
        }
        setSent(data?.last4 ?? "");
        setRinging(true);
      } catch {
        setFormError("Network error. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [askName, callbackExtra, callerName, consent, country, firstName, locked, phone, submitting],
  );

  const registerCaller = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!callerRoute || dialSaving || locked) return;
      setDialSaving(true);
      setDialError(null);
      try {
        const response = await fetch(callerRoute, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: dialFrom }),
        });
        const data = (await response.json().catch(() => null)) as { error?: string; last4?: string } | null;
        if (!response.ok) {
          setDialError(data?.error ?? "We couldn't save that number. Try again.");
          return;
        }
        setDialReady(data?.last4 ?? "");
      } catch {
        setDialError("Network error. Try again.");
      } finally {
        setDialSaving(false);
      }
    },
    [callerRoute, dialFrom, dialSaving, locked],
  );

  const live = state === "live";
  const busy = state === "connecting" || live;
  /** Asking, and not yet told: nothing else on the tab until the name is in. */
  const holdForName = askName && !locked && !callerName;
  /** The browser call is starting after the name was given: the pill keeps the visitor company, not the call screen. */
  const gateWaiting = askName && !locked && state === "connecting";
  const showCall = busy && !gateWaiting;
  const gateFor = (waitingText: string) =>
    nameChecked ? (
      <NameGate
        name={callerName}
        waitingText={waitingText}
        onSubmit={giveName}
        introDone={introSeen}
        onIntroDone={markIntroSeen}
        disabled={locked}
      />
    ) : (
      <div aria-hidden className="h-[3.25rem]" />
    );
  const notYou =
    askName && !locked && callerName ? (
      <p className="text-muted mt-2.5 text-center text-[13.2px] font-medium">
        Not {callerName}?{" "}
        <button type="button" onClick={forgetName} className="text-ink font-bold underline underline-offset-2">
          Change
        </button>
      </p>
    ) : null;
  const visual: CallVisualState = state === "connecting" ? "connecting" : live ? (talking ? "speaking" : "listening") : "idle";
  const tabs: { id: Mode; label: string; hint: string }[] = [
    { id: "talk", label: "Talk here", hint: "In your browser" },
    ...(demoLine ? [{ id: "dial" as const, label: "Call us", hint: "From your phone" }] : []),
    { id: "callme", label: "Call me", hint: "We ring you" },
  ];
  const at = Math.max(0, tabs.findIndex((tab) => tab.id === mode));
  const dialCountry = countryByIso(country);

  return (
    <div className="flex flex-1 flex-col">
      {/* iOS's segmented control: a pill slides to the way chosen. */}
      <div className="border-line border-b px-3 pt-3 pb-2.5">
        <div
          className="voice-segments relative grid rounded-sm bg-black/[0.055] p-1"
          role="tablist"
          aria-label="Ways to call"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, ["--n" as string]: tabs.length, ["--at" as string]: at }}
        >
          <span aria-hidden className="voice-segments__pill" />
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              disabled={busy && tab.id !== "talk"}
              onClick={() => setMode(tab.id)}
              className={`relative z-[1] flex items-center justify-center gap-1.5 rounded-sm px-2 py-2 text-[14px] font-semibold transition-colors duration-fast disabled:opacity-45 [&_svg]:size-[15px] ${
                mode === tab.id ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {ICON[tab.id]}
              {tab.label}
            </button>
          ))}
        </div>
        <p className="text-muted mt-1.5 text-center text-[12.5px] font-medium">{tabs[at]?.hint}</p>
      </div>

      {mode === "talk" ? (
        <div className="voice-talk flex flex-1 flex-col items-center px-6 pt-6 pb-6 text-center" data-busy={showCall || undefined}>
          {/* Her face: large while she waits, small at the top once the call is on. */}
          <AyaPortrait size={showCall ? 112 : 210} level={level} state={visual} aura={aura} />

          {showCall ? (
            <div className="voice-rise flex w-full flex-1 flex-col items-center">
              <p className="font-display text-ink mt-2 text-[21px] leading-tight font-medium tracking-[-0.02em]">
                {live ? `On the line with ${name}` : "Connecting…"}
              </p>
              <p className="text-muted mt-1 flex min-h-[1.5em] items-center gap-2 text-[14px] font-medium" aria-live="polite">
                {visual !== "idle" ? (
                  <span className="call-state text-[12.5px] font-bold tracking-[0.06em] uppercase" data-state={visual}>
                    {STATE_WORDS[visual]}
                  </span>
                ) : null}
                {live ? formatElapsed(elapsed) : null}
              </p>

              {/* Her words, as she says them. */}
              {live && captions ? (
                <p className="voice-caption text-ink mt-3 min-h-[3.2em] max-w-[34ch] text-[15.5px] leading-[1.45] font-medium" aria-live="polite">
                  {caption ? <span key={caption} className="voice-caption__line">{caption}</span> : <span className="text-muted">Say hello. Her words show here.</span>}
                </p>
              ) : null}

              {/* What to ask her: what a patient would. */}
              {live ? (
                <div className="voice-asks mt-3 w-full overflow-hidden" aria-label="Things to ask her">
                  <div className="voice-asks__track flex w-max gap-2">
                    {[...ASK_HER, ...ASK_HER].map((ask, i) => (
                      <span key={i} aria-hidden={i >= ASK_HER.length} className="border-line text-muted shrink-0 rounded-full border bg-white px-3 py-1 text-[12.5px] font-semibold whitespace-nowrap">
                        {ask}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-auto flex items-start justify-center gap-7 pt-5">
                <CallButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>
                  {muted ? ICON.micOff : ICON.mic}
                </CallButton>
                <CallButton label="Captions" onClick={() => setCaptions((on) => !on)} active={captions}>
                  {ICON.captions}
                </CallButton>
                <CallButton label="End" onClick={endCall} danger>
                  {ICON.end}
                </CallButton>
              </div>
            </div>
          ) : (
            <div className="voice-rise flex flex-col items-center">
              {portraitLabel ? <p className="text-muted mt-3 text-[13.2px] font-bold tracking-[0.1em] uppercase">{portraitLabel}</p> : null}
              {idleTitle ? (
                <p className="font-display text-ink mt-1.5 text-[23px] leading-tight font-medium tracking-[-0.02em]">{`Call ${name}`}</p>
              ) : null}
              {askName && !locked && (!callerName || gateWaiting) ? (
                <div className="mt-5 flex w-full justify-center">
                  {nameChecked ? (
                    <NameGate
                      name={callerName}
                      waitingText={`${site.agent} will be with you in a moment`}
                      onSubmit={(given) => {
                        giveName(given);
                        // In the same click that gave the name: the browser asks for the microphone on a click.
                        void startCall();
                      }}
                      introDone={introSeen}
                      onIntroDone={markIntroSeen}
                    />
                  ) : (
                    <div aria-hidden className="h-[3.25rem]" />
                  )}
                </div>
              ) : null}
              {askName && !locked && (!callerName || gateWaiting) ? null : (
              <>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={startCall}
                  disabled={locked || busy}
                  className="morph-btn rounded-full px-6 py-3 text-[16.8px] font-bold shadow-md transition-all duration-fast hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
                  style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
                >
                  <span className="morph-btn__label">{state === "ended" ? "Call again" : "Talk now"}</span>
                  {/* Under the pointer the words give way to a phone that rings
                      once, and come back when it leaves (owner, 12 October 2026). */}
                  <span aria-hidden className="morph-btn__icon morph-btn__icon--ring">
                    {ICON.dial}
                  </span>
                </button>
              </div>
              {callError ? (
                <p className="text-red-deep mt-3 text-[15px] font-semibold" role="alert">
                  {callError}
                </p>
              ) : (
                <p className="text-muted mt-3 text-[13.2px] font-medium">Uses your microphone. Nothing is recorded.</p>
              )}
              {notYou}
              </>
              )}
            </div>
          )}
        </div>
      ) : null}

      {mode === "dial" && demoLine ? (
        <div className="voice-rise flex flex-1 flex-col items-center justify-center px-6 py-7 text-center">
          {askName && !locked ? (
            <div className="mb-6 flex w-full flex-col items-center">
              {gateFor(`${site.agent} will answer in a moment`)}
              {notYou}
            </div>
          ) : null}
          {holdForName ? null : (
            <>
          {dialReady !== null ? (
            <div className="flex w-full flex-col items-center gap-6 lg:flex-row lg:justify-center lg:gap-8">
              {/* The dial card: the number, large, and a green call button. */}
              <div className="flex flex-col items-center">
                <p className="text-muted text-[13.5px] font-semibold">
                  {callerRoute ? `From the number ending ${dialReady}, call` : `Call ${name} from your phone`}
                </p>
                <a href={`tel:${demoLine}`} className="font-display text-ink mt-1.5 text-[32px] leading-tight font-semibold tracking-[-0.01em] tabular-nums">
                  {formatUs(demoLine)}
                </a>
                <a
                  href={`tel:${demoLine}`}
                  aria-label={`Call ${formatUs(demoLine)}`}
                  className="voice-key mt-4 grid size-16 place-items-center rounded-full bg-[#34c759] text-white shadow-md transition-transform duration-fast hover:scale-105 [&_svg]:size-7"
                >
                  {ICON.dial}
                </a>
              </div>
              {/* On a desktop, a code the visitor's phone can scan to dial it. */}
              <div className="hidden flex-col items-center lg:flex">
                <span className="grid size-[132px] place-items-center rounded-md bg-white p-3 shadow-sm ring-1 ring-black/[0.06]">
                  {qr ? <img src={qr} alt="" width={108} height={108} className="size-[108px]" /> : <span className="bg-paper-2 size-[108px] rounded-sm" />}
                </span>
                <p className="text-muted mt-2 text-[12.5px] font-semibold">Scan to call from your phone</p>
              </div>
            </div>
          ) : (
            <form onSubmit={registerCaller} className="w-full max-w-[380px]">
              <p className="font-display text-ink text-[23px] leading-tight font-medium tracking-[-0.02em]">Call {name} from your phone</p>
              <p className="text-muted mt-1.5 text-[15px] font-medium">Tell us the number you&rsquo;ll call from, and we&rsquo;ll recognise you.</p>
              <div className="mt-4 flex gap-2">
                <input
                  type="tel"
                  required
                  value={dialFrom}
                  onChange={(e) => setDialFrom(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  aria-label="The number you'll call from"
                  autoComplete="tel"
                  disabled={locked}
                  className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-sm border px-3.5 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
                />
                <button
                  type="submit"
                  disabled={locked || dialSaving || !dialFrom.trim()}
                  className="shrink-0 rounded-sm px-5 py-2.5 text-[16px] font-bold transition-all duration-fast hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
                  style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
                >
                  {dialSaving ? "Saving…" : "Get the number"}
                </button>
              </div>
              {dialError ? (
                <p className="text-red-deep mt-2.5 text-[15px] font-semibold" role="alert">
                  {dialError}
                </p>
              ) : null}
            </form>
          )}
          {dialReady !== null ? (
            <p className="text-muted mt-6 max-w-[40ch] text-[14px] font-medium">
              {callerRoute
                ? `It answers as ${name}, the way it would answer your own line. Calls from any other number reach healdesk’s assistant.`
                : `${name} answers it the way she would answer your own line.`}
              {callerRoute ? (
                <>
                  {" "}
                  <button type="button" onClick={() => setDialReady(null)} className="text-ink font-bold underline underline-offset-2">
                    Use a different number
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
            </>
          )}
        </div>
      ) : null}

      {mode !== "callme" ? null : sent !== null ? (
        <div className="voice-rise flex flex-1 flex-col items-center justify-center gap-1.5 px-5 py-6 text-center">
          {/* The visitor's phone, ringing, a ring running round it while the call reaches it. */}
          <span className="relative grid size-24 place-items-center" aria-hidden>
            {ringing ? (
              <svg viewBox="0 0 96 96" className="absolute inset-0 -rotate-90">
                <circle cx="48" cy="48" r="44" fill="none" stroke="rgb(0 0 0 / 0.07)" strokeWidth="4" />
                <circle cx="48" cy="48" r="44" fill="none" strokeWidth="4" strokeLinecap="round" pathLength={1} className="voice-ring" style={{ stroke: "#34c759", ["--ring" as string]: `${RING_SECONDS}s` }} />
              </svg>
            ) : null}
            <span className={`grid size-16 place-items-center rounded-full bg-[#34c759] text-white [&_svg]:size-7 ${ringing ? "voice-buzz" : ""}`}>{ICON.dial}</span>
          </span>
          <p className="font-display mt-2 text-[21px] leading-tight font-medium tracking-[-0.02em]">{ringing ? "Your phone is ringing…" : "Did it ring?"}</p>
          <p className="text-muted max-w-[36ch] text-[15px] font-medium">
            {ringing
              ? `${name} is calling ${sent ? `the number ending ${sent}` : "you"}. Say “stop” at any point and the call ends.`
              : "If it didn’t, check the number and try again."}
          </p>
          <button
            type="button"
            onClick={() => {
              setSent(null);
              setRinging(false);
              setConsent(false);
            }}
            className="text-muted hover:text-ink mt-1 text-[15px] font-bold transition-colors"
          >
            Call another number
          </button>
        </div>
      ) : (
        <div className="voice-rise flex flex-1 flex-col justify-center px-5 py-6">
          <p className="font-display text-ink text-[23px] leading-tight font-medium tracking-[-0.02em]">Have it ring your phone</p>
          <p className="text-muted mt-0.5 text-[14px] font-medium">{ringNote}</p>
          {askName && !locked ? (
            <div className="mt-3 flex w-full flex-col items-center">
              {gateFor(`${site.agent} will call you in a moment`)}
              {notYou}
            </div>
          ) : null}
          {holdForName ? null : (
        <form onSubmit={requestCall} className={`flex flex-col ${askName ? "voice-rise" : ""}`}>
          <div className="mt-3 flex flex-col gap-2">
            {askName ? null : (
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                aria-label="First name"
                autoComplete="given-name"
                maxLength={80}
                disabled={locked}
                className="border-line text-ink placeholder:text-muted min-w-0 rounded-sm border px-3.5 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
              />
            )}
            <div className="border-line flex min-w-0 items-stretch overflow-hidden rounded-sm border transition-colors focus-within:border-[var(--clinic)]">
              {/* The country: its flag and code, then the number as it is written there. */}
              <label className="border-line relative flex shrink-0 items-center gap-1.5 border-r bg-black/[0.025] pr-2 pl-3">
                <span aria-hidden className="text-[18px] leading-none">
                  {dialCountry.flag}
                </span>
                <span aria-hidden className="text-ink text-[15px] font-semibold tabular-nums">
                  +{dialCountry.code}
                </span>
                <svg aria-hidden viewBox="0 0 12 12" className="text-muted size-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
                </svg>
                <select
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setPhone((value) => formatNational(countryByIso(e.target.value), value));
                  }}
                  disabled={locked}
                  aria-label="Country"
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  {DIAL_COUNTRIES.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.flag} {c.name} (+{c.code})
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(formatNational(dialCountry, e.target.value))}
                placeholder={dialCountry.code === "1" ? "(212) 000-0000" : "Phone number"}
                aria-label="Your phone number"
                autoComplete="tel-national"
                inputMode="tel"
                disabled={locked}
                className="text-ink placeholder:text-muted min-w-0 flex-1 px-3.5 py-2.5 text-[16px] tabular-nums outline-none"
              />
            </div>
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-3">
            {/* A switch, off until the visitor turns it on: still the checkbox the consent rules ask for. */}
            <input
              type="checkbox"
              role="switch"
              required
              checked={consent}
              disabled={locked}
              onChange={(e) => setConsent(e.target.checked)}
              className="voice-switch mt-0.5 shrink-0"
            />
            <span className="text-[13px] leading-[1.45] font-medium">
              {CALL_CONSENT.text}{" "}
              <span className="opacity-70">
                {CALL_CONSENT.note}{" "}
                <a href="/privacy#collect" className="underline underline-offset-2">
                  Privacy
                </a>
              </span>
            </span>
          </label>
          <button
            type="submit"
            disabled={locked || submitting || !consent || !phone.trim()}
            className="mt-4 flex h-12 items-center justify-center gap-2 rounded-sm px-5 text-[16px] font-bold transition-all duration-fast hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45 [&_svg]:size-[18px]"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            {ICON.callme}
            {submitting ? "Calling…" : "Call me"}
          </button>
          {formError ? (
            <p className="text-red-deep mt-2.5 text-[15px] font-semibold" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
          )}
        </div>
      )}
    </div>
  );
}
