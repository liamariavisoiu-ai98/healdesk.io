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

  console.warn(`[healdesk] ${message} Using a development fallback.`);
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

  isProduction: () => process.env.NODE_ENV === "production",
  isTest: () => process.env.NODE_ENV === "test",
} as const;
