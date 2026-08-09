import { sql } from "drizzle-orm";

import { unsafeDb, type Database } from "@/db";

import { AuditRecorder, type ActorContext, type RequestContext } from "./audit";

/**
 * The only door into patient data.
 *
 * Everything about this file exists to make one failure impossible: a query
 * that reads PHI without a clinic filter. Row-level security is the second
 * lock — this is the first.
 *
 * ## Why a transaction is mandatory
 *
 * RLS policies read the current clinic from a Postgres setting. The obvious
 * implementation is `SET app.clinic_id = ...`, and it is a data leak:
 *
 *   Request A → borrows pooled connection → SET app.clinic_id = 'clinic-a'
 *   Request A → finishes, returns connection to the pool
 *   Request B → borrows the SAME connection → inherits clinic A's access
 *
 * `set_config(..., is_local => true)` scopes the setting to the surrounding
 * transaction, so Postgres clears it on COMMIT or ROLLBACK whether or not we
 * remember to. That is why every tenant-scoped query runs inside
 * `db.transaction()` and why this wrapper is not optional.
 *
 * tests/tenant-isolation.test.ts asserts the leak does not happen, using a pool
 * of exactly one connection so reuse is guaranteed.
 *
 * ## The other three gotchas
 *
 *   - The runtime role must not have BYPASSRLS. Neon's `neondb_owner` and
 *     Supabase's `service_role` both do, silently.
 *   - The table OWNER bypasses RLS too, so migrations run as a different role
 *     and every table is FORCE ROW LEVEL SECURITY.
 *   - Policies read the setting via `(select current_setting(...))` so Postgres
 *     evaluates it once per query as an InitPlan, not once per row.
 *
 * See docs/hipaa-compliance.md.
 */

export const TENANT_GUC = "app.clinic_id";

export type TenantContext = {
  clinicId: string;
  actor: ActorContext;
  request?: RequestContext;
};

export type TenantTx = {
  /** Tenant-scoped handle. Every PHI table is filtered to this clinic by RLS. */
  db: Parameters<Parameters<Database["transaction"]>[0]>[0];
  /** Record PHI accesses here; flushed in the same transaction. */
  audit: AuditRecorder;
  clinicId: string;
};

export class TenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAccessError";
  }
}

/**
 * Run `fn` with the tenant GUC set for the life of one transaction.
 *
 * The callback receives a scoped `db` and an `audit` recorder. Audit entries
 * flush inside the same transaction as the work: if the read rolls back, the
 * claim that it happened rolls back with it.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenantOn(unsafeDb, context, fn);
}

/**
 * Same as withTenant, against an explicit database handle.
 *
 * Exists so tests can pass a single-connection pool and prove the GUC does not
 * survive into the next borrower. Production code should call withTenant().
 */
export async function withTenantOn<T>(
  database: Database,
  context: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const { clinicId, actor, request } = context;

  if (!isUuid(clinicId)) {
    // The GUC is interpolated into a cast in the policy; a malformed value
    // should fail here with a clear error rather than deep inside Postgres.
    throw new TenantAccessError(`Invalid clinic id: ${clinicId}`);
  }

  return database.transaction(async (tx) => {
    // is_local = true — the third argument is the whole point. Without it the
    // setting outlives the transaction and leaks across pooled connections.
    await tx.execute(
      sql`select set_config(${TENANT_GUC}, ${clinicId}, true)`,
    );

    const audit = new AuditRecorder(clinicId, actor, request);
    const result = await fn({ db: tx, audit, clinicId });

    await audit.flush(tx);
    return result;
  });
}

/**
 * Run without any tenant set, to prove RLS is doing the work.
 *
 * Used only by tests: a query through this should return zero rows from every
 * PHI table. If it returns data, RLS is not enabled, not forced, or the runtime
 * role is bypassing it.
 */
export async function withoutTenant<T>(
  database: Database,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return fn(database);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
