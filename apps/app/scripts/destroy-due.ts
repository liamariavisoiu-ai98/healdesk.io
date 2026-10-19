import { log } from "../src/lib/log";
import { closeAccountsDue } from "../src/lib/offboarding/account-closure";
import { destroyEverythingDue } from "../src/lib/offboarding/offboarding";

/**
 * Destroy, now, every clinic whose data is due, and fail while any is still
 * due: the check docs/handover.md ("Restoring") runs after any restore, before
 * the service reopens.
 *
 * A backup holds every clinic as it was when the backup was taken, so a
 * restore brings back the rows of a clinic destroyed since. With the dates it
 * was destroyed on (the step before this one puts back any the backup did not
 * hold, from the `clinic data destroyed` log line), it is due again, and this
 * destroys it again, on every rule at once, as any hourly run would. It runs
 * whether or not the offboarding-destroy job is switched on, and it exits
 * non-zero while any clinic is still due, for example one whose destruction
 * failed, so the step cannot pass quietly. It then closes every account due
 * (lib/offboarding/account-closure.ts): a backup older than a closure
 * brings the clinic's sign-in and setup back with its data.
 *
 *   npm run destroy-due -w @healdesk/app
 *
 * Ids and counts only; nothing about a patient is printed.
 */
async function main(): Promise<void> {
  const { destroyed, stillDue } = await destroyEverythingDue();
  log.info("destroy-due: destroyed every clinic due", { count: destroyed.length });
  const closed = await closeAccountsDue();
  log.info("destroy-due: closed every account due", { count: closed.length });
  for (const clinicId of stillDue)
    log.error("destroy-due: still due for destruction", { clinicId });
  process.exit(stillDue.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  log.error("destroy-due failed", { error: error instanceof Error ? error.name : "unknown error" });
  process.exit(1);
});
