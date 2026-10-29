import type { ChannelAction, ChannelPresentation, ChannelStatusKind } from "@/lib/setup/channel-status";
import { channelActionHref } from "@/lib/setup/channel-status";

/**
 * A channel's status as the wizard's step 4 and Settings' Channels card draw
 * it: the pill, the one sentence and, where there is one, the single button.
 * Everything comes from channelPresentation, so the two screens cannot word a
 * status differently. Static markup with no motion, so it reads the same with
 * animation off; the state is carried by a glyph and the words as well as by
 * the pill's tint, so colour is never the only signal, in light or dark.
 */

const GLYPH: Record<ChannelStatusKind, string> = {
  live: "●",
  waiting: "◐",
  paused: "❚❚",
  off: "○",
  preparing: "…",
};

export function ChannelPill({ presentation }: { presentation: Pick<ChannelPresentation, "kind" | "label"> }) {
  return (
    <>
      <span aria-hidden="true" className="mr-1 text-xs">
        {GLYPH[presentation.kind]}
      </span>
      <span
        data-channel-status={presentation.kind}
        className="bg-paper-2 text-ink inline-block max-w-full rounded-full px-2 py-0.5 text-xs font-semibold"
      >
        {presentation.label}
      </span>
    </>
  );
}

/** The one next-step button, or nothing where the step sits right beneath it. */
export function ChannelNextButton({
  surface,
  slug,
  action,
}: {
  surface: "settings" | "wizard";
  slug: string;
  action: ChannelAction | null;
}) {
  if (!action) return null;
  const href = channelActionHref(surface, slug, action);
  if (!href) return null;
  return (
    <a
      href={href}
      data-channel-action={action.step}
      className="border-line mt-2 inline-flex min-h-11 items-center rounded-full border px-5 text-sm font-semibold"
    >
      {action.label}
    </a>
  );
}
