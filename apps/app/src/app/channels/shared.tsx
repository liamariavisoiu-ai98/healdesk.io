import type { ReactNode } from "react";

/**
 * What every channel-connect page shares: the frame, and the throttle notice.
 *
 * These pages follow the token-page rules of app/connect/[token]/page.tsx: the
 * token is the whole authentication, the open is rate-limited before the token
 * is examined, every failure is the same redirect to /channels/invalid, and
 * opening does not spend the link. What they show is business data only — the
 * clinic's name and the names of its own Page, account and number.
 */
export function ChannelFrame({ clinicName, title, children }: { clinicName: string; title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk · {clinicName}</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
      {children}
      <p className="mt-10 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        Something doesn&apos;t look right? Reply to the email that brought you here, or write to{" "}
        <a href="mailto:hello@healdesk.io" className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2">
          hello@healdesk.io
        </a>
        . This link works once, and stops working the moment the connection is saved.
      </p>
    </main>
  );
}

export function Throttled() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">Give it a minute</h1>
      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        This page has been opened a lot in a short space of time, so we&apos;ve paused it briefly. Nothing is wrong with your
        link and nothing has been lost. Wait a few minutes and open it again.
      </p>
    </main>
  );
}

export function Notice({ tone, children }: { tone: "problem" | "info"; children: ReactNode }) {
  const border = tone === "problem" ? "border-[color:var(--color-ink)]" : "border-[color:var(--color-line)]";
  return <div className={`mt-6 rounded-sm border ${border} px-4 py-3 text-[15px]`}>{children}</div>;
}
