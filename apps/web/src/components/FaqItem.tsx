"use client";

import { useRef, type ReactNode } from "react";

/**
 * One question of the FAQ, opening and closing smoothly (owner, 12 October
 * 2026: the answers snapped open).
 *
 * Still a native <details>: keyboard-operable, announced as a disclosure, and
 * opened by the browser's own find-in-page, which never goes through the
 * click handler here and simply opens it. Only a click on the summary is
 * taken over, to run the height between closed and open on the shared slow
 * duration rather than in one frame: opening sets `open` first and grows the
 * answer from nothing, closing shrinks it and sets `open` last. With reduced
 * motion, or before this has hydrated, the click is the browser's own.
 */
/**
 * A CSS time in milliseconds. The built stylesheet writes the tokens in
 * whichever unit is shorter, so `480ms` arrives as `.48s`: read as a bare
 * number that was half a millisecond, and the answer snapped open.
 */
function toMs(time: string): number {
  const value = parseFloat(time);
  return time.trim().endsWith("ms") ? value : value * 1000;
}

export function FaqItem({ question, children }: { question: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const running = useRef<Animation | null>(null);

  const onClick = (event: React.MouseEvent) => {
    const d = details.current;
    const b = body.current;
    if (!d || !b || typeof b.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();

    const tokens = getComputedStyle(document.documentElement);
    const duration = toMs(tokens.getPropertyValue("--duration-slow")) || 480;
    const easing = tokens.getPropertyValue("--ease-out").trim() || "ease-out";

    const from = running.current ? b.getBoundingClientRect().height : null;
    running.current?.cancel();

    const closing = d.open && d.dataset.closing !== "true";
    if (!closing) {
      d.dataset.closing = "false";
      d.open = true;
      const to = b.scrollHeight;
      running.current = b.animate(
        [
          { height: `${from ?? 0}px`, opacity: from === null ? 0 : 1 },
          { height: `${to}px`, opacity: 1 },
        ],
        { duration, easing },
      );
      running.current.onfinish = () => {
        running.current = null;
      };
    } else {
      d.dataset.closing = "true";
      running.current = b.animate(
        [
          { height: `${from ?? b.getBoundingClientRect().height}px`, opacity: 1 },
          { height: "0px", opacity: 0 },
        ],
        { duration: duration * 0.75, easing },
      );
      running.current.onfinish = () => {
        d.open = false;
        d.dataset.closing = "false";
        running.current = null;
      };
    }
  };

  return (
    <details ref={details} className="group border-line border-b py-5 first:border-t">
      <summary onClick={onClick} className="flex cursor-pointer list-none items-start gap-4 [&::-webkit-details-marker]:hidden">
        <span className="font-display flex-1 text-[21.6px] leading-snug font-medium tracking-[-0.015em]">{question}</span>
        <span
          aria-hidden
          className="text-red-deep mt-0.5 shrink-0 text-[21.6px] leading-none transition-transform duration-slow ease-out group-open:rotate-45 group-data-[closing=true]:rotate-0!"
        >
          +
        </span>
      </summary>
      <div ref={body} className="overflow-hidden">
        {children}
      </div>
    </details>
  );
}
