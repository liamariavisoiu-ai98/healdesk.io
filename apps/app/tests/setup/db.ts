import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Database harness for the isolation tests.
 *
 * Two pools on purpose, because the whole point of these tests is that the
 * roles differ:
 *
 *   migratorPool — owns the schema. Used to set up fixtures and to inspect
 *                  catalog state. Bypasses RLS unless tables are FORCEd, which
 *                  is exactly what the drift test verifies.
 *
 *   appPool      — the runtime role. Everything the application does goes
 *                  through this, and it must never see another clinic's rows.
 *
 * Set TEST_MIGRATOR_URL and TEST_APP_URL to run these. Without them the
 * database-backed suites skip rather than fail, so `npm test` still works on a
 * machine with no Postgres.
 */

export const MIGRATOR_URL = process.env.TEST_MIGRATOR_URL;
export const APP_URL = process.env.TEST_APP_URL;

export const hasTestDatabase = Boolean(MIGRATOR_URL && APP_URL);

let migratorPool: Pool | undefined;
let appPool: Pool | undefined;

export function getMigratorPool(): Pool {
  if (!MIGRATOR_URL) throw new Error("TEST_MIGRATOR_URL is not set.");
  migratorPool ??= new Pool({ connectionString: MIGRATOR_URL, max: 4 });
  return migratorPool;
}

export function getAppPool(): Pool {
  if (!APP_URL) throw new Error("TEST_APP_URL is not set.");
  appPool ??= new Pool({ connectionString: APP_URL, max: 4 });
  return appPool;
}

export function getAppDb() {
  return drizzle(getAppPool());
}

export async function runMigrations(): Promise<void> {
  const db = drizzle(getMigratorPool());
  await migrate(db, { migrationsFolder: "./drizzle" });
}

/**
 * Truncate as the migrator, since the app role deliberately cannot DELETE from
 * audit_log — append-only is enforced by grant, not convention.
 *
 * `scheduled_jobs` is caught in the blast radius: it has an `updated_by` FK to
 * `user`, so CASCADE takes it out along with the rows the migration seeded.
 * Re-seeding here keeps the job definitions where they belong (migrations)
 * while leaving the test database in the state a fresh deployment would have —
 * every job present and switched OFF.
 */
export async function truncateAll(): Promise<void> {
  const pool = getMigratorPool();

  // billing_events first and by name: it has no foreign keys, so nothing
  // cascades into it, and a dedupe ledger left over from the previous run
  // would make every replayed fixture event a silent no-op. The same holds
  // for the identity-plane tables 0043 added without foreign keys
  // (checkout_intents, stripe_connect_events, stripe_connect_states).
  await pool.query(`
    truncate table
      billing_events, billing_transitions, entitlements,
      audit_log, security_events, reconciliation_exceptions,
      webhook_events, sync_runs, transactions, appointments,
      conversations, contacts, provider_connections, clinic_touches,
      clinic_memberships, clinics, baa_acceptances,
      checkout_intents, sign_in_links, stripe_connect_events, stripe_connect_states,
      invitation, member, organization, session, account, verification, "user"
    restart identity cascade
  `);

  await pool.query(`
    insert into scheduled_jobs (name, cadence, enabled) values
      ('monthly-report', 'Monthly, on the 1st, per clinic timezone', false),
      ('billing-sweep', 'Hourly; suspends past-due clinics after grace, rolls annual allowances monthly', false),
      ('retention-purge', 'Nightly; removes media references and rows past each clinic''s retention window, and processed webhook payloads older than 30 days', false),
      ('heartbeat', 'Every worker tick; last_run_at is the liveness signal', true),
      ('connection-health', 'Hourly; flags revoked connections, stale syncs and stuck webhooks, emails ops one digest', false),
      ('annual-renewal-reminder', 'Daily; emails the billing contact 30 days before an annual renewal, once per period', false),
      ('weekly-recap', 'Hourly check; sends each live clinic a 7-day recap on its own Monday morning, and a first one on day 7', false),
      ('nightly-sync', 'Daily at 02:00 UTC; enqueues a sync per active connection, staggered; reconcile on the 1st', false),
      ('offboarding-destroy', 'Daily; destroys the patient data of clinics whose destroy_after has passed and whose export was delivered', false),
      ('usage-meter-report', 'Hourly; reports overage on monthly plans to Stripe''s meters', false),
      ('annual-overage-invoice', 'Daily at 05 UTC; invoices annual plans'' overage per closed month', false),
      ('usage-alerts', 'Hourly; queues the 80% and 100% allowance emails', false),
      ('billing-notices', 'Every minute, from the notices queue; sends due email notices and retries, and holds kinds with no template yet', false),
      ('billing-housekeeping', 'Daily at 06 UTC; purges expired checkout intents and Meta message refs', false)
    on conflict (name) do update set enabled = (excluded.name = 'heartbeat'), updated_by = null
  `);
}

export async function closePools(): Promise<void> {
  await Promise.all([migratorPool?.end(), appPool?.end()]);
  migratorPool = undefined;
  appPool = undefined;
}
