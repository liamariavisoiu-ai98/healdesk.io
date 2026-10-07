"use client";

import { ScreenShell } from "../ScreenShell";

/**
 * Step 4 · Your channels (plan Part E): each bought channel with its status
 * word and what it needs, never a date. Phone shows no number and no
 * forwarding codes until voice is ready for the clinic: nobody forwards
 * calls to an assistant that cannot answer yet (spec, "The forwarding step").
 * A ready channel's one step (the website line, the forwarding, the Facebook
 * login) is named here in words; the screen that carries it out comes with
 * the channel itself, so this one links to none yet.
 */

export type ChannelRow = {
  channel: "web" | "meta" | "voice";
  name: string;
  /** The status word, without a date. */
  status: string;
  /** What happens next, in one or two sentences. */
  line: string;
};

export function ChannelsScreen(props: {
  slug: string;
  backHref: string | null;
  rows: readonly ChannelRow[];
  callBookingUrl: string | null;
}) {
  const phone = props.rows.some((row) => row.channel === "voice");
  return (
    <ScreenShell
      slug={props.slug}
      screen="channels"
      title="Your channels"
      intro={<p>Where each channel you bought stands, and what it needs from you.</p>}
      skipCost=""
      skippable={false}
      backHref={props.backHref}
      submitLabel="Done"
      payload={() => ({})}
    >
      <ul className="grid gap-3">
        {props.rows.map((row) => (
          <li key={row.channel} className="rounded-xl border border-line bg-white px-4 py-3">
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{row.name}</span>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-paper-2 px-3 py-1 text-xs font-semibold">
                {row.status}
              </span>
            </p>
            <p className="text-muted mt-1 text-sm">{row.line}</p>
          </li>
        ))}
      </ul>
      {phone && props.callBookingUrl ? (
        <p className="text-sm">
          When phone is ready, setting call forwarding is easier with someone on the line.{" "}
          <a
            href={props.callBookingUrl}
            className="font-semibold underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Book a five-minute call and we&rsquo;ll do it with you
          </a>
          .
        </p>
      ) : null}
    </ScreenShell>
  );
}
