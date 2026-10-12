import { log } from "../src/lib/log";
import { reapplyErasures } from "../src/lib/patient-rights/erasure";

/**
 * Delete again, now, every person whose deletion the restored database still
 * remembers, and fail if any clinic could not be done: the step
 * docs/handover.md ("Restoring") runs after any restore, beside destroy-due,
 * before the service reopens.
 *
 * A backup holds everyone as they were when it was taken, so a restore brings
 * back a person deleted since. The record of their request (erasure_requests)
 * keeps keyed references to the numbers, addresses and messaging threads the
 * deletion found, for the 35 days a backup can bring them back, and this
 * finds them with those and deletes what was recorded no later than the
 * deletion ran, so anything the person gave afterwards stays. It writes no
 * new record. A restore to a point before a deletion loses its record too:
 * the handover says how the records are carried over first.
 *
 *   npm run reapply-erasures -w @healdesk/app
 *
 * Ids and counts only; nothing about a patient is printed.
 */
async function main(): Promise<void> {
  const result = await reapplyErasures();
  log.info("reapply-erasures: done", {
    count: result.requests,
    matched: result.reapplied,
    deleted: result.rows,
    // Threads the restored data shows shared: kept, as the deletion keeps them.
    kept: result.keptSharedThreads,
    failures: result.failures,
  });
  process.exit(result.failures > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  log.error("reapply-erasures failed", {
    error: error instanceof Error ? error.name : "unknown error",
  });
  process.exit(1);
});
