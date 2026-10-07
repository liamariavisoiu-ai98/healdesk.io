"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WebCallSession } from "retell-client-js-sdk";

import { CALL_CONSENT } from "@/lib/consent";

/**
 * The personalised demo's voice half: talk to the clinic's AI assistant from
 * the browser, or have it ring your phone.
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

const PHONE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.45-1.19a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z" />
  </svg>
);

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ClinicVoicePanel({
  slug,
  clinicName,
  prefillPhone,
  locked,
}: {
  slug: string;
  clinicName: string;
  prefillPhone: string | null;
  locked: boolean;
}) {
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

  const live = state === "live";
  const busy = state === "connecting" || live;

  return (
    <div className="flex flex-1 flex-col">
      {/* Talk now */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        <div className="relative grid size-24 place-items-center">
          <span
            aria-hidden
            className="absolute inset-0 rounded-full transition-transform duration-100"
            style={{
              background: "var(--clinic)",
              opacity: live ? 0.18 : 0.1,
              transform: `scale(${1 + (live ? level * 0.45 : 0)})`,
            }}
          />
          <span
            className="relative grid size-16 place-items-center rounded-full text-white shadow-lg [&_svg]:size-7"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            {PHONE_ICON}
          </span>
        </div>

        <p className="font-display text-ink mt-5 text-[23px] leading-tight font-medium tracking-[-0.02em]">
          {live ? `On the line with ${clinicName}` : state === "connecting" ? "Connecting…" : `Call ${clinicName}`}
        </p>
        <p className="text-muted mt-1.5 max-w-[34ch] text-[15px] font-medium">
          {live
            ? `${formatElapsed(elapsed)} · Ask what a patient would ask.`
            : "Talk to the clinic's AI assistant from your browser. It answers the way it would answer your phone."}
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

      {/* Call me */}
      {sent !== null ? (
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
        <form onSubmit={requestCall} className="border-line border-t px-5 py-4">
          <p className="text-[16px] font-semibold">Or have it ring your phone.</p>
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
