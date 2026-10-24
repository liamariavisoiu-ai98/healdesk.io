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
  // billing_requests (0050) cascades from clinics, and is named anyway beside
  // the rest of the billing ledger. 0057's tables all hang off clinics
  // (google_oauth_states by target_clinic_id), so the cascade empties them,
  // and RESTART IDENTITY puts clinics_client_number_seq back to its start.
  // platform_compliance (0090) has no clinic and no foreign key, so it is
  // named: an attestation left by one file would let the next file's
  // synthetic clinics go live by themselves (lib/onboarding/go-live.ts).
  // email_events (0099) has no clinic either: one file's counted sends would
  // be the next file's digest. voice_number_order_days (0107) has no clinic
  // either: one test's numbers bought would fill the next one's daily cap.
  await pool.query(`
    truncate table
      billing_events, billing_transitions, billing_requests, entitlements,
      audit_log, security_events, reconciliation_exceptions,
      webhook_events, sync_runs, transactions, appointments,
      conversations, contacts, provider_connections, clinic_touches,
      clinic_memberships, clinics, baa_acceptances,
      checkout_intents, sign_in_links, stripe_connect_events, stripe_connect_states,
      step_ups, webauthn_challenges, user_backup_codes, user_factors, factor_lockouts,
      invitation, member, organization, session, account, verification, "user",
      platform_compliance, email_events, voice_number_order_days
    restart identity cascade
  `);

  // The approval inbox (0119) can never be truncated or deleted from (its
  // triggers refuse it, the migrator included), so a waiting item one file
  // left would be the next file's Home row and proposer input: it is set
  // aside instead, by the one move the trigger allows, waiting to expired.
  await pool.query(`update ops_approvals set status = 'expired', decided_at = now() where status = 'waiting'`);

  await pool.query(`
    insert into scheduled_jobs (name, cadence, enabled) values
      ('monthly-report', 'Monthly, on the 1st, per clinic timezone', false),
      ('billing-sweep', 'Hourly; suspends past-due clinics after grace, rolls annual allowances monthly', false),
      ('retention-purge', 'Nightly; removes media references and rows past each clinic''s retention window, and processed webhook payloads older than 30 days', false),
      ('heartbeat', 'Every worker tick; last_run_at is the liveness signal', true),
      ('connection-health', 'Hourly; flags revoked connections, stale syncs and stuck webhooks, raises a revoked one to ops at once, and leaves the rest to the 07:00 ops digest', false),
      ('annual-renewal-reminder', 'Daily; emails the billing contact 30 days before an annual renewal, once per period', false),
      ('weekly-recap', 'Hourly; on each live clinic''s Monday from 08:00 its time, while no daily summary can carry it (the Daily summary switch is off, or the clinic has no hours on file), queues last week''s recap (L14) to the clinic''s address', false),
      ('daily-summary', 'Hourly; at each live clinic''s opening time on its working days, while its Daily summary switch is on, queues the daily summary (L13): the day''s counts, every booking and request since the last one, every request still open, and on the week''s first, last week''s recap', false),
      ('nightly-sync', 'Daily at 02:00 UTC; enqueues a sync per active connection, staggered; reconcile on the 1st', false),
      ('offboarding-destroy', 'Hourly; destroys each offboarded clinic''s patient data when the agreement its service ended under says: under BAA 1.2.2 and earlier from day 29, export or not; under BAA 1.3.0 and the DPA from day 29 once the export is delivered (from the delivery when later) and from day 89 without it', false),
      ('usage-meter-report', 'Hourly; reports overage on monthly plans to Stripe''s meters', false),
      ('annual-overage-invoice', 'Daily at 05 UTC; invoices annual plans'' overage per closed month', false),
      ('usage-alerts', 'Hourly; queues the 80% and 100% allowance emails', false),
      ('billing-notices', 'Every minute, from the notices queue; sends due email notices and retries, and holds kinds with no template yet', false),
      ('billing-housekeeping', 'Daily at 06 UTC; purges expired checkout intents and Meta message refs', false),
      ('billing-requests', 'Every minute from the billing-minute queue, and hourly from the tick as a backstop; carries out recorded plan starts, step-ups and immediate cancellations on Stripe, and setup closures while setup-closure is on', false),
      ('setup-closure', 'A switch, not a schedule: while on, the billing-requests worker closes accounts left with nothing live at the end of their 30-day setup window', false),
      ('billing-reconcile', 'Hourly; records any plan start, step-up or setup closure that is due but missing, steps up waiting channels after 30 days with a reminder a week before, and re-arms requests that can now go through', false),
      ('card-expiring', 'Daily at 07 UTC; queues the card-expiring email when the card on file expires before a renewal due within 30 days', false),
      ('dmarc-review', 'Daily at 08 UTC; on the 14th day after Resend first sent as healdesk.io, raises one ops alert, ever, to read the DMARC reports and move the record from p=none to p=quarantine', false),
      ('calendar-watch', 'Every 5 minutes on its own queue: forces a refresh and one free/busy probe per Google Calendar connection, disconnects what the terms no longer cover, flips a broken one to manual booking and alerts the clinic and ops once, resolves unconfirmed writes and owed desk notices, purges spent holds and OAuth states', false),
      ('setup-reminders', 'Hourly; while none of a clinic''s channels is live, queues the setup reminder due on day 5, 10, 15, 20, 25 or 30 of its setup window, counted back from the window''s last day, in the clinic''s daytime', false),
      ('incident-deadlines', 'Hourly; raises one ops alert, ever, for each open incident past the internal 24-hour notice target with no notice recorded', false),
      ('transcript-emails', 'Every minute, from the billing-minute queue: sends each queued transcript to its clinic through SES and retries a failed or bounced one with back-off; deletes each sealed copy SES has not reported delivered 30 days after it was queued, or 72 hours after a send nothing answered (a delivered one is deleted by SES''s event)', false),
      ('practice-questions', 'Every minute, from the practice-questions queue: runs each clinic''s due practice questions, one at a time per clinic, two minutes after its last change; hourly from the tick, asks for a run where a clinic''s inputs changed with none asked for, alerts ops on a review past its day, and sends O8 once a clinic''s tracker is complete', false),
      ('requests-still-open', 'Hourly; at each clinic''s opening hour, only while its daily summary is off, queues one email counting the booking requests taken before that opening that are still waiting for the desk', false),
      ('health-flags', 'Hourly; raises to ops, once each, a clinic with no interaction on any channel 48 hours after its first channel went live, and a live phone channel with no inbound call for 14 days. Internal: never shown to the clinic', false),
      ('ops-digest', 'Daily at 07 UTC, or the first hour after it, once a UTC day: emails ops every queue with the age of its oldest item, email health per kind, connection health and Resend''s daily count. Ids and counts only', false),
      ('ops-watch', 'Every minute from the billing-minute queue, and hourly from the tick: raises to ops, once each, a paid order with no account ten minutes after its payment reached the host, an order follow-up (B3) past its day, and, hourly, a support reply (L25) past its day with none marked', false),
      ('site-reads', 'Every minute, from the site-reads queue, and hourly from the tick: reads a clinic''s website again through apps/web''s signed route when it has a website and no profile, after it corrects its website, and when the drift check or an operator asks; reads nothing until HEALDESK_WEB_URL is set', false),
      ('website-drift', 'Hourly; asks for a read of each live clinic''s website 30 days after its last one, compares it with the purchase-time baseline per Knowledge section, and queues "Changes on your website" (L23) when it finds any. Off until the owner switches it on, before the first clinic''s 30th live day', false),
      ('location-quantity', 'Hourly; reads each account''s subscription in Stripe and compares the quantity it bills for locations with the account''s active locations, plus one being added whose charge is recorded. A mismatch is told to ops once until the counts agree again. Reads only: never changes a subscription. Off until the owner switches it on with extra locations', false),
      ('clinic-audits', 'Every minute from the billing-minute queue: audits each clinic two minutes after its last change to hours, closed days or providers; hourly from the tick, audits a clinic whose availability changed with nothing recorded; daily at 04 UTC, every pack for every clinic. Reads only, and records its results for ops. Off until the owner switches it on', false),
      ('clinic-audits-hourly', 'Hourly; audits a clinic whose availability changed with nothing recorded, and daily at 04 UTC every audit pack for every clinic in service. Reads only, and records its results for ops. Off until the owner switches it on', false),
      ('lifecycle-watch', 'Hourly; works out where each paying clinic stands in its setup, records each setup reminder it was sent, and raises the timed ops waves: Slack for routine ones, Slack and the ops address for escalations. Sends nothing to a clinic. Off until the owner switches it on', false),
      ('approvals-propose', 'Hourly; puts each billing change that failed at Stripe after every retry, each annual extra-usage invoice that failed and each Stripe event parked after its retries into the approval inbox, one item each, for the owner to approve or reject. Expires items past their window and re-alerts items past due. Never retries, invoices or replays anything itself. Off until the owner switches it on', false)
    on conflict (name) do update set enabled = (excluded.name = 'heartbeat'), updated_by = null
  `);
}

export async function closePools(): Promise<void> {
  await Promise.all([migratorPool?.end(), appPool?.end()]);
  migratorPool = undefined;
  appPool = undefined;
}
