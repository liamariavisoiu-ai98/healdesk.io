import { readFileSync } from "node:fs";
import { join } from "node:path";

import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";
import { expect, test } from "vitest";

/**
 * The usage-alerts switch said "80% and 100% emails"; the first email goes
 * at the catalog's USAGE_ALERT_PERCENT (90), so the label prints that
 * constant and cannot drift from the email again.
 */
test("the usage-alerts label prints the catalog's percent, not a number of its own", () => {
  const panel = readFileSync(join(__dirname, "BillingPanel.tsx"), "utf8");
  expect(USAGE_ALERT_PERCENT).toBe(90);
  expect(panel).toContain("{USAGE_ALERT_PERCENT}% and 100% emails");
  expect(panel).not.toMatch(/\b80% and 100%/);
  expect(panel).toContain('import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";');
});
