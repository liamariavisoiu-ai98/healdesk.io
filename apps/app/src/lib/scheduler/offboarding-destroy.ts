import { destroyDueClinics } from "@/lib/offboarding/offboarding";

import { JOB_OFFBOARDING_DESTROY, runJob } from "./jobs";

/**
 * The destruction job, behind its switch. tick.ts runs it every hour, and
 * every run destroys every clinic that is due, on either rule: a day before
 * its agreement's thirty days are up, or its ninety (lib/offboarding, "Which
 * rule, and why").
 */
export async function runOffboardingDestroyJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_OFFBOARDING_DESTROY,
    async () => {
      const results = await destroyDueClinics(now);
      const rows = results.reduce((a, r) => a + Object.values(r.deleted).reduce((x, y) => x + y, 0), 0);
      return results.length ? `Destroyed patient data for ${results.length} clinic(s), ${rows} rows.` : "Nothing due.";
    },
    now,
  );
}
