import { publicUrl } from "@/lib/public-url";

import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O5: "Your sign-in address is changing" (plan Part D5, Annex X5).
 *
 * Two ways in, one email:
 *
 *   - from Settings, once the new address has confirmed: to the OLD address,
 *     naming when the change takes effect, with "Stop this change", which
 *     opens Settings → Sign-in. Until the change takes effect every sign-in
 *     link still goes to the old address, so its reader can sign in and stop
 *     it there; this email carries no token of its own;
 *   - from ops' changeClinicEmail, after the operator called the practice
 *     back: to BOTH addresses, naming the end of the 72-hour objection
 *     window, which is when it takes effect. Its readers object by replying
 *     or calling, because the old inbox is usually the one that was lost.
 *
 * The addresses are masked. No patient, no link but the portal's own page.
 */

export type AddressChangingPayload = {
  oldAddressMasked: string;
  newAddressMasked: string;
  /** When the change takes effect: the end of the objection window. */
  effectiveAt: string;
  /** Settings → Sign-in, where "Stop this change" is. */
  settingsUrl: string;
  /** Entered by the operator after a call back, rather than asked for from Settings. */
  isFromOperator: boolean;
  /** This copy goes to the address the sign-in moves to (the operator's change sends both). */
  isToNewAddress: boolean;
};

export const renderAddressChanging: EmailTemplate<AddressChangingPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(payload.effectiveAt));
  const moves = `From then, sign-in links, billing email and notices under ${clinic}'s agreement with healdesk go to ${payload.newAddressMasked}, and no longer to ${payload.oldAddressMasked}.`;

  const blocks: Block[] = payload.isFromOperator
    ? [
        {
          type: "paragraph",
          text: `After a call with ${clinic}, we're changing its healdesk address from ${payload.oldAddressMasked} to ${payload.newAddressMasked}. The change takes effect on ${when}.`,
        },
        { type: "paragraph", text: moves },
        {
          type: "paragraph",
          text: payload.isToNewAddress
            ? `We're writing to both addresses. If this isn't right, reply to this email before ${when} and we'll stop it.`
            : `We're writing to both addresses. If you didn't ask for this, reply to this email before ${when} and we'll stop it. Nothing changes before then.`,
        },
      ]
    : [
        {
          type: "paragraph",
          text: `${clinic}'s healdesk address is changing from ${payload.oldAddressMasked} to ${payload.newAddressMasked}. It was asked for in Settings and confirmed from the new address, and it takes effect on ${when}.`,
        },
        { type: "paragraph", text: moves },
        {
          type: "paragraph",
          text: `If you didn't ask for this, stop it before ${when}. Sign in with a link to this address, and stop it in Settings, under Sign-in.`,
        },
        { type: "action", label: "Stop this change", url: payload.settingsUrl },
        {
          type: "paragraph",
          text: "Or reply to this email and we'll stop it for you.",
        },
      ];

  return compose(
    {
      subject: "Your healdesk sign-in address is changing",
      preheader: `It takes effect on ${when}.`,
      blocks,
    },
    ctx,
  );
};

/** Why the new address receives the operator's notice: it is not the clinic's address yet. */
export function addressMovingReason(clinicName: string | null): string {
  return `You're receiving this because ${clinicName ?? "a practice"} is moving its healdesk address to this one.`;
}

export const ADDRESS_CHANGING_ENTRY: TemplateEntry<AddressChangingPayload> = {
  render: renderAddressChanging,
  get fixture(): AddressChangingPayload {
    return {
      oldAddressMasked: "f•••@radiancemedspa.com",
      newAddressMasked: "i•••@radiancemedspa.com",
      effectiveAt: "2026-10-09T14:32:00.000Z",
      settingsUrl: publicUrl("/c/radiance-med-spa/settings#sign-in"),
      isFromOperator: false,
      isToNewAddress: false,
    };
  },
};
