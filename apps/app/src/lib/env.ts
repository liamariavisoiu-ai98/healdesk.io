import { log } from "@/lib/log";
/**
 * Environment accessors.
 *
 * Every secret is read through a function that throws in production and warns
 * in development. This mirrors the pattern already established in
 * apps/web/src/lib/gate.ts: failing loudly at boot beats discovering at 3am
 * that production has been signing cookies with "dev-only-insecure-secret".
 *
 * Nothing here is read at module scope — accessors are called at use time, so
 * a missing variable that only matters for one feature doesn't prevent the rest
 * of the app from starting.
 */

function required(name: string, hint?: string): string {
  const value = process.env[name];
  if (value) return value;

  const message = `${name} is not set.${hint ? ` ${hint}` : ""}`;
  if (process.env.NODE_ENV === "production") throw new Error(message);

  log.warn(`${message} Using a development fallback.`);
  return "";
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  /** Runtime connection. MUST be a role WITHOUT BYPASSRLS — see docs/hipaa-compliance.md. */
  databaseUrl: () =>
    required(
      "DATABASE_URL",
      "The runtime role must not have BYPASSRLS or own the tables.",
    ),

  /**
   * Migration connection. A different, higher-privileged role than the runtime
   * one. Two roles is what makes FORCE ROW LEVEL SECURITY meaningful: the owner
   * bypasses policies, so the app must not connect as the owner.
   */
  migrationDatabaseUrl: () =>
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",

  betterAuthSecret: () =>
    required("BETTER_AUTH_SECRET", "Generate with: openssl rand -base64 32"),

  betterAuthUrl: () =>
    process.env.BETTER_AUTH_URL ?? "http://localhost:3001",

  /**
   * Shared secret between the marketing site's checkout and this app's
   * provisioning endpoint. The two run on different hosts — Vercel and AWS —
   * so the call crosses a network boundary and must be authenticated.
   */
  provisionSecret: () =>
    required(
      "HEALDESK_PROVISION_SECRET",
      "Shared with apps/web. Generate with: openssl rand -base64 32",
    ),

  /**
   * Key-encryption key for the credential vault.
   *
   * "local" wraps data keys with HEALDESK_LOCAL_KEK — development only, and
   * getKeyWrapper() refuses it in production. "aws-kms" uses HEALDESK_KMS_KEY_ID.
   */
  kmsProvider: (): "local" | "aws-kms" =>
    process.env.HEALDESK_KMS_PROVIDER === "aws-kms" ? "aws-kms" : "local",

  /**
   * Bearer secret the voice platform sends on its post-call webhook
   * (Authorization: Bearer …). Synthflow lets you set a fixed header on a
   * webhook; until it signs payloads this is the authentication. Unset means
   * the route answers 503 and records nothing.
   */
  voiceWebhookSecret: () => optional("HEALDESK_VOICE_WEBHOOK_SECRET"),

  /**
   * Bearer secret the voice agent's mid-call tools send to
   * /api/voice/tools/[clinicId]/* (design of 23 September 2026, §E.2).
   * Deliberately a DIFFERENT secret from the post-call webhook's: the tools
   * can book, the webhook can only report, and a leaked reporting header must
   * not become a booking header. Unset means every tool route answers 503.
   * Pre-Retell: these routes serve the Synthflow agent until the Retell
   * endpoint exists.
   */
  voiceToolsSecret: () => optional("HEALDESK_VOICE_TOOLS_SECRET"),

  /**
   * The Meta app (docs/meta-app-review.md). The id is public; the secret signs
   * every webhook and exchanges every login code. The two configuration ids
   * come from Facebook Login for Business → Configurations: one for Messenger
   * and Instagram, one for WhatsApp Embedded Signup. Unset means the matching
   * connect page says the channel is not available yet and stores nothing.
   */
  metaAppId: () => optional("META_APP_ID"),
  metaAppSecret: () => optional("META_APP_SECRET"),
  metaLoginConfigId: () => optional("META_LOGIN_CONFIG_ID"),
  metaWhatsAppConfigId: () => optional("META_WHATSAPP_CONFIG_ID"),

  /**
   * The platform Stripe secret key (design D15). apps/app uses it for Stripe
   * Connect, plan changes, extra locations, metered usage, annual overage
   * invoices, refunds and portal sessions; read it through
   * lib/billing/stripe-client.ts. Optional: unset in development means every
   * Stripe-backed action reports "not configured" instead of failing at boot,
   * and the no-Stripe provisioning path keeps working.
   */
  stripeSecretKey: () => optional("STRIPE_SECRET_KEY"),

  /** Stripe Connect's platform client id (`ca_…`) for the OAuth link. Optional; unset hides Connect. */
  stripeConnectClientId: () => optional("STRIPE_CONNECT_CLIENT_ID"),

  /**
   * Signing secret of the Connect webhook endpoint on apps/app
   * (`/api/webhooks/stripe-connect`). Deliberately NOT apps/web's
   * STRIPE_WEBHOOK_SECRET: Connect events terminate here and never pass
   * through the marketing site, and a leaked platform-webhook secret must not
   * be able to forge a "deposit paid". Unset means the route answers 503.
   */
  stripeConnectWebhookSecret: () => optional("STRIPE_CONNECT_WEBHOOK_SECRET"),

  kmsKeyId: () => optional("HEALDESK_KMS_KEY_ID"),

  /** Base64, 32 bytes. Development only. */
  localKek: () => optional("HEALDESK_LOCAL_KEK"),

  /**
   * The one administrator, as healdesk.io/admin knows them.
   *
   * Deliberately NOT read through `required()`, and this is the one accessor in
   * the file that must not be. `required()` warns and returns "" outside
   * production, which is right for a secret whose absence breaks one feature
   * and wrong for the value that names the actor in an audit trail: every row
   * `lib/ops/api.ts` writes carries this address as its ONLY statement of who
   * acted, so an empty string would fill the audit log with rows that look
   * attributed and are not. That is worse than an ops API which refuses to
   * answer until it is configured, which is what `null` here produces.
   *
   * Trimmed and lowercased so it compares equal to the same address typed into
   * apps/web's sign-in form on a phone keyboard. Shape is checked by the caller,
   * which is also where the 503 is decided.
   *
   * apps/web reads its own copy of this variable; the two must match, and
   * nothing verifies that they do. They are separate deployments with separate
   * environments, so the only alternative would be shipping the address across
   * the signed boundary — which is exactly what must not happen, or a caller
   * could choose whose name goes in the audit row.
   */
  adminEmail: (): string | null => {
    const value = process.env.HEALDESK_ADMIN_EMAIL?.trim().toLowerCase();
    return value ? value : null;
  },

  /**
   * The direct-booking kill switch (design of 23 September 2026, §E.1). One
   * of the gates in lib/booking/mode.ts, and the only one an operator can
   * flip without a database write; it is read on every tool call and never
   * cached, so unsetting it in an environment stops the assistant booking on
   * the next call. Anything but the literal string "true" is off.
   */
  directBookingEnabled: (): boolean => process.env.HEALDESK_DIRECT_BOOKING_ENABLED === "true",

  /**
   * Phase two: attribution. The monthly revenue report, the nightly POS/EMR
   * sync and reconciliation, and the read-back connect link are fenced out of
   * v1 (v1 spec, "What v1 can prove, and what it cannot"; CLAUDE.md, "Claims
   * and copy"). Their code is kept; while this is anything but the literal
   * string "true" none of it runs, no clinic is mailed a revenue figure, and
   * the console refuses to switch those jobs on. Leave it unset in v1.
   */
  phaseTwoAttribution: (): boolean => process.env.HEALDESK_PHASE_TWO_ATTRIBUTION === "true",

  isProduction: () => process.env.NODE_ENV === "production",
  isTest: () => process.env.NODE_ENV === "test",
} as const;
