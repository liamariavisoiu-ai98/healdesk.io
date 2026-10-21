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
 * cannot add one yet: apps/app's locationsReady (lib/locations.ts) is false
 * for every package, so addLocation refuses, until the add creates a
 * location of the account (the extra-locations plan's step 8) and switch 1
 * turns it on for the chat packages. So while no package may add one the
 * promise is an open item in LAUNCH_PROMISES, shown at /admin/seo, and it
 * does not hold go-live, because one location works without it.
 */

const REPO = join(__dirname, "..", "..", "..", "..", "..", "..");

/**
 * The packages apps/app lets add a location (LOCATIONS_READY_PACKAGES), read
 * from its source: apps/web may not import apps/app.
 */
function locationsReadyPackages(): string[] {
  const source = readFileSync(join(REPO, "apps", "app", "src", "lib", "locations.ts"), "utf8");
  const found =
    /export const LOCATIONS_READY_PACKAGES: readonly PackageId\[\] = \[([^\]]*)\];/.exec(source);
  if (!found)
    throw new Error("LOCATIONS_READY_PACKAGES is no longer a plain array in lib/locations.ts");
  const ids = [...found[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  for (const id of ids) {
    if (!PACKAGES.some((p) => p.id === id)) throw new Error(`${id} is not a package`);
  }
  return ids;
}

describe("extra locations are promised as designed, and tracked until production adds them", () => {
  const item = LAUNCH_PROMISES.find((p) => p.id === "extra-locations");

  test("the purchase states the promise the item tracks", () => {
    const plan = planFor(PACKAGES[0]!.id, { voiceMinutes: 500, chatConversations: 300 });
    expect(locationsLine(plan, "month")).toMatch(
      /^This sets up one location\. Add more from Billing after setup: /,
    );
    const pricing = readFileSync(
      join(REPO, "apps", "web", "src", "app", "pricing", "page.tsx"),
      "utf8",
    );
    expect(pricing.replace(/\s+/g, " ")).toContain(
      "added to the same plan from Billing in your portal",
    );
  });

  test("the portal's Billing states the same promise, names no inbox for it, and the item says where", () => {
    // Until 19 October 2026 Billing's card asked the clinic to email
    // hello@healdesk.io, which could not add a location either.
    const billing = readFileSync(
      join(REPO, "apps", "app", "src", "app", "c", "[slug]", "billing", "page.tsx"),
      "utf8",
    );
    const card = billing.slice(billing.indexOf(">Add a location</h3>"));
    const cardEnd = card.indexOf("</div>");
    expect(cardEnd).toBeGreaterThan(0);
    const words = card.slice(0, cardEnd).replace(/\s+/g, " ");
    expect(words).toContain("Each further location is added to this plan from Billing");
    expect(words).not.toMatch(/mailto:|hello@/);
    expect(item!.where).toContain("the portal's Billing (Add a location)");
    expect(item!.left).not.toMatch(/hello@/);
  });

  test("while apps/app lets no package add a location, the item is open and does not hold go-live", () => {
    // Once switch 1 turns the chat packages on, the item moves to On when
    // that release is live in production, which no test here can see.
    if (locationsReadyPackages().length > 0) return;
    expect(item).toBeDefined();
    expect(item!.status).toBe("building");
    expect(item!.blocksGoLive).toBe(false);
    expect(item!.evidence).toContain("apps/app/src/lib/locations.ts");
  });
});
