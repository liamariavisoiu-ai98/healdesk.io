import type { Metadata } from "next";

/**
 * Where a finished setup link ends up. Static, names nothing, looks nothing
 * up — the same shape and the same reasons as /connect/done.
 */
export const metadata: Metadata = {
  title: "All set",
  description: "Your assistant knows what to ask for.",
  robots: { index: false, follow: false },
};

export default function SetupDonePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance text-[color:var(--color-green)] sm:text-3xl">
        All set
      </h1>
      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        Your assistant will ask for exactly what you chose, and nothing clinical. The one-time link has now expired;
        there is no account or login.
      </p>
      <p className="mt-4 text-sm text-[color:var(--color-muted)]">
        To change it later, reply to the email that brought you here, or write to{" "}
        <a href="mailto:hello@healdesk.io" className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2">
          hello@healdesk.io
        </a>
        .
      </p>
    </main>
  );
}
