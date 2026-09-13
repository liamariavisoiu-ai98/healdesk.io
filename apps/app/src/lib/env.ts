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

  isProduction: () => process.env.NODE_ENV === "production",
  isTest: () => process.env.NODE_ENV === "test",
} as const;
