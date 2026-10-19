import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import {
  issueDeviceRecovery,
  removeClinicDevices,
  type IssueDeviceRecoveryOutcome,
  type OpsResult,
  type RemoveClinicDevicesOutcome,
} from "./ops-client";

/**
 * The two device acts on a clinic's account page in /admin (wave 2, R4; plan
 * Part D3 and Annex X5's O3), entered as the address change is
 * (lib/admin/address-change.ts), in the order the runbook asks:
 *
 *   1. an operator session, so a stranger's POST never gets to try codes
 *      against the secret;
 *   2. the call back: the operator has called the practice on its published
 *      number and heard it ask for this. For a removal that is after the
 *      clinic replied to O3, because a reply comes from whoever holds the
 *      inbox and is never enough by itself;
 *   3. a fresh code from the operator's authenticator (lib/admin/
 *      fresh-code.ts), checked here, on Vercel;
 *
 * and only then the signed request to apps/app, which decides, writes and
 * sends. A wrong code changes nothing anywhere. No address crosses: the link
 * goes to the clinic's address as apps/app has it.
 */

const UNAUTHENTICATED = {
  ok: false as const,
  code: "unauthenticated" as const,
  message: "Your session has ended. Sign in again to continue.",
};

/** A refusal in the outcome's own shape, as the far side would word one. */
function refused(message: string): { ok: true; data: { status: "refused"; message: string } } {
  return { ok: true, data: { status: "refused", message } };
}

/** The human route: a one-time link to the clinic's address that lets one device be added. */
export async function enterDeviceRecovery(
  clinicId: string,
  input: { code: unknown; calledBack: unknown },
): Promise<OpsResult<IssueDeviceRecoveryOutcome>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (input.calledBack !== true) {
    return refused(
      "Call the practice back on its published number first, and hear from it that it asked for this. Nothing was sent.",
    );
  }
  const fresh = checkFreshOperatorCode(input.code);
  if (!fresh.ok) return refused(fresh.message);
  return issueDeviceRecovery(clinicId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O3's promise: the devices picked removed, every session ended, the backup reset. */
export async function enterDeviceRemoval(
  clinicId: string,
  input: { code: unknown; calledBack: unknown; factorIds: unknown },
): Promise<OpsResult<RemoveClinicDevicesOutcome>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  const ids = Array.isArray(input.factorIds) ? input.factorIds : null;
  if (!ids || ids.length > 50 || !ids.every((v) => typeof v === "string" && UUID.test(v))) {
    return refused("Pick the devices to remove from the list. Nothing was changed.");
  }
  if (input.calledBack !== true) {
    return refused(
      "Call the practice back on its published number first, and hear from it that it asked for this. A reply to the device email is not enough on its own. Nothing was changed.",
    );
  }
  const fresh = checkFreshOperatorCode(input.code);
  if (!fresh.ok) return refused(fresh.message);
  return removeClinicDevices(clinicId, ids as string[]);
}
