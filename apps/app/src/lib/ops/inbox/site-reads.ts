import { opListSiteReadFailures } from "../account-ops";

import type { InboxSource } from "./types";

/**
 * Purchases whose website could not be read, and that no later read has
 * filled (listSiteReadFailures, `profileSince` false). One row for all of
 * them: the queue page lists each purchase. The buyer's typed name and
 * website stay on that page; they are a buyer's words, not ours.
 */
export const siteReadsSource: InboxSource = {
  name: "the site reads",
  async read(ctx) {
    const outcome = await opListSiteReadFailures(ctx.operator);
    if (outcome.status !== 200 || !("data" in outcome.body)) throw new Error("site reads not answered");
    const { failures } = outcome.body.data as { failures: { profileSince: boolean }[] };
    const open = failures.filter((f) => !f.profileSince).length;
    if (open === 0) return { rows: [] };
    return {
      rows: [
        {
          id: "site-read:all",
          kind: "site_read",
          count: open,
          sentence: "Purchases whose website could not be read: read them again.",
          clinic: null,
          button: { label: "Open site reads", kind: "link", href: "/admin/site-reads" },
          tone: "warn",
          dueAt: null,
        },
      ],
    };
  },
};
