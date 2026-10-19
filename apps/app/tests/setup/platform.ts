import { PLATFORM_SUBJECTS, type PlatformSubject } from "@/lib/compliance/subjects";

import { getMigratorPool } from "./db";

/**
 * The platform's attestations for a test (platform_compliance, drizzle/0088),
 * written as the migrator outside any tenant, as the ops envelope writes
 * them. Every channel's `live` and every clinic's go-live read them, so a
 * file that takes channels live attests what they need first; truncateAll
 * empties the table between files.
 */
export async function attestPlatform(
  subjects: readonly PlatformSubject[] = PLATFORM_SUBJECTS,
  options: { effectiveOn?: string; expiresOn?: string | null } = {},
): Promise<void> {
  for (const subject of subjects) {
    await getMigratorPool().query(
      `insert into platform_compliance (subject, action, document_ref, effective_on, expires_on, actor_label)
       values ($1, 'attested', 'Test fixture: synthetic attestation',
               coalesce($3::date, (now() at time zone 'utc')::date), $2, 'ops@healdesk.test')`,
      [subject, options.expiresOn ?? null, options.effectiveOn ?? null],
    );
  }
}

/** Withdraw each subject, as an operator's withdrawal is recorded: a row of its own. */
export async function withdrawPlatform(subjects: readonly PlatformSubject[]): Promise<void> {
  for (const subject of subjects) {
    await getMigratorPool().query(
      `insert into platform_compliance (subject, action, document_ref, effective_on, actor_label)
       values ($1, 'withdrawn', 'Test fixture: withdrawn', (now() at time zone 'utc')::date, 'ops@healdesk.test')`,
      [subject],
    );
  }
}

/**
 * Stand in for the commit that builds what Gate B asks of the code (the
 * routed/answered counter, its miss notice, the live emails): it redefines
 * app_gate_b_code_built() to true (drizzle/0088), as the migrator, which
 * owns it. A file that does so puts it back to false in afterAll, the
 * migration's own definition, so the next file reads the database as main
 * leaves it. The TypeScript half is each file's mock of gateBNotBuilt.
 */
export async function setGateBCodeBuilt(built: boolean): Promise<void> {
  await getMigratorPool().query(
    `create or replace function app_gate_b_code_built() returns boolean language sql stable
       set search_path = public, pg_temp as $$ select ${built ? "true" : "false"} $$`,
  );
}
