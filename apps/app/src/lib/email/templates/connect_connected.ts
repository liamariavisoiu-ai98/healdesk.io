import type { NoticePayloads } from "@/lib/billing/notices";

import { momentLong, portalUrl } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O14: payments connected (Annex X5), Package D's Stripe Connect.
 *
 * Connecting is also a security event, so the email says when, how, and what
 * to do if nobody at the clinic did it. Deposits go into the clinic's own
 * Stripe account (Connect Standard), and only from chat: the voice agent
 * cannot send a link, so a phone deposit is left to staff (spec, "Booking and
 * payment"). Deposits also need Take deposits switched on with an amount,
 * which connecting alone does not do, so the one action is checking those
 * settings.
 */

export type ConnectConnectedPayload = NoticePayloads["connect_connected"];

const HOW: Record<ConnectConnectedPayload["source"], string> = {
  portal: "from your healdesk account",
  ops: "through a connection link from the healdesk team",
  stripe: "from Stripe",
};

export const renderConnectConnected: EmailTemplate<ConnectConnectedPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Stripe is connected to healdesk for deposits",
      preheader: "AYA can send deposit links paid into your own Stripe account.",
      blocks: [
        {
          type: "paragraph",
          text: `Your Stripe account was connected to healdesk at ${momentLong(payload.connectedAt, ctx)}, ${HOW[payload.source]}.`,
        },
        {
          type: "paragraph",
          text: "AYA can now send deposit links in chat, paid straight into your own Stripe account. On the phone she can't send a link, so deposits there are left to your team.",
        },
        {
          type: "paragraph",
          text: "Deposits start once Take deposits is on in Settings, under Payments, with an amount set.",
        },
        { type: "action", label: "Check your deposit settings", url: portalUrl() },
        {
          type: "paragraph",
          text: "If nobody at your clinic connected it, reply to this email now.",
        },
      ],
    },
    ctx,
  );

export const CONNECT_CONNECTED_ENTRY: TemplateEntry<ConnectConnectedPayload> = {
  render: renderConnectConnected,
  fixture: { connectedAt: "2026-10-06T14:20:00.000Z", source: "portal" },
};
