import { destroyDueClinics } from "@/lib/offboarding/offboarding";

import { JOB_OFFBOARDING_DESTROY, runJob } from "./jobs";

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
