/**
 * The human route's terms (plan Part D3, "Lost every device"), as data.
 *
 * Pure, with no imports: db/schema.ts reads these outside the app to build
 * device_recoveries' CHECKs, the way it reads DEVICE_LABEL_MAX from device.ts,
 * so the window the database enforces and the one the email states are one
 * number.
 */

/**
 * How long the link an operator sends works, and the one device it lets be
 * added: from the moment it is issued, through using the link, to the
 * passkey coming back. The plan's "the same business day" in any of the
 * clinic's time zones, with the evening the call may land in; and short,
 * because it sits in the clinic's shared inbox.
 */
export const DEVICE_RECOVERY_TTL_HOURS = 24;

/** Why an open link was ended before it was used. */
export const DEVICE_RECOVERY_REVOKE_REASONS = [
  /** The operator sent a newer one: one open link per sign-in. */
  "replaced",
  /** The clinic's own "Someone left" (Settings → Sign-in). */
  "someone_left",
  /** The operator removed devices and signed everyone out, after the clinic replied to O3. */
  "operator_signed_out",
  /** The operator ended it unused: the clinic said nobody there asked for it. */
  "operator_ended",
  /**
   * The clinic's sign-in address began to change, or moved: a link mailed to
   * the old address must not add a device once that address is on its way
   * out (lib/sign-in/address-change.ts), as its sign-in links are spent.
   */
  "address_changed",
] as const;
export type DeviceRecoveryRevokeReason = (typeof DEVICE_RECOVERY_REVOKE_REASONS)[number];
