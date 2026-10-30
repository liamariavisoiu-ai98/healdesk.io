import { publicUrl } from "@/lib/public-url";

import { counted, momentLong } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L17 and L18, the outage pair (Annex X5): one pair per incident, both
 * critical, to the clinic's one address, from the outbox. Plain words, no
 * mechanics, one Open Home button (owner, 29 October 2026).
 *
 *   - L17 is the owner's own text: AYA has not been able to answer since
 *     {when}, due to a connectivity error (always, whatever the underlying
 *     cause: AYA disconnects; owner, 29 October 2026); we are working on it
 *     and will email the moment it is fixed.
 *   - L18: AYA is answering again as of {when}, everything working normally;
 *     then, only when something reached the clinic meanwhile, one sentence
 *     with the two counts.
 *
 * Payloads are the minimum: instants and two counts. The plan declared none.
 */

export type OutageStartedPayload = {
  /** When AYA stopped answering (ISO instant). */
  startedAt: string;
  /** Calls are ringing through to a usable direct line. */
  canReachDirectLine: boolean;
  /** Website chat is among what stopped: visitors see the contact form. */
  isChatAffected: boolean;
  /** publicUrl("/c/<slug>"): Home. */
  homeUrl: string;
};

export type OutageEndedPayload = {
  /** When AYA began answering again (ISO instant). */
  endedAt: string;
  /** Calls that rang through to the clinic's direct line while AYA was away. */
  callCount: number;
  /** People who tried to chat (website, Instagram, Messenger, WhatsApp) meanwhile. */
  chatCount: number;
  /** publicUrl("/c/<slug>"): Home, the button when nothing came in. */
  homeUrl: string;
  /** The portal's list of what came in meanwhile, the button when something did. */
  missedUrl: string;
};

export const renderOutageStarted: EmailTemplate<OutageStartedPayload> = (payload, ctx) => {
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA hasn't been able to answer since ${momentLong(payload.startedAt, ctx)} due to a connectivity error. We're working on it now.`,
    },
  ];
  if (payload.canReachDirectLine) {
    blocks.push({
      type: "paragraph",
      text: "In the meantime, calls are ringing through to your direct line, so please keep it staffed.",
    });
  }
  if (payload.isChatAffected) {
    blocks.push({
      type: "paragraph",
      text: "Website chat visitors are being shown your contact form.",
    });
  }
  blocks.push(
    { type: "paragraph", text: "We'll email you the moment it's fixed." },
    { type: "action", label: "Open Home", url: payload.homeUrl },
  );
  return compose(
    {
      subject: "AYA can't answer right now",
      preheader: "We're working on it now.",
      blocks,
    },
    ctx,
  );
};

export const renderOutageEnded: EmailTemplate<OutageEndedPayload> = (payload, ctx) => {
  const parts: string[] = [];
  if (payload.callCount > 0) {
    parts.push(`${counted(payload.callCount, "call", "calls")} rang through to your direct line`);
  }
  if (payload.chatCount > 0) {
    parts.push(
      payload.chatCount === 1
        ? "1 person tried to chat"
        : `${payload.chatCount.toLocaleString("en-US")} people tried to chat`,
    );
  }
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA has been answering again since ${momentLong(payload.endedAt, ctx)}.`,
    },
    {
      type: "paragraph",
      text:
        parts.length > 0
          ? `While she was away, ${parts.join(" and ")}.`
          : "Everything is working normally.",
    },
    parts.length > 0
      ? { type: "action", label: "See what came in", url: payload.missedUrl }
      : { type: "action", label: "Open Home", url: payload.homeUrl },
  ];
  return compose(
    {
      subject: "AYA is answering again",
      preheader:
        parts.length > 0
          ? "Here's what came in while she was away."
          : "Everything is working normally.",
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
      canReachDirectLine: true,
      isChatAffected: false,
      homeUrl: publicUrl("/c/radiance-med-spa"),
    };
  },
};

export const OUTAGE_ENDED_ENTRY: TemplateEntry<OutageEndedPayload> = {
  render: renderOutageEnded,
  get fixture(): OutageEndedPayload {
    return {
      endedAt: "2026-10-06T13:52:00Z",
      callCount: 4,
      chatCount: 2,
      homeUrl: publicUrl("/c/radiance-med-spa"),
      missedUrl: publicUrl("/c/radiance-med-spa/missed"),
    };
  },
};
