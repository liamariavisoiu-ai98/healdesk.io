import { getPlan, isBillingInterval, type BillingInterval } from "./plans";
import { getPlatform, supportsVerifiedAttribution } from "./platforms";
import { isSpecialtyId } from "./specialties";

/**
 * What provisioning takes, and the rules it holds a purchase to.
 *
 * Moved here from apps/app/src/lib/provisioning.ts on 14 October 2026, so that
 * apps/web can hold a purchase to provisioning's own checks BEFORE the card is
 * charged, now that the purchase is recorded on apps/web and provisioning
 * runs only once the first invoice is paid
 * (docs/design/checkout-records-on-vercel-2026-10-14.md). A rule that apps/app
 * applied and apps/web did not would be a paid order with no account behind
 * it; one implementation, called by both, is what keeps that from happening.
 */

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

export type ProvisionRequest = {
  clinicName: string;
  specialty: string;
  /**
   * Platform id from @healdesk/catalog, including "none"; for a purchase
   * that answered where its bookings live, that booking system's own
   * (agreementPlatformFor). The clinic row records where bookings live from
   * the signed agreement, not from this: a purchase that names another
   * platform is provisioned as signed, and the difference recorded (plan C15).
   */
  platform: string;
  /**
   * Phase two (revenue attribution is fenced out of v1). Optional since the
   * funnel plan stopped asking: absent means "estimated", the column default,
   * and the value below is kept only when a caller still sends it.
   */
  attributionMode?: "estimated" | "verified";
  averageTreatmentValueUsd?: number;
  plan: string;
  /**
   * Monthly or annual. Defaults to "month" when absent, which is what every
   * caller that predates annual pricing sends.
   */
  billingInterval?: BillingInterval;
  timezone?: string;

  /**
   * The Stripe ids from the completed Session, stamped by apps/web from the
   * verified event like `idempotencyKey`. They are how every later lifecycle
   * event — renewal, failed card, cancellation — finds this clinic again, and
   * their presence is what decides the initial billing status: with a
   * subscription to wait on the clinic starts `provisioning` and the first
   * `invoice.paid` activates it; without one (the no-Stripe dev path) nothing
   * will ever arrive to do that, so it starts `active`.
   */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;

  contactName: string;
  contactEmail: string;
  contactTitle?: string;

  /**
   * Landline/toll-free vs VoIP, from discovery question B.
   *
   * Optional, and defaults to "unknown" rather than to a guess: it decides
   * whether the clinic's published number can be text-enabled at all, and an
   * assumed "landline" would surface as a failed provisioning weeks later.
   */
  phoneSystemType?: "landline" | "voip" | "unknown";

  /**
   * Whether the clinic's number rings at the practice first ("conditional")
   * or comes straight to us ("always"). Decides what counts as recovered
   * revenue, so it is asked at checkout and confirmed at onboarding; when
   * absent the column default applies and the onboarding step stays open.
   */
  callRouting?: "conditional" | "always";

  /**
   * The agreement signed BEFORE payment: since 14 October 2026 a record
   * apps/web keeps and apps/app imports, under this same id, when the first
   * invoice is paid (apps/app lib/checkout/import.ts).
   *
   * Provisioning no longer records the acceptance itself — by the time we get
   * here the buyer has already signed, and re-recording it would produce a
   * second row with a later timestamp and a different rendered document. This
   * id binds the existing signature to the organization payment just created.
   */
  agreementId: string;

  /**
   * What makes a repeated delivery a no-op. See drizzle/0021.
   *
   * ⚠️ Stamped SERVER-SIDE by apps/web from the verified Stripe event — never
   * taken from a browser. The HMAC on this request authenticates apps/web, not
   * the buyer, so a key chosen by the client would let anyone who guessed one
   * receive another clinic's organizationId and clinicId in the replay
   * response. A dedupe key that echoes prior results is an object reference
   * oracle if it is attacker-controlled.
   */
  idempotencyKey: string;
};

export function validateProvisionRequest(
  input: unknown,
): asserts input is ProvisionRequest {
  const body = input as Partial<ProvisionRequest> | null;
  if (!body || typeof body !== "object") {
    throw new ProvisioningError("Invalid request body.");
  }

  if (!body.clinicName?.trim()) {
    throw new ProvisioningError("Clinic name is required.", "clinicName");
  }
  if (body.clinicName.length > 120) {
    throw new ProvisioningError("Clinic name is too long.", "clinicName");
  }
  if (!isSpecialtyId(body.specialty)) {
    throw new ProvisioningError("Unknown specialty.", "specialty");
  }

  const platform = getPlatform(body.platform ?? "");
  if (!platform) {
    throw new ProvisioningError("Unknown platform.", "platform");
  }
  if (!getPlan(body.plan ?? "")) {
    throw new ProvisioningError("Unknown plan.", "plan");
  }
  if (
    body.billingInterval !== undefined &&
    !isBillingInterval(body.billingInterval)
  ) {
    throw new ProvisioningError("Invalid billing interval.", "billingInterval");
  }
  // Shape only. Whether they name a real customer is Stripe's business; the
  // partial unique indexes on entitlements refuse a second clinic on the same
  // subscription, which is the property that matters.
  for (const field of ["stripeCustomerId", "stripeSubscriptionId"] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new ProvisioningError(`Invalid ${field}.`, field);
    }
    if (typeof value === "string" && value.length > 255) {
      throw new ProvisioningError(`${field} is too long.`, field);
    }
  }

  if (
    body.attributionMode !== undefined &&
    body.attributionMode !== "estimated" &&
    body.attributionMode !== "verified"
  ) {
    throw new ProvisioningError("Invalid attribution mode.", "attributionMode");
  }

  // Verified attribution needs something to connect to. Catching this here
  // rather than at the wizard means the API can't be talked into a state the
  // UI would never produce.
  if (
    body.attributionMode === "verified" &&
    !supportsVerifiedAttribution(platform)
  ) {
    throw new ProvisioningError(
      `Verified attribution needs a system to read from; ${platform.name} has none.`,
      "attributionMode",
    );
  }

  // Optional now (design 4.2): the funnel plan stopped asking, because the
  // monthly revenue report it fed is phase two. Still checked when sent.
  if (body.averageTreatmentValueUsd !== undefined) {
    const value = body.averageTreatmentValueUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ProvisioningError(
        "Average treatment value must be a positive number.",
        "averageTreatmentValueUsd",
      );
    }
    if (value > 1_000_000) {
      throw new ProvisioningError(
        "Average treatment value looks wrong.",
        "averageTreatmentValueUsd",
      );
    }
  }

  if (!body.contactName?.trim()) {
    throw new ProvisioningError("Your name is required.", "contactName");
  }
  if (!isEmail(body.contactEmail)) {
    throw new ProvisioningError("A valid email is required.", "contactEmail");
  }

  if (
    body.callRouting !== undefined &&
    !["conditional", "always"].includes(body.callRouting as string)
  ) {
    throw new ProvisioningError("Invalid call routing.", "callRouting");
  }
  if (
    body.phoneSystemType !== undefined &&
    !["landline", "voip", "unknown"].includes(body.phoneSystemType)
  ) {
    throw new ProvisioningError(
      "Invalid phone system type.",
      "phoneSystemType",
    );
  }

  // Required, and never defaulted to a fresh uuid. A generated fallback would
  // make every delivery unique and silently restore the duplicate-account bug
  // this field exists to remove — with no error anywhere to notice it by.
  if (!body.idempotencyKey?.trim()) {
    throw new ProvisioningError(
      "An idempotency key is required.",
      "idempotencyKey",
    );
  }
  if (body.idempotencyKey.length > 255) {
    throw new ProvisioningError("Idempotency key is too long.", "idempotencyKey");
  }

  // No `baaAccepted: true` flag any more, deliberately. A boolean sent by the
  // caller is a claim; an agreement id is a row that already exists, signed,
  // with its own text and hash. The second is checkable and the first is not.
  if (!isUuid(body.agreementId ?? "")) {
    throw new ProvisioningError(
      "A signed business associate agreement is required before an account can be created.",
      "agreementId",
    );
  }
}


function isEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
