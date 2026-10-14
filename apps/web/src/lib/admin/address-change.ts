import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import { changeClinicEmail, type ChangeClinicEmailOutcome, type OpsResult } from "./ops-client";

/**
 * Entering a change of a clinic's address from /admin (changeClinicEmail;
 * plan Part D5), in the order the runbook asks: an operator session, the
 * call back to the practice's published number, a fresh code from the
 * operator's authenticator, and only then the signed request to apps/app,
 * which decides and writes. The session comes first so a stranger's POST
 * never gets to try codes against the secret; the code is checked before
 * anything crosses, so a wrong one changes nothing anywhere.
 */
export async function enterClinicEmailChange(
  clinicId: string,
  input: { newEmail: unknown; code: unknown; calledBack: unknown },
): Promise<OpsResult<ChangeClinicEmailOutcome>> {
  if (!(await requireOperator())) {
    return {
      ok: false,
      code: "unauthenticated",
      message: "Your session has ended. Sign in again to continue.",
    };
  }
  if (input.calledBack !== true) {
    return {
      ok: true,
      data: {
        status: "refused",
        message:
          "Call the practice back on its published number first, and confirm the new address with them. Nothing was changed.",
      },
    };
  }
  const fresh = checkFreshOperatorCode(input.code);
  if (!fresh.ok) return { ok: true, data: { status: "refused", message: fresh.message } };
  return changeClinicEmail(clinicId, typeof input.newEmail === "string" ? input.newEmail : "");
}
