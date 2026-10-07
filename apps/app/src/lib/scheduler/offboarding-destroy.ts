import { destroyDueClinics } from "@/lib/offboarding/offboarding";

import { JOB_OFFBOARDING_DESTROY, runJob } from "./jobs";

/**
 * The destruction job, behind its switch. tick.ts runs it every hour and says
 * whether this is the once-a-day run (04 UTC), the only one that destroys a
 * clinic on the DPA's rule; a clinic on the thirty days goes at the first run
 * once it is due (lib/offboarding, "Which rule, and why").
 */
export async function runOffboardingDestroyJob(options: { now?: Date; dailyRun?: boolean } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_OFFBOARDING_DESTROY,
    async () => {
      const results = await destroyDueClinics(now, { dailyRun: options.dailyRun ?? true });
      const rows = results.reduce((a, r) => a + Object.values(r.deleted).reduce((x, y) => x + y, 0), 0);
      return results.length ? `Destroyed patient data for ${results.length} clinic(s), ${rows} rows.` : "Nothing due.";
    },
    now,
  );
}
