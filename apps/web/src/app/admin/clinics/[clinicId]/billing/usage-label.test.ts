import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { UsageSwitches } from "./BillingPanel";

/**
 * The usage-alerts switch said "80% and 100% emails"; the first email goes
 * at the catalog's USAGE_ALERT_PERCENT (90), so the label prints that
 * constant and cannot drift from the email again. Rendered, not grepped.
 */

const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

test("the usage-alerts label prints the catalog's percent, not a number of its own", () => {
  const e = { overageMode: "allow", usageAlertsEnabled: true } as unknown as Parameters<typeof UsageSwitches>[0]["e"];
  const actions = { setOverageMode: NEVER, setUsageAlerts: NEVER } as unknown as Parameters<typeof UsageSwitches>[0]["actions"];
  const text = renderToStaticMarkup(h(UsageSwitches, { e, actions }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  expect(USAGE_ALERT_PERCENT).toBe(90);
  expect(text).toContain("90% and 100% emails");
  expect(text).not.toMatch(/\b80%/);
});
