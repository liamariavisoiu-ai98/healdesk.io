"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WebCallSession } from "retell-client-js-sdk";

import { AyaPortrait } from "@/components/demo/AyaPortrait";
import { CALL_CONSENT } from "@/lib/consent";

/**
 * The personalised demo's voice half, three ways to reach the clinic's AI
 * assistant, in Sloane's voice: talk to it from the browser, call the demo
 * line from your own phone, or have it ring you.
 *
 * ## Call us
 *
 * The prospect says which number they will call from, it is saved on the
 * demo (api/demo/[slug]/caller), and when that number rings the demo line
 * the line's inbound webhook (api/voice-demo/inbound) answers as this clinic.
 * Any other caller reaches healdesk's own assistant, as before. Nothing is
 * dialled by us, so there is no consent tick on this tab.
 *
 * ## Talk now
 *
 * The Retell browser SDK is loaded only when the button is pressed (it pulls
 * in WebRTC code nobody needs until then) and is pointed at our own route for
 * its single control request (`fetch` override): the route builds the call
 * from the stored demo and holds the key, so nothing secret or steerable is
 * in this bundle. The microphone prompt happens on that click, as browsers
 * require. No transcript stream: that would need a key in the browser.
 *
 * ## Call me
 *
 * The same consent shape as the homepage's voice demo, because it is the same
 * legal act: an AI voice ringing a number somebody typed. Unticked by
 * default, a sibling of the button, the exact words of CALL_CONSENT, and the
 * server refuses without them (api/callback). The phone field may be
 * prefilled from the operator's request; the tick never is.
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

export function ClinicVoicePanel({
  slug,
  clinicName,
  prefillPhone,
  demoLine,
  ayaVideo = null,
  locked,
}: {
  slug: string;
  clinicName: string;
  prefillPhone: string | null;
  /** The demo line, E.164, or null when none is configured (the tab is then hidden). */
  demoLine: string | null;
  /** A looping clip of AYA for the portrait, when one is published (see AyaPortrait). */
  ayaVideo?: string | null;
  locked: boolean;
}) {
  const [mode, setMode] = useState<Mode>("talk");
  const [dialFrom, setDialFrom] = useState(prefillPhone ?? "");
  const [dialSaving, setDialSaving] = useState(false);
  const [dialReady, setDialReady] = useState<string | null>(null);
  const [dialError, setDialError] = useState<string | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const sessionRef = useRef<WebCallSession | null>(null);

  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState(prefillPhone ?? "");
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

  const startCall = useCallback(async () => {
    if (locked || state === "connecting" || state === "live") return;
    setCallError(null);
    setElapsed(0);
    setMuted(false);
    setState("connecting");
    try {
      const { RetellClient } = await import("retell-client-js-sdk");
      const client = new RetellClient({
        // Never sent to Retell: our route sets the real Authorization header.
        key: "proxied",
        fetch: (url, init) => fetch(`/api/demo/${slug}/retell${new URL(String(url)).pathname}`, init),
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
            }
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
          },
        },
      });
      sessionRef.current = session;
      await session.ready.catch(() => {});
    } catch {
      setCallError("The call couldn't start in this browser. Try Chrome, Safari or Edge.");
      setState("error");
    }
  }, [locked, slug, state]);

  const endCall = useCallback(async () => {
    await sessionRef.current?.end().catch(() => {});
    sessionRef.current = null;
    setState("ended");
    setLevel(0);
  }, []);

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
        setFormError("Tick the box so we're allowed to call you.");
        return;
      }
      setSubmitting(true);
      setFormError(null);
      try {
        const response = await fetch("/api/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone,
            name: firstName || undefined,
            consent: true,
            consentVersion: CALL_CONSENT.version,
            demoSlug: slug,
          }),
        });
        const data = (await response.json().catch(() => null)) as { error?: string; last4?: string } | null;
        if (!response.ok) {
          setFormError(data?.error ?? "We couldn't place the call. Try again.");
          return;
        }
        setSent(data?.last4 ?? "");
      } catch {
        setFormError("Network error. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [consent, firstName, locked, phone, slug, submitting],
  );

  const registerCaller = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (dialSaving || locked) return;
      setDialSaving(true);
      setDialError(null);
      try {
        const response = await fetch(`/api/demo/${slug}/caller`, {
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
    [dialFrom, dialSaving, locked, slug],
  );

  const live = state === "live";
  const busy = state === "connecting" || live;
  const tabs: { id: Mode; label: string; hint: string }[] = [
    { id: "talk", label: "Talk here", hint: "In your browser" },
    ...(demoLine ? [{ id: "dial" as const, label: "Call us", hint: "From your phone" }] : []),
    { id: "callme", label: "Call me", hint: "We ring you" },
  ];

  return (
    <div className="flex flex-1 flex-col">
      <div className={`border-line grid gap-1 border-b p-2 ${tabs.length === 3 ? "grid-cols-3" : "grid-cols-2"}`} role="tablist" aria-label="Ways to call">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            disabled={busy && tab.id !== "talk"}
            onClick={() => setMode(tab.id)}
            className={`rounded-xl px-2 py-2 text-center transition-colors disabled:opacity-50 ${mode === tab.id ? "bg-paper-2" : "hover:bg-paper-2/60"}`}
          >
            <span className={`block text-[14.4px] font-bold ${mode === tab.id ? "text-ink" : "text-muted"}`}>{tab.label}</span>
            <span className="text-muted block text-[12px] font-medium">{tab.hint}</span>
          </button>
        ))}
      </div>

      {mode === "talk" ? (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        <AyaPortrait size={210} level={level} live={live} videoSrc={ayaVideo} />
        <p className="text-muted mt-3 text-[13.2px] font-bold tracking-[0.1em] uppercase">AYA · {clinicName}&rsquo;s AI assistant</p>

        <p className="font-display text-ink mt-1.5 text-[23px] leading-tight font-medium tracking-[-0.02em]">
          {live ? `On the line with ${clinicName}` : state === "connecting" ? "Connecting…" : `Call ${clinicName}`}
        </p>
        <p className="text-muted mt-1.5 max-w-[34ch] text-[15px] font-medium">
          {live ? `${formatElapsed(elapsed)} · Ask what a patient would ask.` : null}
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {live ? (
            <>
              <button
                type="button"
                onClick={toggleMute}
                className="border-line hover:border-line-strong text-ink rounded-full border px-4 py-2.5 text-[15.6px] font-bold transition-colors"
              >
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                onClick={endCall}
                className="bg-red-deep rounded-full px-5 py-2.5 text-[15.6px] font-bold text-white transition-opacity hover:opacity-90"
              >
                End call
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={startCall}
              disabled={locked || busy}
              className="rounded-full px-6 py-3 text-[16.8px] font-bold shadow-md transition-all duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
              style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
            >
              {state === "connecting" ? "Connecting…" : state === "ended" ? "Call again" : "Talk now"}
            </button>
          )}
        </div>
        {callError ? (
          <p className="text-red-deep mt-3 text-[15px] font-semibold" role="alert">
            {callError}
          </p>
        ) : (
          <p className="text-muted mt-3 text-[13.2px] font-medium">Uses your microphone. Nothing is recorded.</p>
        )}
      </div>

      ) : null}

      {mode === "dial" && demoLine ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
          {dialReady !== null ? (
            <>
              <p className="text-muted text-[14.4px] font-semibold">From the number ending {dialReady}, call</p>
              <a
                href={`tel:${demoLine}`}
                className="font-display mt-2 text-[34px] leading-tight font-semibold tracking-[-0.01em] underline-offset-4 hover:underline"
              >
                {formatUs(demoLine)}
              </a>
              <p className="text-muted mt-3 max-w-[36ch] text-[15px] font-medium">
                It answers as {clinicName}, the way it would answer your own line. Calls from any other number reach healdesk&rsquo;s assistant.
              </p>
              <button
                type="button"
                onClick={() => setDialReady(null)}
                className="text-muted hover:text-ink mt-3 text-[14.4px] font-bold transition-colors"
              >
                Use a different number
              </button>
            </>
          ) : (
            <form onSubmit={registerCaller} className="w-full max-w-[380px]">
              <p className="font-display text-ink text-[23px] leading-tight font-medium tracking-[-0.02em]">Call {clinicName} from your phone</p>
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
                  className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
                />
                <button
                  type="submit"
                  disabled={locked || dialSaving || !dialFrom.trim()}
                  className="shrink-0 rounded-xl px-5 py-2.5 text-[16px] font-bold transition-all duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
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
        </div>
      ) : null}

      {mode !== "callme" ? null : sent !== null ? (
        <div className="border-line flex flex-col items-center gap-1.5 border-t px-5 py-6 text-center">
          <p className="font-display text-[21px] leading-tight font-medium tracking-[-0.02em]">Calling you now.</p>
          <p className="text-muted max-w-[36ch] text-[15px] font-medium">
            {sent ? `Watch for a call to the number ending ${sent}. ` : ""}Say &ldquo;stop&rdquo; at any point and the call ends.
          </p>
          <button
            type="button"
            onClick={() => {
              setSent(null);
              setConsent(false);
            }}
            className="text-muted hover:text-ink mt-1 text-[15px] font-bold transition-colors"
          >
            Call another number
          </button>
        </div>
      ) : (
        <form onSubmit={requestCall} className="flex flex-1 flex-col justify-center px-5 py-6">
          <p className="font-display text-ink text-[23px] leading-tight font-medium tracking-[-0.02em]">Have it ring your phone</p>
          <p className="text-muted mt-0.5 text-[14px] font-medium">
            One demo call, because you asked. Live, it only answers: it never dials a patient.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              aria-label="First name"
              autoComplete="given-name"
              maxLength={80}
              disabled={locked}
              className="border-line text-ink placeholder:text-muted min-w-0 rounded-xl border px-3.5 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)] sm:w-[8.5rem]"
            />
            <input
              type="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 000-0000"
              aria-label="Your phone number"
              autoComplete="tel"
              disabled={locked}
              className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
            />
            <button
              type="submit"
              disabled={locked || submitting || !consent || !phone.trim()}
              className="shrink-0 rounded-xl px-5 py-2.5 text-[16px] font-bold transition-all duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
              style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
            >
              {submitting ? "Calling…" : "Call me"}
            </button>
          </div>
          <label className="mt-3 flex cursor-pointer gap-2.5">
            <input
              type="checkbox"
              required
              checked={consent}
              disabled={locked}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-px size-[14px] shrink-0 cursor-pointer accent-[var(--clinic)]"
            />
            <span className="text-[13px] leading-[1.45] font-medium">
              {CALL_CONSENT.text}{" "}
              <a href="/privacy#collect" className="underline underline-offset-2">
                what we do with your number
              </a>
              . {CALL_CONSENT.note}
            </span>
          </label>
          {formError ? (
            <p className="text-red-deep mt-2.5 text-[15px] font-semibold" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
