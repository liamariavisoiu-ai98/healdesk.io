import type { Metadata } from "next";

/**
 * Where every failed channel link ends up: expired, used, unknown, malformed,
 * issued for the other page, or a Facebook return this browser did not start.
 * One page, told nothing — see /connect/invalid for the reasoning.
 */
export const metadata: Metadata = {
  title: "This link is no longer valid",
  description: "Ask us for a new link to connect your channels.",
  robots: { index: false, follow: false },
};

export default function ChannelsInvalidPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        This link is no longer valid
      </h1>
      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        Links to connect your channels are good for one use, so this one may simply have done its job already. Either way,
        nothing is wrong on your side, and anything you already connected stays connected.
      </p>
      <p className="mt-6 text-[15px]">
        Reply to the email that brought you here, or write to{" "}
        <a href="mailto:hello@healdesk.io?subject=New%20channel%20link" className="font-semibold underline underline-offset-2">
          hello@healdesk.io
        </a>{" "}
        and ask for a new link.
      </p>
    </main>
  );
}
