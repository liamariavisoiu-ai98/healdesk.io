import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O5's confirmation (plan Part D5, Annex X5): a change of the clinic's one
 * address asked for from Settings sends this to the NEW address, with a
 * single-use link that confirms it (lib/sign-in/address-change.ts). A link
 * email (X1.5): the token is minted when this is sent and lives only in this
 * message, never in a stored payload, so it is sent straight and recorded on
 * the ledger, never queued in the outbox.
 *
 * Nothing changes until the link is used, and nothing takes effect until 72
 * hours after that, while the current address can still stop it. The old
 * address is shown masked: enough for the reader to recognise it, not enough
 * to read it out.
 */

export type AddressChangeConfirmPayload = {
  /** publicUrl("/address-change/<token>"): the only place the token is written. */
  confirmUrl: string;
  /** The address the sign-in moves from, masked ("l•••@glowspa.com"). */
  oldAddressMasked: string;
  /** How long the link works. */
  validHours: number;
  /** How long after confirmation the change takes effect. */
  waitHours: number;
};

export const renderAddressChangeConfirm: EmailTemplate<AddressChangeConfirmPayload> = (
  payload,
  ctx,
) => {
  const clinic = ctx.clinicName ?? "A practice";
  return compose(
    {
      subject: "Confirm this address for healdesk",
      preheader: `The link works once, for ${payload.validHours} hours.`,
      blocks: [
        {
          type: "paragraph",
          text: `${clinic} asked to make this address its healdesk address, in place of ${payload.oldAddressMasked}. It would become the practice's sign-in, its billing email and the address for notices under its agreement with healdesk.`,
        },
        { type: "action", label: "Confirm this address", url: payload.confirmUrl },
        {
          type: "paragraph",
          text: `The link works once, for ${payload.validHours} hours. Once you confirm, the change takes effect ${payload.waitHours} hours later, and until then ${payload.oldAddressMasked} can stop it.`,
        },
        {
          type: "paragraph",
          text: "If you didn't expect this, ignore this email. Nothing changes unless the link is used.",
        },
      ],
    },
    ctx,
  );
};

/** Why the new address receives it: it is not the clinic's address yet. */
export function addressConfirmReason(clinicName: string): string {
  return `You're receiving this because someone at ${clinicName} asked to make this address its healdesk address.`;
}

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "Qm7tR2xV9cK4pL8wN3sJ6hF1dB5gZ0yAeU2iOqXvTkM";

export const ADDRESS_CHANGE_CONFIRM_ENTRY: TemplateEntry<AddressChangeConfirmPayload> = {
  render: renderAddressChangeConfirm,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): AddressChangeConfirmPayload {
    return {
      confirmUrl: publicUrl(`/address-change/${FIXTURE_TOKEN}`),
      oldAddressMasked: "f•••@radiancemedspa.com",
      validHours: 72,
      waitHours: 72,
    };
  },
};
