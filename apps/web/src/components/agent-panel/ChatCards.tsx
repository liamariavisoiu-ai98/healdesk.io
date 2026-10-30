"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The rich replies in the chat card (owner, 12 October 2026): what a patient
 * sees when the assistant books them, and when it sends a deposit link.
 *
 * They are previews, drawn by the card itself after the assistant has
 * answered a question about booking or about deposits (ChatSkins), never
 * sent to the model and never written anywhere: nothing here touches a
 * calendar or a checkout, and each says so in its last line.
 *
 * What they show is v1 as docs/v1-product-spec.md has it, and nothing more:
 *
 *   - a few times offered; the one picked is held for 60 seconds before
 *     anything confirming is said, its ring running down, and let go if
 *     nobody confirms; confirmed, it is in the clinic's Google Calendar;
 *   - in chat, a deposit link through the clinic's own checkout, with an
 *     amount and a generic descriptor and nothing clinical (CLAUDE.md, "No
 *     treatment name in a payment description, a Meta message or the
 *     support chat"). A card number is never asked for in the chat.
 */

/** The channel's own colour for a card's button and ring. */
export type CardAccent = { bg: string; ink: string };

/** How long a picked slot is held before it is let go (the spec's hold). */
const HOLD_SECONDS = 60;

/** The next three times on the next weekday, on the visitor's clock. */
function nextSlots(now: Date): string[] {
  const day = new Date(now);
  do {
    day.setDate(day.getDate() + 1);
  } while (day.getDay() === 0 || day.getDay() === 6);
  const weekday = day.toLocaleDateString("en-US", { weekday: "short" });
  return [
    [10, 0],
    [14, 30],
    [16, 0],
  ].map(([h, m]) => {
    const at = new Date(day);
    at.setHours(h!, m!, 0, 0);
    return `${weekday} ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  });
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <path d="M3.5 8.4l3 3 6-6.8" />
    </svg>
  );
}

function Shell({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <div className="chat-card w-full max-w-[300px] rounded-md bg-white p-3.5 text-[#1d1d1f] shadow-sm ring-1 ring-black/[0.07]">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold">{title}</p>
        {aside ? <p className="text-xs font-medium text-[#8e8e93]">{aside}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** The 60-second hold, as a ring running down round the seconds left. */
function HoldRing({ left, accent }: { left: number; accent: CardAccent }) {
  return (
    <span className="relative grid size-10 shrink-0 place-items-center" aria-hidden>
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r="17" fill="none" stroke="rgb(0 0 0 / 0.08)" strokeWidth="3" />
        <circle
          cx="20"
          cy="20"
          r="17"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength={1}
          className="chat-hold-ring"
          style={{ stroke: accent.bg, ["--hold" as string]: `${HOLD_SECONDS}s` }}
        />
      </svg>
      <span className="text-xs font-semibold tabular-nums">{left}</span>
    </span>
  );
}

/** The booking: a few times, one held for 60 seconds, then booked. */
export function BookingCard({ accent }: { accent: CardAccent }) {
  const slots = useMemo(() => nextSlots(new Date()), []);
  const [phase, setPhase] = useState<"pick" | "held" | "booked" | "released">("pick");
  const [slot, setSlot] = useState<string | null>(null);
  const [left, setLeft] = useState(HOLD_SECONDS);
  const [deposit, setDeposit] = useState(false);

  useEffect(() => {
    if (phase !== "held") return;
    const started = Date.now();
    const id = window.setInterval(() => {
      const remaining = HOLD_SECONDS - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) {
        setPhase("released");
        setSlot(null);
      } else {
        setLeft(remaining);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  const hold = (time: string) => {
    setSlot(time);
    setLeft(HOLD_SECONDS);
    setPhase("held");
  };

  return (
    <div className="grid gap-2">
      <Shell title={phase === "booked" ? "Booked" : "Pick a time"} aside="Google Calendar">
        {phase === "pick" || phase === "released" ? (
          <>
            {phase === "released" ? <p className="mt-1.5 text-xs text-[#6e6e73]">The hold ran out, so the time was let go.</p> : null}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {slots.map((time) => (
                <button
                  key={time}
                  type="button"
                  onClick={() => hold(time)}
                  className="chat-slot rounded-full border border-black/10 px-3 py-1.5 text-xs font-semibold transition-colors hover:border-current"
                  style={{ color: accent.bg === "var(--clinic)" ? "var(--color-ink)" : accent.bg }}
                >
                  {time}
                </button>
              ))}
            </div>
          </>
        ) : phase === "held" ? (
          <div className="mt-2.5 flex items-center gap-3">
            <HoldRing left={left} accent={accent} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{slot}</p>
              <p className="text-xs text-[#6e6e73]">Held for you while you confirm</p>
            </div>
            <button
              type="button"
              onClick={() => setPhase("booked")}
              className="shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold"
              style={{ background: accent.bg, color: accent.ink }}
            >
              Confirm
            </button>
          </div>
        ) : (
          <div className="chat-card-in mt-2.5 flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-full bg-[#e6f4ea] text-[#1e8e3e]">
              <Check />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{slot}</p>
              <p className="text-xs text-[#6e6e73]">In the clinic&rsquo;s calendar</p>
            </div>
            {!deposit ? (
              <button type="button" onClick={() => setDeposit(true)} className="shrink-0 text-xs font-semibold underline underline-offset-2">
                Deposit link
              </button>
            ) : null}
          </div>
        )}
        <p className="mt-2.5 text-xs text-[#8e8e93]">A preview: nothing is booked.</p>
      </Shell>
      {deposit ? <DepositCard accent={accent} /> : null}
    </div>
  );
}

/** The deposit link: an amount, a generic line, the clinic's own checkout. */
export function DepositCard({ accent }: { accent: CardAccent }) {
  const [phase, setPhase] = useState<"open" | "paying" | "paid">("open");

  useEffect(() => {
    if (phase !== "paying") return;
    const id = window.setTimeout(() => setPhase("paid"), 1100);
    return () => window.clearTimeout(id);
  }, [phase]);

  return (
    <div className="chat-card-in">
      <Shell title="Deposit" aside="Your checkout">
        <div className="mt-2 flex items-baseline justify-between">
          <p className="text-xs text-[#6e6e73]">Consultation deposit</p>
          <p className="text-lg font-semibold tabular-nums">$100</p>
        </div>
        {phase === "paid" ? (
          <div className="chat-card-in mt-2.5 flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-full bg-[#e6f4ea] text-[#1e8e3e]">
              <Check />
            </span>
            <p className="text-xs font-semibold">Deposit paid · slot confirmed</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPhase("paying")}
            disabled={phase === "paying"}
            className="mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-sm text-xs font-semibold disabled:opacity-80"
            style={{ background: accent.bg, color: accent.ink }}
          >
            {phase === "paying" ? <span className="chat-spinner" aria-hidden /> : null}
            {phase === "paying" ? "Opening checkout…" : "Pay deposit"}
          </button>
        )}
        <p className="mt-2.5 text-xs text-[#8e8e93]">A preview: nothing is charged.</p>
      </Shell>
    </div>
  );
}

/**
 * Whether an assistant answer gets a card under it, from what was asked
 * just before it. Asking about deposits shows the deposit link; asking about
 * booking, calendars or times shows the booking.
 */
export function cardFor(question: string): "booking" | "deposit" | null {
  if (/\b(deposits?|pay|paying|payments?|checkout|card)\b/i.test(question)) return "deposit";
  if (/\b(book\w*|calendars?|appointments?|schedul\w*|slots?|availab\w*|times?)\b/i.test(question)) return "booking";
  return null;
}
