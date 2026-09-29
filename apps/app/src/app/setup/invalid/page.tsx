import type { Metadata } from "next";

/**
 * Where every failed setup link ends up. Expired, used, unknown, malformed,
 * or issued for the other page — one page, told nothing. See
 * /connect/invalid for the reasoning; it is the same page with a different
 * subject line in the mailto.
 */
export const metadata: Metadata = {
  title: "This link is no longer valid",
  description: "Ask us for a new setup link.",
  robots: { index: false, follow: false },
};

export default function SetupInvalidPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        This link is no longer valid
      </h1>
      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        Setup links are good for one use, so this one may simply have done its job already. Either way, nothing is
        wrong on your side and nothing is lost. If nobody confirmed before it expired, the set we chose for your kind
        of practice applies, and you can change it at any time by telling us.
      </p>
      <p className="mt-6 text-[15px]">
        Reply to the email that brought you here, or write to{" "}
        <a href="mailto:hello@healdesk.io?subject=New%20setup%20link" className="font-semibold underline underline-offset-2">
          hello@healdesk.io
        </a>{" "}
        and ask for a new setup link.
      </p>
    </main>
  );
}
