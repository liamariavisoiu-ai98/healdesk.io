import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O3: "A device was added or removed" (Annex X5), to the sign-in's address.
 *
 * Each phone or computer that opens patient details does so with its own
 * passkey, so this email is how the clinic notices a device it does not
 * recognise. It names the device and says when, in the clinic's own time,
 * and what to do if it wasn't them: reply, and we remove the device and sign
 * everyone out by hand, through the human route in plan Part D3, because a
 * device the clinic does not recognise may also hold the sign-in.
 *
 * "Someone left" (Settings → Sign-in) sends one of these too, `signed_out`:
 * every session ended, the devices picked removed, and the backup reset.
 */

export type DeviceChange = "added" | "removed" | "locked" | "signed_out";

export type DeviceChangedPayload = {
  change: DeviceChange;
  /** The device's name, as staff gave it. Absent for a lockout, which has no device. */
  deviceName?: string;
  changedAt: string;
  /** For a lockout: how long code entry is locked. */
  lockedMinutes?: number;
  /** For "Someone left": how many devices were removed with it. */
  removedCount?: number;
};

const NOT_YOU =
  "If that wasn't someone at your clinic, reply to this email now. We'll remove the device and sign everyone out.";

export const renderDeviceChanged: EmailTemplate<DeviceChangedPayload> = (payload, ctx) => {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(payload.changedAt));
  const device = payload.deviceName ? `“${payload.deviceName}”` : "A device";

  switch (payload.change) {
    case "added":
      return compose(
        {
          subject: "A device was added to your healdesk sign-in",
          preheader: `${device} can now open patient details.`,
          blocks: [
            {
              type: "paragraph",
              text: `${device} was added to your healdesk sign-in on ${when}. It can now open patient details, with its own Face ID, fingerprint or screen lock.`,
            },
            { type: "paragraph", text: NOT_YOU },
          ],
        },
        ctx,
      );
    case "removed":
      return compose(
        {
          subject: "A device was removed from your healdesk sign-in",
          preheader: `${device} can no longer open patient details.`,
          blocks: [
            {
              type: "paragraph",
              text: `${device} was removed from your healdesk sign-in on ${when}. It can no longer open patient details.`,
            },
            {
              type: "paragraph",
              text: "If you didn't remove it, reply to this email and we'll check what happened.",
            },
          ],
        },
        ctx,
      );
    case "locked": {
      const minutes = payload.lockedMinutes ?? 15;
      return compose(
        {
          subject: "Code entry on your healdesk sign-in was locked",
          preheader: `Too many wrong codes. It unlocks by itself in ${minutes} minutes.`,
          blocks: [
            {
              type: "paragraph",
              text: `Too many wrong codes were entered for your healdesk sign-in on ${when}, so code entry is locked for ${minutes} minutes. It unlocks by itself.`,
            },
            {
              type: "paragraph",
              text: "If that wasn't someone at your clinic, reply to this email now and we'll help.",
            },
          ],
        },
        ctx,
      );
    }
    case "signed_out": {
      const removed = payload.removedCount ?? 0;
      return compose(
        {
          subject: "Everyone was signed out of your healdesk sign-in",
          preheader: "Someone at your clinic used Someone left.",
          blocks: [
            {
              type: "paragraph",
              text: `On ${when}, someone at your clinic used “Someone left” in Settings: every browser was signed out, ${
                removed === 0
                  ? "no device was removed"
                  : removed === 1
                    ? "one device was removed"
                    : `${removed} devices were removed`
              }, and the authenticator-app backup and backup codes were reset.`,
            },
            {
              type: "paragraph",
              text: "Sign in again with a link from healdesk's sign-in page. Devices that weren't removed open patient details as before; add the authenticator app again in Settings → Sign-in.",
            },
            {
              type: "paragraph",
              text: "If nobody at your clinic did this, reply to this email now and we'll check what happened.",
            },
          ],
        },
        ctx,
      );
    }
    default:
      throw new EmailCompositionError(`Unknown device change "${String(payload.change)}".`);
  }
};

export const DEVICE_CHANGED_ENTRY: TemplateEntry<DeviceChangedPayload> = {
  render: renderDeviceChanged,
  fixture: { change: "added", deviceName: "Front desk Mac", changedAt: "2026-10-06T14:32:00Z" },
};
