"use server";

import { revalidatePath } from "next/cache";

import { saveConnection, markVerified, revokeConnection } from "@/lib/connections/store";
import {
  CredentialValidationError,
  validateCredentials,
  verifyConnection,
} from "@/lib/connections/verify";
import { resolveTenantContext } from "@/lib/session";
import { withTenant } from "@/lib/tenant";

export type ConnectState =
  | { status: "idle" }
  | { status: "saved"; canSee: string[]; cannotSee: string[]; note?: string }
  | { status: "error"; message: string; field?: string };

/**
 * Save a clinic's read-only credential.
 *
 * Everything happens inside withTenant, so the credential is written under the
 * clinic's own tenant and the decrypt-and-store is audited like any other PHI
 * access. The credential itself never appears in a return value, a log line, or
 * a revalidated page — only what it lets us see.
 */
export async function connectPlatform(
  _previous: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const clinicSlug = String(formData.get("clinicSlug") ?? "");
  const platformId = String(formData.get("platformId") ?? "");

  // Re-resolves the session AND the clinic grant. A server action is a POST
  // endpoint; the page that rendered the form is not a guarantee about who is
  // submitting it.
  const context = await resolveTenantContext(clinicSlug);

  const submitted: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "clinicSlug" || key === "platformId") continue;
    if (typeof value === "string") submitted[key] = value;
  }

  try {
    const credentials = validateCredentials(platformId, submitted);
    const verification = await verifyConnection({ platformId, credentials });

    if (!verification.ok) {
      return { status: "error", message: verification.error ?? "Could not connect." };
    }

    await withTenant(context, async (tx) => {
      const connectionId = await saveConnection(tx.db, {
        clinicId: context.clinicId,
        provider: platformId,
        credentials,
      });

      await markVerified(tx.db, {
        clinicId: context.clinicId,
        connectionId,
        capabilities: verification.capabilities,
      });

      tx.audit.record({
        action: "create",
        resourceType: "provider_connection",
        resourceId: connectionId,
        // Metadata only — assertNoPhi() would reject anything more.
        metadata: { provider: platformId },
      });
    });

    revalidatePath(`/c/${clinicSlug}`);

    return {
      status: "saved",
      canSee: verification.canSee,
      cannotSee: verification.cannotSee,
      note: verification.unverifiedReason,
    };
  } catch (error) {
    if (error instanceof CredentialValidationError) {
      return { status: "error", message: error.message, field: error.field };
    }
    // Never surface the raw error: a driver or HTTP error can carry the
    // credential that caused it.
    console.error("[healdesk] connection failed", error);
    return { status: "error", message: "We couldn't save that. Please try again." };
  }
}

export async function disconnectPlatform(formData: FormData): Promise<void> {
  const clinicSlug = String(formData.get("clinicSlug") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const context = await resolveTenantContext(clinicSlug);

  await withTenant(context, async (tx) => {
    await revokeConnection(tx.db, {
      clinicId: context.clinicId,
      connectionId,
    });
    tx.audit.record({
      action: "update",
      resourceType: "provider_connection",
      resourceId: connectionId,
      metadata: { revoked: true },
    });
  });

  revalidatePath(`/c/${clinicSlug}`);
}
