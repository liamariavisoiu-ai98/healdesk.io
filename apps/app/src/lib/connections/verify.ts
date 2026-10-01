import { getConnectionGuide, getPlatform } from "@healdesk/catalog";

/**
 * Checking a credential, and telling the clinic what it actually bought them.
 *
 * The last step of the wizard reads back what we can and cannot see. That is
 * the trust-builder in the whole flow: it demonstrates the read-only promise
 * instead of asserting it, and it sets expectations before the first report
 * rather than in a support thread afterwards.
 *
 * ⚠️ The per-platform HTTP calls are NOT implemented — that needs real
 * credentials against real tenants, which do not exist yet. What is implemented
 * is the shape: validation of what the clinic pasted, and a capability read-back
 * derived from the platform catalogue.
 *
 * This is deliberately honest about the gap rather than returning a cheerful
 * "connected!" that means nothing. A wizard that says "verified" without having
 * verified anything is worse than one that says "saved, not yet checked" —
 * the first is discovered at month end when the report is empty.
 */

export type Capability = "appointments" | "arrival" | "revenue" | "writeback";

export type VerificationResult = {
  ok: boolean;
  /** Capability → whether this connection provides it. */
  capabilities: Record<Capability, boolean>;
  /** Shown verbatim to the clinic. Plain sentences, not field names. */
  canSee: string[];
  cannotSee: string[];
  /** Set when we could not actually reach the platform. */
  unverifiedReason?: string;
  error?: string;
};

export class CredentialValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CredentialValidationError";
  }
}

/**
 * Check the clinic pasted the right shape of thing.
 *
 * Cheap, immediate, and catches the overwhelmingly common failure: pasting the
 * wrong field, or a placeholder, or an empty string with trailing whitespace.
 */
export function validateCredentials(
  platformId: string,
  submitted: Record<string, string>,
): Record<string, string> {
  const guide = getConnectionGuide(platformId);
  if (!guide) {
    throw new CredentialValidationError(`No connection guide for ${platformId}.`);
  }

  const cleaned: Record<string, string> = {};

  for (const field of guide.fields) {
    const raw = submitted[field.name];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new CredentialValidationError(
        `${field.label} is required.`,
        field.name,
      );
    }

    const value = raw.trim();

    // People paste the example. Catching it here saves a confused support
    // thread three weeks later when no data has arrived.
    if (field.placeholder && value === field.placeholder) {
      throw new CredentialValidationError(
        `${field.label} still looks like the example value.`,
        field.name,
      );
    }

    if (value.length > 2_000) {
      throw new CredentialValidationError(
        `${field.label} is longer than any real credential.`,
        field.name,
      );
    }

    cleaned[field.name] = value;
  }

  return cleaned;
}

/**
 * What this platform can give us, from the catalogue.
 *
 * Derived rather than probed, until the per-platform clients exist. The
 * capability data is researched and specific — Acuity genuinely has no arrival
 * concept, Vagaro genuinely cannot supply sales history — so the read-back is
 * accurate about the platform even though it has not yet checked this
 * particular credential.
 */
export function expectedCapabilities(
  platformId: string,
): Record<Capability, boolean> {
  const platform = getPlatform(platformId);

  return {
    appointments: Boolean(platform && platform.connection !== "none"),
    arrival: platform?.arrival === "full",
    revenue: platform?.money === "full",
    // Write-back is Channel B, deferred. Never claimed as available.
    writeback: false,
  };
}

export async function verifyConnection(input: {
  platformId: string;
  credentials: Record<string, string>;
}): Promise<VerificationResult> {
  const platform = getPlatform(input.platformId);
  const guide = getConnectionGuide(input.platformId);

  if (!platform || !guide) {
    return {
      ok: false,
      capabilities: {
        appointments: false,
        arrival: false,
        revenue: false,
        writeback: false,
      },
      canSee: [],
      cannotSee: [],
      error: `We don't support ${input.platformId} yet.`,
    };
  }

  const capabilities = expectedCapabilities(input.platformId);

  const canSee = [...guide.grants];
  const cannotSee = [...guide.doesNotGrant];

  // Note what we did NOT do. Silence here would read as "verified".
  return {
    ok: true,
    capabilities,
    canSee,
    cannotSee,
    unverifiedReason:
      // Phase two (read-back). No email is sent when a first sync fails, so
      // none is promised here.
      `Saved and encrypted. We haven't called ${platform.name} yet to confirm the ` +
      `credential works; that happens on the first sync.`,
  };
}
