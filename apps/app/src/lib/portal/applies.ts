import { CHANNELS, type Channel } from "@healdesk/catalog";

import type { ChannelState } from "@/lib/channels/state";

/**
 * "Applies when {channel} opens" (plan Part F2): what a switch says when the
 * channels it governs are not answering yet, so a clinic setting things up
 * before go-live is never told a change took effect "from now on" when
 * nothing is answering anyone.
 *
 * A switch governs some of the clinic's bought channels: tone governs every
 * one, the phone greeting only phone, promotions phone and website chat. The
 * line names the governed channels that have not gone live, and disappears
 * once any of them is answering, because from then on the change applies on
 * that channel at once.
 */

/** The channels as a sentence names them: "website chat", "phone". */
export const CHANNEL_WORDS: Readonly<Record<Channel, string>> = {
  web: "website chat",
  voice: "phone",
  meta: "Instagram, Messenger & WhatsApp",
};

/** Website chat, then phone, then the Meta channels, whose own name has commas in it. */
const SENTENCE_ORDER: readonly Channel[] = ["web", "voice", "meta"];

export function appliesWhen(
  states: readonly Pick<ChannelState, "channel" | "liveAt">[],
  governs: readonly Channel[] = CHANNELS,
): string | null {
  const bought = states.filter((s) => governs.includes(s.channel));
  if (bought.length === 0 || bought.some((s) => s.liveAt !== null)) return null;
  const names = SENTENCE_ORDER.filter((c) => bought.some((s) => s.channel === c)).map(
    (c) => CHANNEL_WORDS[c],
  );
  const plural = names.length > 1 || bought[0]!.channel === "meta";
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Applies when ${list} ${plural ? "open" : "opens"}.`;
}
