import { log } from "@/lib/log";

/**
 * The device email to the clinic: O3 in Annex X5 of the funnel and portal
 * plan, "A device was added or removed". It names the device and goes to the
 * clinic's address when a passkey is added (except the first, in the paying
 * browser), when one is removed, and when code entry locks after wrong codes.
 *
 * TODO(O3): a seam until the email platform (Annex X3) is on main. Then it
 * queues O3 for the sign-in's clinic address, after the factor change has
 * committed, and the template reads the device's name from `factorId`'s row
 * (the name is chosen by staff, so it stays out of logs and security events).
 * `first` lets it skip the first passkey added in the browser that paid.
 *
 * Called after commit, so a change that rolls back sends nothing. It never
 * throws: no factor change fails because of its email.
 */
export async function notifyDeviceChange(change: {
  userId: string;
  kind: "added" | "removed" | "locked";
  factorId?: string;
  first?: boolean;
}): Promise<void> {
  try {
    log.info("device email not sent: O3 lands with the email platform", { kind: change.kind });
  } catch {
    // Nothing reaches the caller; see above.
  }
}
