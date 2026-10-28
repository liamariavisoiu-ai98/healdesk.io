import type { NoticePayloads } from "@/lib/billing/notices";

import { momentLong, portalUrl } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O14: payments disconnected (Annex X5), Package D's Stripe Connect. It is
 * also the security record of the disconnection (contracts §5).
 *
 * What changed: deposits are off, and bookings still waiting on a deposit
 * are flagged in Bookings for the front desk (the disconnect cascade, R23).
 * What it says about links already sent depends on whether every one was
 * settled. A link Stripe expired, or found paid, can no longer take money.
 * One we could not check (Stripe revoked our access before we could look, or
 * the expiry and the look both failed) stays payable until it lapses, within
 * 24 hours of being sent, so the email tells staff to check Stripe before
 * collecting rather than that the link is dead: told it was dead, they would
 * collect a deposit the patient may already have paid (R23's "may have been
 * paid; check Stripe before collecting").
 *
 * When the disconnect also set back full payment or the payment-link text
 * (lib/portal/switch-resets.ts), this email says so in one more paragraph,
 * so the clinic gets one email, not this and the reset email. With neither
 * on, the email is exactly as it was.
 *
 * What to do depends on who did it: a disconnection from Stripe's side may
 * not have been meant, so that one offers to connect again; one from the
 * portal or by our team asks the clinic to reply only if it was not expected.
 */

export type ConnectDisconnectedPayload = NoticePayloads["connect_disconnected"];

export const renderConnectDisconnected: EmailTemplate<ConnectDisconnectedPayload> = (
  payload,
  ctx,
) => {
  const fromStripe = payload.wasByWebhook || payload.source === "stripe";
  const how = fromStripe
    ? "from your Stripe account"
    : payload.source === "ops"
      ? "by the healdesk team"
      : "from your healdesk account";

  const next: Block[] = fromStripe
    ? [
        {
          type: "paragraph",
          text: "If you didn't mean to disconnect it, connect Stripe again in Settings, under Payments.",
        },
        { type: "action", label: "Connect Stripe again", url: portalUrl() },
      ]
    : [
        {
          type: "paragraph",
          text:
            payload.source === "ops"
              ? "If you weren't expecting this, reply to this email."
              : "If nobody at your clinic disconnected it, reply to this email now.",
        },
      ];

  return compose(
    {
      subject: "Stripe was disconnected from healdesk",
      preheader: "Deposits are off until Stripe is connected again.",
      blocks: [
        {
          type: "paragraph",
          text: `Your Stripe account was disconnected from healdesk at ${momentLong(payload.disconnectedAt, ctx)}, ${how}.`,
        },
        {
          type: "paragraph",
          text: payload.hasUncheckedLinks
            ? "Deposits are now off, so AYA no longer sends deposit links, and the bookings still waiting on a deposit are flagged in Bookings for your team. Links she had already sent may still be paid until they expire, within 24 hours, so check your Stripe account before collecting a deposit for one of those bookings."
            : "Deposits are now off, so AYA no longer sends deposit links. Links she had already sent that weren't paid have stopped working, and those deposits are flagged in Bookings for your team to collect.",
        },
        ...resetBlocks(payload.resetSwitchIds),
        ...next,
      ],
    },
    ctx,
  );
};

const RESET_SENTENCES: Readonly<Record<"full_payment" | "text_payment_link", string>> = {
  full_payment: "AYA asks patients for a deposit only, not the full price.",
  text_payment_link: "Texting the payment link is off.",
};

function resetBlocks(ids: ConnectDisconnectedPayload["resetSwitchIds"]): Block[] {
  const sentences = (ids ?? []).filter((id) => id in RESET_SENTENCES).map((id) => RESET_SENTENCES[id]);
  if (sentences.length === 0) return [];
  return [
    {
      type: "paragraph",
      text: `${sentences.join(" ")} You can turn ${sentences.length === 1 ? "it" : "them"} on again in Settings once Stripe is connected.`,
    },
  ];
}

export const CONNECT_DISCONNECTED_ENTRY: TemplateEntry<ConnectDisconnectedPayload> = {
  render: renderConnectDisconnected,
  fixture: {
    disconnectedAt: "2026-10-06T14:20:00.000Z",
    wasByWebhook: true,
    source: "stripe",
    hasUncheckedLinks: true,
  },
};
