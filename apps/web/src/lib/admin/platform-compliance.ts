import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import {
  attestPlatformCompliance,
  withdrawPlatformCompliance,
  type OpsResult,
  type PlatformAttestationOutcome,
  type PlatformSubjectId,
  PLATFORM_SUBJECT_IDS,
} from "./ops-client";
import { LAUNCH_PROMISES } from "./seo/launch";

/**
 * Entering an attestation of the platform from /admin/compliance (WP2; plan
 * Part K, "Platform-compliance attestation"). Automatic go-live reads what
 * is entered here, so it is entered as the address change is
 * (lib/admin/address-change.ts): an operator session first, so a stranger's
 * POST never gets to try codes against the secret; then a fresh code from
 * the operator's authenticator, checked here on Vercel against the secret
 * sign-in uses (lib/admin/fresh-code.ts); and only then the signed request
 * to apps/app, which validates and records. A wrong code changes nothing
 * anywhere.
 *
 * The launch promises are this app's to judge: LAUNCH_PROMISES lives here
 * (lib/admin/seo/launch.ts, shown under /admin/compliance#launch), and CLAUDE.md says no clinic goes live while an
 * item that blocks go-live is open. So their attestation is refused here
 * while one is, before the code is even asked, and the open ids go with the
 * request so apps/app refuses it too.
 */

/** The ids of the launch promises that block go-live and are not on. */
export function openLaunchPromises(): string[] {
  return LAUNCH_PROMISES.filter((p) => p.blocksGoLive && p.status !== "on").map((p) => p.id);
}

const refused = (message: string): OpsResult<PlatformAttestationOutcome> => ({
  ok: true,
  data: { status: "refused", message },
});

function subjectOf(value: unknown): PlatformSubjectId | null {
  return typeof value === "string" && (PLATFORM_SUBJECT_IDS as readonly string[]).includes(value)
    ? (value as PlatformSubjectId)
    : null;
}

export async function enterPlatformAttestation(input: {
  action: unknown;
  subject: unknown;
  documentRef: unknown;
  effectiveOn: unknown;
  expiresOn?: unknown;
  code: unknown;
}): Promise<OpsResult<PlatformAttestationOutcome>> {
  if (!(await requireOperator())) {
    return {
      ok: false,
      code: "unauthenticated",
      message: "Your session has ended. Sign in again to continue.",
    };
  }
  const subject = subjectOf(input.subject);
  if (!subject) return refused("That isn't something the platform attests. Nothing was recorded.");
  const action =
    input.action === "withdraw" ? "withdraw" : input.action === "attest" ? "attest" : null;
  if (!action) return refused("Attest or withdraw. Nothing was recorded.");
  const open = openLaunchPromises();
  if (action === "attest" && subject === "launch_promises" && open.length > 0) {
    return refused(
      `Launch promises that block go-live are still open (${open.join(", ")}): move each to on first, under /admin/compliance#launch. Nothing was recorded.`,
    );
  }
  const fresh = checkFreshOperatorCode(input.code);
  if (!fresh.ok) return refused(fresh.message);
  const base = {
    subject,
    documentRef: typeof input.documentRef === "string" ? input.documentRef : "",
    effectiveOn: typeof input.effectiveOn === "string" ? input.effectiveOn : "",
  };
  if (action === "withdraw") return withdrawPlatformCompliance(base);
  return attestPlatformCompliance({
    ...base,
    ...(typeof input.expiresOn === "string" && input.expiresOn
      ? { expiresOn: input.expiresOn }
      : {}),
    ...(subject === "launch_promises" ? { openLaunchPromises: open } : {}),
  });
}
