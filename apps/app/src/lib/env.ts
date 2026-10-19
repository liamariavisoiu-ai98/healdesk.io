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

/**
 * What `next build` sets NEXT_PHASE to before it imports every route module to
 * collect page data (node_modules/next/dist/build/index.js). Nothing connects
 * during a build, and the image builds under NODE_ENV=production with a
 * placeholder URL (apps/app/Dockerfile) and CI with sslmode=disable, so the
 * TLS check below waits for a process that will actually connect.
 */
const NEXT_PRODUCTION_BUILD_PHASE = "phase-production-build";

/**
 * Refuse, in production, a database URL that does not ask for a verified TLS
 * connection. The error names the variable and never its value, which holds a
 * password.
 *
 * The URL is the only place TLS is decided for every client in the process:
 * node-postgres lets the URL's parameters override a client's own `ssl`
 * option, and pg-boss passes nothing else. So without `sslmode` the Drizzle
 * pool asks for TLS while pg-boss connects in plaintext, which RDS refuses
 * (rds.force_ssl=1) and a database that does not force TLS accepts.
 * `sslmode=no-verify` keeps TLS and switches certificate checks off, silently
 * overriding the pool's rejectUnauthorized. `require`, `prefer` and
 * `verify-ca` verify under pg 8 only with a deprecation warning, and lose the
 * certificate or host-name check under libpq semantics (`uselibpqcompat=true`,
 * and the pg 9 default). Only verify-full means the same thing to every
 * client and every version. pg keeps the last of a repeated parameter, so
 * every `sslmode` in the URL has to say it, not just the first.
 *
 * The check has to read the URL exactly as pg does, or it checks something
 * else. pg-connection-string parses with the same WHATWG URL parser, but
 * first re-encodes any URL holding a space or a `%` that does not start an
 * escape (PG_REWRITES_FIRST), and the re-encoding changes what an escape in
 * the query means: beside an unencoded space in the password,
 * `ssl%6Dode=verify-full` reads as sslmode here and as nothing at all to pg.
 * So a URL pg would rewrite is refused, like one the parser cannot read,
 * rather than guessed at.
 */
function requireVerifiedTls(name: string, url: string): string {
  if (process.env.NODE_ENV !== "production") return url;
  if (process.env.NEXT_PHASE === NEXT_PRODUCTION_BUILD_PHASE) return url;

  const modes = sslModes(url);
  if (modes === undefined) {
    throw new Error(
      `${name} could not be read as a URL. Percent-encode the password: postgresql://user:password@host:5432/db?sslmode=verify-full.`,
    );
  }

  if (modes.length === 0 || modes.some((mode) => mode !== "verify-full")) {
    throw new Error(
      `${name} must carry sslmode=verify-full in production, so that every database client verifies the server's certificate and host name. Add sslmode=verify-full (and sslrootcert=<path to the CA bundle> when the server's CA is not a public one), and no other sslmode.`,
    );
  }

  return url;
}

/** pg-connection-string's own test for a URL it re-encodes before parsing it. */
const PG_REWRITES_FIRST = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i;

/** Every sslmode the URL carries, as pg will read them, or undefined when that cannot be known. */
function sslModes(url: string): string[] | undefined {
  if (PG_REWRITES_FIRST.test(url)) return undefined;
  try {
    return new URL(url).searchParams.getAll("sslmode");
  } catch {
    return undefined;
  }
}

/**
 * The identifier-reference key outside production. Fixed, so a test or a
 * local run computes the same references every time with no setup, and
 * public, because nothing outside production may hold a real identifier.
 */
const DEVELOPMENT_IDENTIFIER_REF_KEY = "healdesk-development-identifier-ref-key-not-a-secret";

/** openssl rand -base64 32 prints 44 characters; anything under 32 is a typo or a placeholder. */
const IDENTIFIER_REF_KEY_MIN_LENGTH = 32;

export const env = {
  /**
   * Runtime connection. MUST be a role WITHOUT BYPASSRLS — see docs/hipaa-compliance.md.
   * In production it must also ask for verified TLS (requireVerifiedTls above):
   * the web tier's pool and the worker's pg-boss both connect through here.
   */
  databaseUrl: () =>
    requireVerifiedTls(
      "DATABASE_URL",
      required("DATABASE_URL", "The runtime role must not have BYPASSRLS or own the tables."),
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
   * The key behind identifierRef() (lib/identifier-ref.ts): the HMAC that
   * turns a vendor's identifier into the reference we store instead of it. A
   * WhatsApp sender id is a phone number, and an unkeyed hash of one is
   * reversed by hashing every number. Its own variable rather than a
   * derivation of BETTER_AUTH_SECRET, so rotating session signing can never
   * re-key the ledgers by accident.
   *
   * NEVER rotate it without a re-key plan. Every stored reference was made
   * under it: under a new key a caller's next message no longer finds its
   * conversation, a redelivered Meta message is no longer recognised as one,
   * and a call already counted is counted again.
   *
   * Required in production, at least 32 characters (openssl rand -base64 32).
   * Outside production a fixed development key stands in, without a warning,
   * because it is read on every inbound message and the stand-in is
   * deliberate rather than a missing secret.
   */
  identifierRefKey: (): string => {
    const value = process.env.HEALDESK_IDENTIFIER_REF_KEY;
    if (process.env.NODE_ENV !== "production") return value || DEVELOPMENT_IDENTIFIER_REF_KEY;
    if (!value) {
      throw new Error(
        "HEALDESK_IDENTIFIER_REF_KEY is not set. Generate with: openssl rand -base64 32",
      );
    }
    if (value.length < IDENTIFIER_REF_KEY_MIN_LENGTH) {
      throw new Error(
        `HEALDESK_IDENTIFIER_REF_KEY is shorter than ${IDENTIFIER_REF_KEY_MIN_LENGTH} characters. Generate with: openssl rand -base64 32`,
      );
    }
    return value;
  },

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
   * apps/web's public origin (https://healdesk.io), which this app calls for
   * the signed website re-reads (lib/website/client.ts): fetching a URL a
   * buyer typed belongs off the PHI host, so the read runs there and comes
   * back as business data. Signed with HEALDESK_PROVISION_SECRET. Optional:
   * unset means nothing is read again, and each read waits, queued. A plain
   * public setting (infra/aws `app_environment`), never HEALDESK_APP_URL,
   * which is the other direction.
   */
  webUrl: () => optional("HEALDESK_WEB_URL"),

  /**
   * Key-encryption key for the credential vault.
   *
   * "local" wraps data keys with HEALDESK_LOCAL_KEK — development only, and
   * getKeyWrapper() refuses it in production. "aws-kms" uses HEALDESK_KMS_KEY_ID.
   */
  kmsProvider: (): "local" | "aws-kms" =>
    process.env.HEALDESK_KMS_PROVIDER === "aws-kms" ? "aws-kms" : "local",

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

  /**
   * healdesk's Google OAuth client for the Calendar connection (plan §12):
   * one Web client per Google Cloud project, with
   * `<BETTER_AUTH_URL>/api/calendar/google/callback` as its redirect. Set
   * only in the AWS BAA host's secret store for apps/app, never on apps/web
   * or any Vercel project: the secret exchanges every clinic's sign-in for a
   * refresh token. Unset means nobody is sent to Google: the connect page
   * says calendar connection isn't available yet, no calendar link is minted,
   * and the adapter answers `misconfigured`/`oauth_client` without a request.
   */
  googleOAuthClientId: () => optional("GOOGLE_OAUTH_CLIENT_ID"),
  googleOAuthClientSecret: () => optional("GOOGLE_OAUTH_CLIENT_SECRET"),
  googleCalendarConfigured: (): boolean =>
    Boolean(optional("GOOGLE_OAUTH_CLIENT_ID") && optional("GOOGLE_OAUTH_CLIENT_SECRET")),

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
   * The live-booking kill switch (owner decision 4, 5 October 2026): anything
   * but the literal "true" means the assistant never books and every booking
   * is a request. Only the owner sets it: no commit, script, CI file,
   * Dockerfile, .env.example value or deploy step does. It gates the
   * assistant's own bookings only, never a staff confirmation's write, and
   * it is read on every call and never cached, so unsetting it stops the
   * assistant booking on the next one.
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
