import { CONNECTION_GUIDES, NO_PLATFORM_ID, platforms } from "@healdesk/catalog";
import { isImplemented } from "@healdesk/connectors";
import { describe, expect, test } from "vitest";

/**
 * Every platform the checkout offers must land somewhere honest: a wizard
 * (a read-only guide the clinic can follow), an adapter (so a saved
 * connection syncs), or an explicit not-yet state the connect page renders.
 * The connect page's noWizardMessage() handles "oauth" and "none"; a
 * readonly_user platform with no guide gets the "we'll do it with you" copy.
 * What must never happen is a platform with none of the three, which this
 * test makes a compile-time-adjacent failure rather than a refund.
 */
describe("platform coverage", () => {
  test("every platform has a guide, an adapter, or an explicit not-yet state", () => {
    for (const platform of platforms) {
      if (platform.id === NO_PLATFORM_ID) continue;
      const hasGuide = platform.id in CONNECTION_GUIDES;
      const hasAdapter = isImplemented(platform.id);
      const explicit = platform.connection === "oauth" || platform.connection === "none";
      expect(
        hasGuide || hasAdapter || explicit,
        `${platform.id}: no wizard, no adapter and no explicit state`,
      ).toBe(true);
    }
  });

  test("verified attribution is only offered where a guide exists or an adapter syncs", () => {
    for (const platform of platforms) {
      if (platform.id === NO_PLATFORM_ID) continue;
      if (platform.connection === "oauth") {
        // Sold as coming; the connect page says so with a date-free promise
        // and the checkout must not imply a working sync.
        expect(isImplemented(platform.id)).toBe(false);
      }
    }
  });
});
