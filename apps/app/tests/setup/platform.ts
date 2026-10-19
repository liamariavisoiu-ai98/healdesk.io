import { PLATFORM_SUBJECTS, type PlatformSubject } from "@/lib/compliance/subjects";

import { getMigratorPool } from "./db";

/**
 * The platform's attestations for a test (platform_compliance, drizzle/0085),
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
