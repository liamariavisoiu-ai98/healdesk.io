import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/lib/env";

import * as authSchema from "./auth-schema";
import * as appSchema from "./schema";
import { log } from "@/lib/log";

/**
 * Database clients.
 *
 * ⚠️ There is deliberately NO `db` export.
 *
 * A general-purpose handle is how tenant isolation dies: someone imports it in
 * a hurry, forgets `where(eq(t.clinicId, ...))`, and one clinic reads another's
 * patients. Row-level security is the second lock, but the first lock has to be
 * structural — so the only way to touch PHI is `withTenant()` in src/lib/tenant.ts,
 * which opens a transaction and sets the tenant GUC before any statement runs.
 *
 * `unsafeDb` exists for the two places that legitimately have no tenant:
 *   1. Better Auth's adapter (the identity plane — user, session, organization)
 *   2. migrations and seed scripts
 *
 * It is named to be uncomfortable. If you are reaching for it anywhere else,
 * you are about to write a cross-tenant leak.
 *
 * See docs/hipaa-compliance.md → "Rules that keep apps/app portable".
 */

export const schema = { ...appSchema, ...authSchema };

const connectionString = env.databaseUrl();

// Reuse the pool across hot reloads; otherwise every edit leaks connections.
const globalForDb = globalThis as unknown as { __healdeskPool?: Pool };

/**
 * TLS policy.
 *
 * Required in production by default: the AWS BAA makes "encrypt in transit" a
 * contractual obligation, not a preference, and managed Postgres (RDS,
 * Supabase, Neon) expects it.
 *
 * A running production process gets here only with a URL that carries
 * sslmode=verify-full: env.databaseUrl() refuses anything else, because pg
 * lets the URL's sslmode replace the object returned below, and pg-boss's
 * pool has no object of its own. So in production the URL decides, and this
 * default is the floor if that check is ever loosened.
 *
 * `sslmode=disable` still opts out everywhere else: local development and
 * tests, which have no TLS default to opt out of, and `next build`, which
 * imports this module under NODE_ENV=production without connecting and gets
 * the warning below (CI builds with a plaintext URL to its service
 * container). It no longer opts a running production server out, where "TLS
 * is terminated elsewhere" would be the hop the BAA covers.
 */
function sslConfig(url: string): { rejectUnauthorized: boolean } | undefined {
  const disabled = /[?&]sslmode=disable(&|$)/.test(url);

  if (disabled) {
    if (env.isProduction()) {
      log.warn(
        "TLS to the database is DISABLED via sslmode=disable. " +
          "This is only acceptable if encryption is terminated elsewhere.",
      );
    }
    return undefined;
  }

  return env.isProduction() ? { rejectUnauthorized: true } : undefined;
}

export const pool =
  globalForDb.__healdeskPool ??
  new Pool({
    connectionString,
    max: 10,
    ssl: sslConfig(connectionString),
  });

if (!env.isProduction()) globalForDb.__healdeskPool = pool;

/**
 * ⚠️ Bypasses tenant scoping. Identity plane and migrations only.
 * For anything with a clinic_id, use withTenant() instead.
 */
export const unsafeDb = drizzle(pool, { schema });

export type Database = typeof unsafeDb;

/**
 * The handle inside `db.transaction(...)`.
 *
 * Named here so tenant.ts and audit.ts can both refer to it without
 * re-deriving it, and without importing each other for a type.
 */
export type Transaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** Anything that can run a query: the pool handle or a transaction. */
export type Queryable = Database | Transaction;
