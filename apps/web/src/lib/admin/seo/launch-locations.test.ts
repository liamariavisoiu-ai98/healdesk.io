import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PACKAGES, planFor } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { locationsLine } from "@/lib/checkout/review";

import { LAUNCH_PROMISES } from "./launch";

/**
 * Extra locations, under the copy-first rule (CLAUDE.md, "Copy first, then
 * the switch"): the spec sells each further location from Billing, on the
 * same plan, at the plan's price again plus its setup fee (spec, "More than
 * one location"), and the pricing page and the purchase say so. Production
 * cannot add one yet: apps/app's createLocationClinic is a stub, and
 * LOCATION_CLINICS_READY keeps addLocation refusing until healdesk-io-58's
 * Package C lands it. So while that flag is false the promise is an open
 * item in LAUNCH_PROMISES, shown at /admin/seo, and it does not hold go-live,
 * because one location works without it.
 */

const REPO = join(__dirname, "..", "..", "..", "..", "..", "..");

/** apps/app's flag, read from its source: apps/web may not import apps/app. */
function locationClinicsReady(): boolean {
  const source = readFileSync(join(REPO, "apps", "app", "src", "lib", "location-clinic.ts"), "utf8");
  const found = /export const LOCATION_CLINICS_READY = (true|false);/.exec(source);
  if (!found) throw new Error("LOCATION_CLINICS_READY is no longer a plain boolean in location-clinic.ts");
  return found[1] === "true";
}

describe("extra locations are promised as designed, and tracked until production adds them", () => {
  const item = LAUNCH_PROMISES.find((p) => p.id === "extra-locations");

  test("the purchase states the promise the item tracks", () => {
    const plan = planFor(PACKAGES[0]!.id, { voiceMinutes: 500, chatConversations: 300 });
    expect(locationsLine(plan, "month")).toMatch(/^This sets up one location\. Add more from Billing after setup: /);
    const pricing = readFileSync(join(REPO, "apps", "web", "src", "app", "pricing", "page.tsx"), "utf8");
    expect(pricing.replace(/\s+/g, " ")).toContain("added to the same plan from Billing in your portal");
  });

  test("while apps/app cannot add a location, the item is open and does not hold go-live", () => {
    // Once the flag flips, the item moves to On when that release is live in
    // production, which no test here can see.
    if (locationClinicsReady()) return;
    expect(item).toBeDefined();
    expect(item!.status).toBe("building");
    expect(item!.blocksGoLive).toBe(false);
    expect(item!.evidence).toContain("apps/app/src/lib/location-clinic.ts");
  });
});
