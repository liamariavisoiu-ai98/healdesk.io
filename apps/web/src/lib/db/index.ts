import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * The marketing database handle.
 *
 * Lazy on purpose. Nothing here connects at import time, because this module
 * is imported by route handlers that must build and boot without a database
 * (the site's static pages, `next build` on Vercel). The first call that needs
 * the database creates the pool; a missing MARKETING_DATABASE_URL is
 * discovered then, by the caller, which decides whether that is fatal (the
 * rate limiter in production) or survivable (the lead store, which fails open
 * so a lost lead never blocks a demo).
 *
 * This is NOT apps/app's database and must never point at it. See
 * drizzle.config.ts for why they are separate.
 */

export { schema };

export function isMarketingDbConfigured(): boolean {
  return Boolean(process.env.MARKETING_DATABASE_URL);
}

const globalForDb = globalThis as unknown as { __healdeskMarketingPool?: Pool };

function sslConfig(url: string): { rejectUnauthorized: boolean } | undefined {
  // sslmode=disable opts out for a local container; managed Postgres gets TLS.
  if (/[?&]sslmode=disable(&|$)/.test(url)) return undefined;
  return process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: true }
    : undefined;
}

export function marketingPool(): Pool {
  const url = process.env.MARKETING_DATABASE_URL;
  if (!url) {
    throw new Error(
      "MARKETING_DATABASE_URL is not set. The marketing database holds leads and rate-limit counters; see .env.example.",
    );
  }
  const existing = globalForDb.__healdeskMarketingPool;
  if (existing) return existing;
  const pool = new Pool({ connectionString: url, max: 5, ssl: sslConfig(url) });
  // Reuse across hot reloads in development; otherwise every edit leaks connections.
  if (process.env.NODE_ENV !== "production") globalForDb.__healdeskMarketingPool = pool;
  else globalForDb.__healdeskMarketingPool = pool;
  return pool;
}

export function marketingDb() {
  return drizzle(marketingPool(), { schema });
}

export type MarketingDb = ReturnType<typeof marketingDb>;

/** Tests swap the pool for one pointed at a scratch database. */
export function __setMarketingPoolForTests(pool: Pool | undefined): void {
  globalForDb.__healdeskMarketingPool = pool;
}
