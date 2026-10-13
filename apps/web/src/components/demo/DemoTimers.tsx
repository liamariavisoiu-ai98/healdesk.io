"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The clocks on a personalised demo page.
 *
 * `DemoCountdown` is the top banner's one-week timer. It counts to the same
 * `expires_at` the API routes refuse after, and when it reaches zero it asks
 * the server to re-render, so the page turns into the archived state at the
 * moment the demo actually stops working rather than on the next visit. The
 * setup offer's 48-hour clock is the same component counting to the offer's
 * end, so its promise comes down the moment checkout stops honouring it.
 *
 * `RefreshWhileBuilding` re-renders a page whose demo is still being built,
 * every few seconds, until the server says otherwise.
 */

function parts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

export function DemoCountdown({
  expiresAt,
  spanMs = 7 * 86_400_000,
}: {
  expiresAt: string;
  /** The clock's whole length, which it reads before its first tick: the demo's week unless told otherwise. */
  spanMs?: number;
}) {
  const router = useRouter();
  const end = new Date(expiresAt).getTime();
  // Rendered on the server first: start from null so the server and the
  // first client render agree, then tick.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // This effect subscribes to the browser's clock, and it takes the first
    // reading as it subscribes. Left to the first tick, the banner would claim
    // the clock's full length for a second after it mounts, whatever is really left.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first clock reading, at mount
    setNow(Date.now());
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) {
        window.clearInterval(id);
        router.refresh();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [end, router]);

  const { days, hours, minutes, seconds } = parts(end - (now ?? end - spanMs));
  const cell = (value: number, label: string) => (
    <span className="inline-flex items-baseline gap-0.5">
      <span className="font-display tabular-nums text-[17px] font-semibold">{value.toString().padStart(2, "0")}</span>
      <span className="text-[12px] font-bold opacity-75">{label}</span>
    </span>
  );

  return (
    <span className="inline-flex items-center gap-2" suppressHydrationWarning>
      {cell(days, "d")}
      {cell(hours, "h")}
      {cell(minutes, "m")}
      {cell(seconds, "s")}
    </span>
  );
}

export function RefreshWhileBuilding({ everyMs = 6_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs, router]);
  return null;
}

/**
 * Copy this demo's link, for an owner forwarding it to a partner or their
 * front desk. The address bar's own URL, so a link opened on a preview or a
 * custom domain copies as itself.
 */
export function CopyDemoLink({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href.split("#")[0]!).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2_000);
        });
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border border-current/30 px-3 py-1 text-[13.2px] font-bold transition-opacity hover:opacity-80 ${className}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5" aria-hidden>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </svg>
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}
