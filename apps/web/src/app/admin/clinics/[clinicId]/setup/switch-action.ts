import type { OpsResult, SetClinicSwitchOutcome } from "@/lib/admin/ops-client";

type Upstream = (clinicId: string, key: string, value: boolean | string) => Promise<OpsResult<SetClinicSwitchOutcome>>;

/**
 * The server action's body, kept out of page.tsx so it can be tested. The
 * clinic is the page's, never one the browser sends. Only the shape of the
 * request is checked here; whether the switch may be set is apps/app's
 * answer, and a refusal or a failed call goes back to the panel untouched.
 */
export async function setSwitchAction(upstream: Upstream, clinicId: string, key: unknown, value: unknown): Promise<OpsResult<SetClinicSwitchOutcome>> {
  const refused = (message: string): OpsResult<SetClinicSwitchOutcome> => ({ ok: true, data: { status: "refused", message } });
  if (typeof key !== "string" || key === "" || key.length > 64) return refused("That is not a switch.");
  if (typeof value !== "boolean" && typeof value !== "string") return refused("That is not a value a switch can take.");
  return upstream(clinicId, key, value);
}
