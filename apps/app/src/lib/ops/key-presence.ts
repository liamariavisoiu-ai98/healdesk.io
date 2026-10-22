/**
 * Which of this host's keys are in place, for the system map on /admin/map.
 *
 * The map draws every bridge between healdesk's tools and colours each one
 * by whether the key it rides on is there. apps/web can see its own keys on
 * Vercel; the AWS host's live in Parameter Store and reach this process only
 * as environment variables, so this is the one place that can answer for
 * them. It answers yes or no per name, and nothing else: never a value, a
 * length, a prefix or a hash, so the answer is the same for a good key and a
 * wrong one and says nothing an attacker could use. Whether a key WORKS is a
 * different question, asked by the bridges that can prove it (the signed
 * call that carries this answer proves HEALDESK_PROVISION_SECRET;
 * getCredentialKeyStatus proves the KMS key).
 *
 * One property beyond presence crosses, because it changes what a bridge
 * means rather than whether it exists: whether the Stripe key is a test key
 * or a live one. The mode is in the key's public prefix (sk_test_, sk_live_,
 * rk_ likewise), the same prefix Stripe prints in its dashboard beside a
 * masked key, and a host on test keys cannot take a clinic's real money.
 *
 * The list is fixed and written here. A name the caller sends is never
 * looked up, so this cannot be turned into a way to probe the environment.
 * MIGRATION_DATABASE_URL, READONLY_DATABASE_URL and the three role passwords
 * are deliberately absent: they are given to the migrate, db-query and
 * db-bootstrap tasks and never to the web
 * task that answers this (infra/aws/locals.tf), so they would read "missing"
 * on a host where they are perfectly in place.
 */

/** The image's entrypoint unsets these; a local run may not, so both count as unset. */
const UNSET_PLACEHOLDER = "__unset__";

/**
 * Every name the map asks about, in the order the map lists them. Secrets
 * first (Parameter Store, infra/aws/ssm.tf), then the public ids and settings
 * Terraform writes into the task definition.
 */
export const KEY_PRESENCE_NAMES = [
  // Pasted by the owner (put-external-secrets.sh).
  "HEALDESK_PROVISION_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "ANTHROPIC_API_KEY",
  "HEALDESK_RETELL_LLM_SECRET",
  "HEALDESK_RETELL_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  // Generated inside AWS by the db-bootstrap task.
  "BETTER_AUTH_SECRET",
  "HEALDESK_IDENTIFIER_REF_KEY",
  "DATABASE_URL",
  // Public ids and settings, plain environment from Terraform.
  "BETTER_AUTH_URL",
  "HEALDESK_ADMIN_EMAIL",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_SES_CONFIGURATION_SET",
  "HEALDESK_SES_EVENTS_TOPIC_ARN",
  "META_APP_ID",
  "META_LOGIN_CONFIG_ID",
  "META_WHATSAPP_CONFIG_ID",
  "STRIPE_CONNECT_CLIENT_ID",
  // Set with enable_voice, because HEALDESK_RETELL_LLM_SECRET reads as
  // present here before the voice service exists (infra/aws/locals.tf).
  "HEALDESK_VOICE_ENABLED",
  // Set with voice_real_calls: the voice endpoint answers real patients, not
  // only the demo clinic (lib/voice/test-calls.ts).
  "HEALDESK_VOICE_REAL_CALLS",
] as const;

export type KeyPresenceName = (typeof KEY_PRESENCE_NAMES)[number];

export type KeyPresence = {
  /** Every name in KEY_PRESENCE_NAMES, true when it holds a value. */
  present: Record<KeyPresenceName, boolean>;
  /** From STRIPE_SECRET_KEY's public prefix; null when unset or not a Stripe key. */
  stripeMode: "test" | "live" | null;
};

/** Set, in the sense the app means: a value that is neither empty nor the placeholder. */
export function isSet(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && trimmed !== UNSET_PLACEHOLDER;
}

/** "test" or "live" from a Stripe secret or restricted key's prefix, else null. */
export function stripeModeOf(value: string | undefined): "test" | "live" | null {
  if (!isSet(value)) return null;
  const match = /^(?:sk|rk)_(test|live)_/.exec(value!.trim());
  return match ? (match[1] as "test" | "live") : null;
}

export function keyPresence(source: Record<string, string | undefined> = process.env): KeyPresence {
  const present = {} as Record<KeyPresenceName, boolean>;
  for (const name of KEY_PRESENCE_NAMES) present[name] = isSet(source[name]);
  return { present, stripeMode: stripeModeOf(source.STRIPE_SECRET_KEY) };
}
