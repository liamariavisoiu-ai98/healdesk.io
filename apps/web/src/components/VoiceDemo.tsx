"use client";

import { useCallback, useEffect, useState } from "react";

import { BuyButton } from "@/components/BuyModal";
import { HealdeskSoul } from "@/components/HealdeskSoul";
import { CALL_CONSENT } from "@/lib/consent";
import { DEMO_AGENT } from "@/lib/demo-agent";
import { site } from "@/lib/site";

const PHONE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

const LINE_DELAY_MS = 1_600;

/**
 * The phone half of the demo: a scripted inbound call, and a real outbound one.
 *
 * The transcript is deliberately scripted, a live inbound demo would need the
 * visitor to dial a number, and that is a worse first impression than watching
 * a call go well. What IS live is the other direction: the visitor can hand
 * over their number and have AYA ring them, which is the only way to actually
 * hear the product.
 *
 * That one consented demo call to a clinic owner is the only call anything
 * on healdesk ever places. The product is inbound only and never dials a
 * patient, so the panel says so beside the form. The call runs on Retell, to
 * AYA's demo agent (lib/retell-demo-call.ts); the product's voice agent is a
 * separate Retell agent that only ever answers.
 *
 * ## The consent gate is not a formality
 *
 * This places an AI-voice call to a number a stranger typed in. The checkbox is
 * unticked, separate from the button, and worded in lib/consent.ts, which the
 * server reads too so the audit record and the label cannot drift. The full
 * reasoning. TCPA, the FCC's February 2024 ruling that AI voices are
 * "artificial", why consent must not be a condition of purchase, is in that
 * file. Do not make the box default-checked, do not fold the agreement into the
 * button, and do not shorten the label without bumping the version.
 */
export function VoiceDemo() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const [sent, setSent] = useState(false);
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last4, setLast4] = useState<string | null>(null);

  const totalLines = DEMO_AGENT.voice.length;

  /**
   * The line currently landing.
   *
   * `visibleLines` is a count, so the newest line is at `visibleLines - 1`.
   */
  const current = DEMO_AGENT.voice[visibleLines - 1];

  /**
   * One heartbeat while she is talking, from the pace of the line itself.
   *
   * Every line gets the same LINE_DELAY_MS on screen, so a line with twenty
   * words in it is being spoken twice as fast as one with ten, and the orb
   * should say so. Clamped at both ends for the same reason the chat's is:
   * under 180ms a beat is a flicker, over 460ms it has stopped tracking.
   *
   * There is no audio here to analyse. This is the closest thing to a tempo
   * the panel actually has, and it is a real one rather than a guess.
   */
  const lineBeatMs = (() => {
    const words = current?.text.trim().split(/\s+/).length ?? 1;
    return Math.min(Math.max(LINE_DELAY_MS / Math.max(words, 1), 180), 460);
  })();

  const start = useCallback(() => {
    setVisibleLines(0);
    setSeconds(0);
    setPlaying(true);
  }, []);

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

  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(interval);
  }, [playing]);

  const requestCall = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (submitting) return;

      // Belt and braces alongside the checkbox's `required`: the button is
      // disabled without consent, and the server refuses without it too.
      if (!consent) {
        setError("Tick the box so we're allowed to call you.");
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch("/api/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone,
            name: firstName || undefined,
            consent: true,
            consentVersion: CALL_CONSENT.version,
          }),
        });
        const data = (await response.json().catch(() => null)) as
          | { error?: string; last4?: string }
          | null;

        if (!response.ok) {
          setError(data?.error ?? "We couldn't place the call. Try again.");
          return;
        }
        setLast4(data?.last4 ?? null);
        setSent(true);
      } catch {
        setError("Network error. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [consent, firstName, phone, submitting],
  );

  /** Has the visitor asked for the call? Survives the end of playback. */
  const started = playing || visibleLines > 0;
  const finished = !playing && visibleLines >= totalLines;
  const timestamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="flex h-[540px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_32px_64px_-36px_rgb(23_42_58/0.45)] sm:h-[600px]">
      <div className="border-line flex items-center gap-2.5 border-b px-[18px] py-3.5">
        {/* No orb here any more. It moved down into the call itself, where it
            stands in for her name on her turns, which is the only place in the
            panel where "the agent" is a participant rather than a label. */}
        <span className="text-sm font-bold">Phone call</span>
        {/* "Scripted example", not "Inbound". The panel has a running call
            timer and a moving waveform, and a visitor could reasonably read
            that as a recording of a real call, which does not exist anywhere
            in this project. The honest label is better anyway: the transcript
            is the illustration, and the form underneath is the real thing. */}
        <span className="text-muted ml-auto text-[15px] font-semibold tabular-nums">
          Scripted example · {timestamp}
        </span>
      </div>

      {/*
        The transcript's own controls. The waveform that used to sit here is
        gone twice over: a row of twenty-eight bars, then a second orb.

        The bars were decorative and quietly dishonest, moving on a fixed
        pattern whoever was talking. The orb that replaced them was honest but
        redundant, because the header already carries one and two of the same
        mark in one panel is one too many. What is left is the header orb doing
        the work and this row doing nothing but offering a replay.
      */}
      <div className="flex h-[34px] items-center justify-end px-[18px] pt-4">
        {started ? (
          <button
            type="button"
            onClick={start}
            className="text-muted hover:text-ink shrink-0 text-[15px] font-bold transition-colors"
          >
            {finished ? "Replay" : "Restart"}
          </button>
        ) : null}
      </div>

      {/*
        An example call, and deliberately not a chat log.

        This was a scrolling transcript: speaker label, paragraph, speaker
        label, paragraph, stacked and scrollable. That is the shape of a
        messaging thread, and it put the phone panel and the web chat panel
        side by side looking like the same product twice.

        A call is one voice at a time and nothing kept on screen, so that is
        what this shows now. One line, centred, replaced as the call moves on,
        with the speaker named above it and the timer running in the header.
        The whole exchange is still readable, just at the pace of the call
        rather than all at once.
      */}
      <div className="flex flex-1 flex-col items-center justify-center px-7 text-center">
        {!started ? (
          /*
            Before anything has been asked for, the panel is the orb and an
            invitation, and nothing else.

            It used to start itself on mount, so a visitor who scrolled past
            arrived at the middle of a conversation with no idea it had a
            beginning. Worse, the first thing on screen was the caller's line,
            which made the panel look like a transcript somebody had left open.
            Now it waits, and the whole block is the button.
          */
          <button type="button" onClick={start} className="group flex flex-col items-center">
            <HealdeskSoul size={72} />
            <span className="font-display text-ink mt-6 block text-[25.2px] leading-tight font-medium tracking-[-0.02em]">
              Hear it for yourself
            </span>
            <span className="text-red-deep group-hover:text-red mt-2 flex items-center gap-1.5 text-[15px] font-bold transition-colors">
              Play the example call
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-[13px] transition-transform duration-200 ease-out group-hover:translate-x-1"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          </button>
        ) : current ? (
          <div key={visibleLines} className="call-line flex flex-col items-center">
            {/*
              Her name, as the orb. The caller keeps a word because the caller
              is a stranger and a stranger has no mark; she has one, and using
              it here is the only place in the panel where the two speakers are
              told apart by something other than type.
            */}
            {current.agent ? (
              <HealdeskSoul
                mode="voice"
                beatMs={lineBeatMs}
                size={34}
                label={`${site.agent} is speaking`}
              />
            ) : (
              <p className="text-muted text-[13.2px] font-bold tracking-[0.1em] uppercase">
                Caller
              </p>
            )}
            <p className="mx-auto mt-4 max-w-[30ch] text-[19.2px] leading-[1.45] text-balance">
              {current.text}
            </p>
          </div>
        ) : (
          <p className="text-muted text-[15.6px] font-medium">Connecting…</p>
        )}
      </div>

      {/* The real thing, always on screen.
          It deliberately is NOT behind a "would you like a call?" button. The
          whole argument of this panel is that you can hear the product in under
          a minute, and a disclosure step in front of the phone field turns that
          into a two-click ask. There is also no email fallback anywhere in this
          flow: a number typed here produces a call, or an error that says to
          try again. */}
      {sent ? (
        <div className="border-line flex flex-col items-center gap-2 border-t px-[18px] py-6 text-center">
          <span className="bg-mint/40 text-ink grid size-10 place-items-center rounded-full [&_svg]:size-[18px]">
            {PHONE_ICON}
          </span>
          <p className="font-display mt-1 text-[22.8px] leading-tight font-medium tracking-[-0.02em]">
            Calling you now.
          </p>
          <p className="text-muted mx-auto max-w-[36ch] text-[15.6px] font-medium">
            {last4 ? `Watch for a call to the number ending ${last4}. ` : ""}
            Say &ldquo;stop&rdquo; at any point and the call ends.
          </p>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setLast4(null);
              setPhone("");
              setConsent(false);
            }}
            className="text-muted hover:text-ink mt-1 text-[15px] font-bold transition-colors"
          >
            Call another number
          </button>
        </div>
      ) : (
        <form onSubmit={requestCall} className="border-line border-t px-[18px] py-4">
          {/* Says what this call is: one demo call, placed because the
              visitor asked. The product itself is inbound only and never
              dials a patient, and the panel must not suggest otherwise. */}
          <p className="text-[16.2px] font-semibold">
            Or have her place one demo call to your phone, now.
          </p>
          <p className="text-muted mt-1 text-[14.4px] font-medium">
            For your clinic she only answers. She never dials a patient.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              placeholder="First name"
              aria-label="First name"
              autoComplete="given-name"
              maxLength={80}
              className="border-line focus:border-orange text-ink placeholder:text-muted min-w-0 rounded-xl border px-3.5 py-2.5 text-[16.8px] outline-none transition-colors sm:w-[9rem]"
            />
            <input
              type="tel"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 (555) 000-0000"
              aria-label="Your phone number"
              autoComplete="tel"
              className="border-line focus:border-orange text-ink placeholder:text-muted min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-[16.8px] outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={submitting || !consent || !phone.trim()}
              className="bg-brand-gradient shadow-brand shrink-0 rounded-xl px-5 py-2.5 text-[16.8px] font-bold text-white transition-all duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45"
            >
              {submitting ? "Calling…" : "Call me"}
            </button>
          </div>

          {/* Unticked by default, and a SIBLING of the button rather than
              folded into it. See lib/consent.ts. This shape is the legal
              requirement, not a style choice. */}
          <label className="mt-3 flex cursor-pointer gap-2.5">
            <input
              type="checkbox"
              required
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              className="accent-red mt-px size-[14px] shrink-0 cursor-pointer"
            />
            <span className="text-[13.2px] leading-[1.45] font-medium">
              {CALL_CONSENT.text}{" "}
              {/* Points at the section of the privacy policy that covers the
                  number itself, not at the policy's top: a consent notice
                  should land the reader on the answer. It pointed at /contact
                  while there was no /privacy page to point at; that page
                  shipped, so the link now goes where it always meant to. */}
              <a href="/privacy#collect" className="text-red-deep underline underline-offset-2">
                what we do with your number
              </a>
              . {CALL_CONSENT.note}
            </span>
          </label>

          {error ? (
            <p className="text-red-deep mt-2.5 text-[15px] font-semibold" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}

      {/* Deliberately does NOT pass firstName through: contactName seeds the
          typed signature on the business associate agreement, and a first name
          executed on a contract is worse than a blank field. */}
      <div className="border-line flex items-center gap-3 border-t px-[18px] py-3">
        <span className="text-muted text-[15px] font-semibold">
          Want this answering your phone?
        </span>
        <BuyButton
          variant="quiet"
          className="ml-auto shrink-0 !px-4 !py-2 !text-[15.6px]"
        />
      </div>
    </div>
  );
}
