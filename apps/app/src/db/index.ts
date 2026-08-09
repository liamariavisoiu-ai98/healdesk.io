import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/lib/env";

import * as authSchema from "./auth-schema";
import * as appSchema from "./schema";

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

export const pool =
  globalForDb.__healdeskPool ??
  new Pool({
    connectionString,
    max: 10,
    // Managed Postgres (RDS, Supabase, Neon) requires TLS. The AWS BAA makes
    // "encrypt in transit" a contractual obligation, not a preference.
    ssl: env.isProduction() ? { rejectUnauthorized: true } : undefined,
  });

if (!env.isProduction()) globalForDb.__healdeskPool = pool;

/**
 * ⚠️ Bypasses tenant scoping. Identity plane and migrations only.
 * For anything with a clinic_id, use withTenant() instead.
 */
export const unsafeDb = drizzle(pool, { schema });

export type Database = typeof unsafeDb;
