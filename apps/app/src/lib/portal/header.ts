import {
  fallbackLine,
  pauseBanner,
  PAUSE_CHOICES,
  PAUSE_LINE_ORDER,
  type PauseChoice,
} from "@/lib/channels/pause-words";
import type { ChannelState } from "@/lib/channels/state";

/**
 * What the portal's header says about AYA (plan Part F0).
 *
 * Before go-live: "AYA isn't answering {patients|clients} yet", linking to the
 * build tracker. After it, the header's slot holds the **AYA is answering**
 * switch (`answeringControl`, drawn by PauseSwitch.tsx): turning it off
 * offers an hour, until tomorrow 8 am or until it is turned back on, with one
 * line per live channel saying what that channel does meanwhile; while
 * paused, a banner says from which device and when, and until when. The
 * pause is written by lib/channels/pause.ts.
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

/** The header's pause as clinic_settings holds it (ai_paused_at, _by_label, _until). */
export type HeaderPause = { pausedAt: Date | null; byLabel: string | null; until: Date | null };

/** The AYA is answering switch, once a channel is live and switched On. */
export type AnsweringControl = {
  paused: boolean;
  /**
   * One line per channel that answers when AYA is on (live and switched On
   * in Settings), worded from what it does while she is off: "Phone: calls go
   * to your direct line ((415) 555-0100)", "Website chat: shows a contact
   * form". A channel switched Off is already off, so a pause changes nothing
   * there and it has no line.
   */
  lines: string[];
  /** While paused: "Paused from Front desk Mac at 9:14 am, until 10:14 am." */
  banner: string | null;
  choices: readonly { id: PauseChoice; label: string }[];
};

/**
 * The switch's contents, or null where the header shows no switch: before
 * go-live, and when every live channel is switched Off in Settings (the
 * header then says so, and Settings is where they come back on).
 */
export function answeringControl(input: {
  channels: readonly ChannelState[];
  directLineE164: string | null;
  pause: HeaderPause;
  timeZone: string;
  now: Date;
}): AnsweringControl | null {
  const status = answeringStatus(input.channels);
  if (status.kind !== "answering" && status.kind !== "paused") return null;
  const answering = input.channels
    .filter((c) => c.status === "live" || c.status === "paused")
    .sort((a, b) => PAUSE_LINE_ORDER.indexOf(a.channel) - PAUSE_LINE_ORDER.indexOf(b.channel));
  const paused = status.kind === "paused";
  return {
    paused,
    lines: answering.map((c) => fallbackLine(c.channel, input.directLineE164)),
    banner:
      paused && input.pause.pausedAt
        ? pauseBanner(
            { pausedAt: input.pause.pausedAt, byLabel: input.pause.byLabel, until: status.until },
            input.timeZone,
            input.now,
          )
        : null,
    choices: PAUSE_CHOICES,
  };
}
