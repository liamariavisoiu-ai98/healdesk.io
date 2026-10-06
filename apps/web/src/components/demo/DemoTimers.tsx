"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The two clocks on a personalised demo page.
 *
 * `DemoCountdown` is the top banner's one-week timer. It counts to the same
 * `expires_at` the API routes refuse after, and when it reaches zero it asks
 * the server to re-render, so the page turns into the archived state at the
 * moment the demo actually stops working rather than on the next visit.
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

export function DemoCountdown({ expiresAt }: { expiresAt: string }) {
  const router = useRouter();
  const end = new Date(expiresAt).getTime();
  // Rendered on the server first: start from null so the server and the
  // first client render agree, then tick.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
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

  const { days, hours, minutes, seconds } = parts(end - (now ?? end - 7 * 86_400_000));
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
