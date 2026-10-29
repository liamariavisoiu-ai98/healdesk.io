import { CHANNELS, type Channel } from "@healdesk/catalog";

import { fallbackLine } from "@/lib/channels/pause-words";
import { publicUrl } from "@/lib/public-url";

import { counted, momentLong } from "./billing-copy";
import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L17 and L18, the outage pair (Annex X5): one pair per incident, both
 * critical, to the clinic's one address, from the outbox.
 *
 *   - L17 "Calls are going to your direct line": our system or a vendor has
 *     failed for 10 minutes. Worded from what each affected channel really
 *     does meanwhile (the same lines L15 gives, lib/channels/pause-words.ts),
 *     so the two never disagree. Calm and short: what is happening, since
 *     when, where calls and chats go, and that a second email follows.
 *   - L18 "AYA is answering again": the incident ended. It gives how many
 *     calls and chats went to the clinic meanwhile, and nothing else.
 *
 * The plan did not declare the payloads (they were `never` while the
 * runtime's routed/answered counter was unbuilt), so these are the minimal
 * set: instants, channel ids, counts and one portal link. Nothing a patient
 * said or did can be typed into them, and lib/email/lint.ts refuses any key
 * outside its allowlist at send time. The link opens Home behind sign-in.
 */

export type OutageStartedPayload = {
  /** When AYA stopped answering (ISO instant). */
  startedAt: string;
  /** The channels the incident stopped. */
  channels: Channel[];
  /** The clinic's direct line, for phone's line; null when none is set. */
  directLineE164: string | null;
  /** publicUrl("/c/<slug>"): Home. */
  homeUrl: string;
};

export type OutageEndedPayload = {
  startedAt: string;
  /** When AYA began answering again (ISO instant). */
  endedAt: string;
  /** Calls that went to the clinic's direct line meanwhile. */
  callCount: number;
  /** Chats and messages that went to the clinic meanwhile. */
  chatCount: number;
  homeUrl: string;
};

function knownChannels(channels: readonly Channel[]): Channel[] {
  const known = channels.filter((c) => (CHANNELS as readonly string[]).includes(c));
  if (known.length === 0) {
    throw new EmailCompositionError("An outage email needs the channels it concerns.");
  }
  return known;
}

export const renderOutageStarted: EmailTemplate<OutageStartedPayload> = (payload, ctx) => {
  const channels = knownChannels(payload.channels);
  const since = momentLong(payload.startedAt, ctx);
  const voice = channels.includes("voice");
  return compose(
    {
      subject: voice ? "Calls are going to your direct line" : "AYA isn't answering right now",
      preheader: "A fault on our side. We'll email you again when she's back.",
      blocks: [
        {
          type: "paragraph",
          text: `Since ${since}, AYA hasn't been answering, because of a fault at healdesk or one of our suppliers.`,
        },
        { type: "paragraph", text: "Meanwhile:" },
        {
          type: "list",
          items: channels.map((c) => fallbackLine(c, payload.directLineE164)),
        },
        { type: "paragraph", text: "We'll email you again as soon as she's answering." },
        { type: "action", label: "Open Home", url: payload.homeUrl },
      ],
    },
    ctx,
  );
};

export const renderOutageEnded: EmailTemplate<OutageEndedPayload> = (payload, ctx) => {
  const none = payload.callCount === 0 && payload.chatCount === 0;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA has been answering again since ${momentLong(payload.endedAt, ctx)}. She wasn't answering from ${momentLong(payload.startedAt, ctx)}.`,
    },
    none
      ? { type: "paragraph", text: "No calls or chats came in meanwhile." }
      : {
          type: "facts",
          rows: [
            ["Calls sent to your direct line", counted(payload.callCount, "call", "calls")],
            ["Chats sent to your team", counted(payload.chatCount, "chat", "chats")],
          ],
        },
    { type: "action", label: "Open Home", url: payload.homeUrl },
  ];
  return compose(
    {
      subject: "AYA is answering again",
      preheader: none
        ? "Nothing came in while she was away."
        : "Here's what reached your team meanwhile.",
      blocks,
    },
    ctx,
  );
};

export const OUTAGE_STARTED_ENTRY: TemplateEntry<OutageStartedPayload> = {
  render: renderOutageStarted,
  get fixture(): OutageStartedPayload {
    return {
      startedAt: "2026-10-06T13:04:00Z",
      channels: ["voice", "web"],
      directLineE164: "+14155550100",
      homeUrl: publicUrl("/c/radiance-med-spa"),
    };
  },
};

export const OUTAGE_ENDED_ENTRY: TemplateEntry<OutageEndedPayload> = {
  render: renderOutageEnded,
  get fixture(): OutageEndedPayload {
    return {
      startedAt: "2026-10-06T13:04:00Z",
      endedAt: "2026-10-06T13:52:00Z",
      callCount: 4,
      chatCount: 2,
      homeUrl: publicUrl("/c/radiance-med-spa"),
    };
  },
};
