import type { Config } from "drizzle-kit";

/**
 * The MARKETING database — leads, funnel events, rate-limit counters.
 *
 * Deliberately a different database from apps/app's. That one is the PHI
 * boundary and must never be reachable from the marketing site; this one holds
 * business contact data (a clinic owner's work email, the clinic's public
 * website) and abuse counters, none of which is patient data. Keeping them
 * apart is what lets apps/web stay on Vercel while apps/app moves to a BAA
 * host. See docs/hipaa-compliance.md.
 *
 * One role is enough here: there is no row-level security to enforce because
 * there is no tenant, and nothing in these tables is worth the two-role
 * ceremony the product database needs.
 */
export default {
  schema: ["./src/lib/db/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.MARKETING_DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
