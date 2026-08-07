import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * Database client.
 *
 * Deliberately plain `pg` over a DATABASE_URL — NOT @vercel/postgres, and not
 * an edge-only driver. apps/app has to be able to move to BAA-covered infra
 * (AWS / Fly / Render + Supabase or Neon) without a rewrite, and a
 * platform-specific driver is the fastest way to lose that.
 *
 * See docs/hipaa-compliance.md → "Rules that keep apps/app portable".
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.NODE_ENV === "production") {
  throw new Error("DATABASE_URL is required.");
}

// Reuse the pool across hot reloads in dev; otherwise every edit leaks connections.
const globalForDb = globalThis as unknown as { __healdeskPool?: Pool };

const pool =
  globalForDb.__healdeskPool ??
  new Pool({
    connectionString,
    max: 10,
    // Managed Postgres (Supabase, Neon, RDS) requires TLS.
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__healdeskPool = pool;
}

export const db = drizzle(pool, { schema });
export { schema };
