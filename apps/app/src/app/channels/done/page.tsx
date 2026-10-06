import type { Metadata } from "next";

/**
 * Where a successful connect lands. The link is spent by now, so this page
 * holds no token and authenticates nothing: what it shows comes from the
 * query string the connect route wrote — the Page name, the Instagram handle,
 * the number — which is the clinic's own business data, and rendering it
 * proves nothing to anyone. Someone who types their own query string here
 * sees their own words.
 *
 * It says what is connected and what still decides whether patients reach
 * the assistant, rather than declaring the channel "live" (v1 spec: "No
 * channel is ever shown as live before it is").
 */

export const metadata: Metadata = {
  title: "Connected",
  robots: { index: false, follow: false },
};

export default async function ChannelsDonePage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; page?: string; instagram?: string; number?: string }>;
}) {
  const { channel, page, instagram, number } = await searchParams;
  const whatsapp = channel === "whatsapp";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        {whatsapp ? "WhatsApp is connected" : "Facebook is connected"}
      </h1>

      {whatsapp ? (
        <>
          <p className="mt-4 text-[15px]">
            WhatsApp connected{number ? <>: <span className="font-semibold">{number}</span></> : null}.
          </p>
          <p className="mt-3 text-[15px] text-[color:var(--color-muted)]">
            If you haven&apos;t added a card to your WhatsApp account in Meta yet, do that next: until then the number can
            receive messages but cannot reply.
          </p>
        </>
      ) : (
        <>
          <p className="mt-4 text-[15px]">
            Facebook Page connected{page ? <>: <span className="font-semibold">{page}</span></> : null}.
          </p>
          {instagram !== undefined ? (
            <p className="mt-2 text-[15px]">
              Instagram connected{instagram ? <>: <span className="font-semibold">@{instagram}</span></> : null}.
            </p>
          ) : (
            <p className="mt-3 text-[15px] text-[color:var(--color-muted)]">
              No Instagram account is linked to this Page, so only Facebook messages are connected. To add Instagram, switch
              it to a professional account, link it to this Page, and ask us for a new link.
            </p>
          )}
          {instagram !== undefined ? (
            <p className="mt-3 text-[15px] text-[color:var(--color-muted)]">
              One check on Instagram: Settings → Messages and story replies → Message controls → Connected tools → Allow
              access to messages must be on, or messages cannot reach your assistant.
            </p>
          ) : null}
        </>
      )}

      <p className="mt-6 text-[15px] text-[color:var(--color-muted)]">
        You can close this page. Anything you connect stays connected if you come back with a new link for another channel.
      </p>
    </main>
  );
}
