import type { ChannelState } from "@/lib/channels/state";

/**
 * What the portal's header says about AYA (plan Part F0).
 *
 * Before go-live: "AYA isn't answering {patients|clients} yet", linking to the
 * build tracker. After it, the header's slot holds the **AYA is answering**
 * switch, with its pause durations and the "Paused from Front desk Mac at
 * 9:14" banner; that control is M6's (it needs the go-live events and L15).
 * Until M6 the slot states where things stand and offers no control, because
 * a switch that did nothing would be the worst kind of dead end.
 *
 * Pure, over the channel states lib/channels/state.ts reads.
 */
export type AnsweringStatus =
  /** No channel has gone live: nothing reaches patients yet. */
  | { kind: "not_yet" }
  | { kind: "answering" }
  /** The header's pause holds; `until` null means until someone turns AYA back on. */
  | { kind: "paused"; until: Date | null }
  /** Every channel that has gone live is switched Off in Settings. */
  | { kind: "off" };

export function answeringStatus(channels: readonly ChannelState[]): AnsweringStatus {
  const live = channels.filter((c) => c.liveAt !== null);
  if (live.length === 0) return { kind: "not_yet" };
  // The pause is clinic-wide, so every paused channel carries the same end.
  const paused = live.find((c) => c.status === "paused");
  if (paused) return { kind: "paused", until: paused.pausedUntil };
  if (live.some((c) => c.status === "live")) return { kind: "answering" };
  return { kind: "off" };
}
