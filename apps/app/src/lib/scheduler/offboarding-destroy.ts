import { closeAccountsDue } from "@/lib/offboarding/account-closure";
import { destroyDueClinics } from "@/lib/offboarding/offboarding";

import { JOB_OFFBOARDING_DESTROY, runWideningJob } from "./jobs";

/**
 * The destruction job. tick.ts runs it every hour, and every run destroys
 * every clinic that is due, on either rule: a day before its agreement's
 * thirty days are up, or its ninety (lib/offboarding, "Which rule, and why").
 *
 * Which clinics: the job ships switched off (drizzle/0034), but its switch
 * widens the run rather than starting it, as retention-purge's does. A
 * clinic whose service ended under an agreement that states the export rule,
 * read from that version's own Term clause (BAA 1.3.0 and the DPA today), is
 * processed every run whatever the switch says, the day-21 export alert
 * included (exportRuleIsPromised); the switch adds every other clinic. Until
 * the calendar session's re-audit (C19, 12 October 2026) the job ran through
 * runJob, so 1.3.0's destruction deadlines waited on a switch that ships
 * off, and nothing told ops it was off; the note below now says it is.
 *
 * After the destruction, every run closes the accounts that are due
 * (lib/offboarding/account-closure.ts): a destroyed clinic whose
 * pass-through has ended, and that waits on nothing else, loses its sign-in
 * and its setup, keeping only the agreements, the billing records and the
 * records the law needs. Whatever the switch says, like the number's
 * release: Terms §3 and §7 promise it. A closure that fails makes the run
 * fail, with the destruction's note, so the console shows it as well as ops'
 * alert.
 */
export async function runOffboardingDestroyJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runWideningJob(
    JOB_OFFBOARDING_DESTROY,
    async (switchedOn) => {
      const results = await destroyDueClinics(now, { onlyPromised: !switchedOn });
      const closures = await closeAccountsDue();
      const rows = results.reduce(
        (a, r) => a + Object.values(r.deleted).reduce((x, y) => x + y, 0),
        0,
      );
      const note =
        (switchedOn
          ? ""
          : "Switched off: only the clinics whose agreement states the export rule (BAA 1.3.0, the DPA). ") +
        (results.length
          ? `Destroyed patient data for ${results.length} clinic(s), ${rows} rows.`
          : "Nothing due.") +
        (closures.closed.length ? ` Closed ${closures.closed.length} account(s).` : "") +
        (closures.waiting.length
          ? ` ${closures.waiting.length} account(s) waiting to close (ops told).`
          : "");
      if (closures.failed.length) {
        throw new Error(`${note} ${closures.failed.length} account closure(s) failed.`);
      }
      return note;
    },
    now,
  );
}
