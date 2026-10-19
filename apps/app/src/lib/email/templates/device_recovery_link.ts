import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O16: the human route's link (plan Part D3, "Lost every device"), sent by
 * the ops operation issueDeviceRecovery once the operator has called the
 * practice back on its published number and entered a fresh code from the
 * operator's authenticator.
 *
 * Sent only to the clinic's address on file, as stored, never to one an
 * operator types. The link signs in and lets that browser add one passkey,
 * once, within DEVICE_RECOVERY_TTL_HOURS; O3 then says a device was added
 * this way. A link email (X1.5): the token is minted at send time and lives
 * only here.
 *
 * To stop it, the clinic is asked to write to hello@ afresh, never to reply:
 * a reply quotes the live link into our inbox. Resend's open and click
 * tracking are domain settings, not per-message ones; nothing here or in
 * the transport turns them on, and Annex X8's launch check reads them off
 * (GET /domains/:id), because a tracked click would carry the token through
 * a redirect host.
 */

export type DeviceRecoveryLinkPayload = {
  /** publicUrl("/recover/<token>"): the only place the token is ever written. */
  recoveryUrl: string;
  /** How long it works, from DEVICE_RECOVERY_TTL_HOURS. */
  validHours: number;
};

export const renderDeviceRecoveryLink: EmailTemplate<DeviceRecoveryLinkPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Add a device to your healdesk sign-in",
      // The footer must not invite the reply its body asks the reader not to send.
      replyLine: "write_new",
      preheader: `The link from your call with healdesk. It adds one device, within ${payload.validHours} hours.`,
      blocks: [
        {
          type: "paragraph",
          text: "Your clinic told us on the phone that no device on its healdesk sign-in can open patient details any more. This link lets one phone or computer add its own Face ID, fingerprint or screen lock to the sign-in. Open it on that device.",
        },
        { type: "action", label: "Add a device", url: payload.recoveryUrl },
        {
          type: "paragraph",
          text: `It works once, for the next ${payload.validHours} hours, and adds one device only. When the device is added, we email this address to say so.`,
        },
        {
          type: "paragraph",
          text: "If nobody at your clinic spoke to healdesk about this, don't use the link. Write a new email to hello@healdesk.io, rather than replying to this one, so the link isn't copied into it, and we'll stop it.",
        },
      ],
    },
    ctx,
  );

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "Rw7kT2nB5xQ9mV3cL8pZ1sF6dJ4hG0yAeN2uOiXtKqE";

export const DEVICE_RECOVERY_LINK_ENTRY: TemplateEntry<DeviceRecoveryLinkPayload> = {
  render: renderDeviceRecoveryLink,
  get fixture(): DeviceRecoveryLinkPayload {
    return { recoveryUrl: publicUrl(`/recover/${FIXTURE_TOKEN}`), validHours: 24 };
  },
};
