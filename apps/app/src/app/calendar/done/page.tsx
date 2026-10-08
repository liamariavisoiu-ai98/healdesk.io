import type { Metadata } from "next";

/**
 * Where a calendar sign-in or a link request ends when there is no link page
 * left to show: the link was spent, the sign-in's state did not check out,
 * or a new link was asked for. It holds no token and authenticates nothing,
 * and it prints nothing from its query but a word it recognises, so a
 * crafted URL cannot put a sentence under our name.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your Google Calendar",
  robots: { index: false, follow: false },
};

const COPY: Record<string, { title: string; body: string }> = {
  connected: {
    title: "Your Google Calendar is connected",
    body: "Your assistant books into it from now on, as your calendar terms allow. You can close this page.",
  },
  already_connected: {
    title: "This link was already used",
    body: "A calendar was connected with it. If that wasn't you, reply to the email that brought you here.",
  },
  reissued: {
    title: "Check the practice's inbox",
    body: "If that was a recent calendar link, we've emailed a new one to the practice's calendar contacts.",
  },
  expired: {
    title: "This link has expired or has already been used",
    body: "Open the newest calendar link the practice was sent, or reply to the email that brought you here and we'll send another.",
  },
};

const FALLBACK = {
  title: "Your calendar wasn't connected",
  body: "Nothing was stored. Open the calendar link again to try once more, or reply to the email that brought you here.",
};

export default async function CalendarDonePage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string | string[] }>;
}) {
  const { outcome } = await searchParams;
  const copy =
    typeof outcome === "string" && Object.prototype.hasOwnProperty.call(COPY, outcome)
      ? COPY[outcome]!
      : FALLBACK;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        {copy.title}
      </h1>
      <p className="mt-4 text-[15px]">{copy.body}</p>
    </main>
  );
}
