import { counted, momentLong } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L17 and L18, the outage pair (Annex X5): one pair per incident, both
 * critical, to the clinic's one address, from the outbox. Plain words, no
 * mechanics, no button (owner's revision, 29 October 2026).
 *
 *   - L17 is the owner's own text: AYA has not been able to answer since
 *     {when}, because of a fault at healdesk or one of our suppliers; we are
 *     working on it and will keep the clinic updated.
 *   - L18: AYA is answering again as of {when}, everything working normally;
 *     then, only when something reached the clinic meanwhile, one sentence
 *     with the two counts.
 *
 * Payloads are the minimum: instants and two counts. The plan declared none.
 */

export type OutageStartedPayload = {
  /** When AYA stopped answering (ISO instant). */
  startedAt: string;
};

export type OutageEndedPayload = {
  /** When AYA began answering again (ISO instant). */
  endedAt: string;
  /** Calls that rang through to the clinic's direct line while AYA was away. */
  callCount: number;
  /** People who tried to chat (website, Instagram, Messenger, WhatsApp) meanwhile. */
  chatCount: number;
};

export const renderOutageStarted: EmailTemplate<OutageStartedPayload> = (payload, ctx) =>
  compose(
    {
      subject: "AYA can't answer right now",
      preheader: "A fault on our side. We're working on it.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA has not been able to answer since ${momentLong(payload.startedAt, ctx)}, because of a fault at healdesk or one of our suppliers. We are working on it and will keep you updated as soon as it is resolved.`,
        },
      ],
    },
    ctx,
  );

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
      text: `AYA is answering again as of ${momentLong(payload.endedAt, ctx)}. Everything is working normally.`,
    },
  ];
  if (parts.length > 0) {
    blocks.push({ type: "paragraph", text: `While she was away, ${parts.join(" and ")}.` });
  }
  return compose(
    {
      subject: "AYA is answering again",
      preheader: "Everything is working normally.",
      blocks,
    },
    ctx,
  );
};

export const OUTAGE_STARTED_ENTRY: TemplateEntry<OutageStartedPayload> = {
  render: renderOutageStarted,
  fixture: { startedAt: "2026-10-06T13:04:00Z" },
};

export const OUTAGE_ENDED_ENTRY: TemplateEntry<OutageEndedPayload> = {
  render: renderOutageEnded,
  fixture: { endedAt: "2026-10-06T13:52:00Z", callCount: 4, chatCount: 2 },
};
