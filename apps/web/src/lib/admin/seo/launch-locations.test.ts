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

/**
 * The owner's decision of 20 October 2026: a practice's locations are one
 * account answered by one central AYA, like a call centre, not a separate
 * assistant for each. The first release switches on the two chat packages;
 * phone per location and calendars per location follow. These read the
 * items' own words only, so they hold whichever switch apps/app offers Add a
 * location behind.
 */
describe("the locations items describe one central AYA, and none of them holds go-live", () => {
  const byId = (id: string) => LAUNCH_PROMISES.find((p) => p.id === id);

  test("extra-locations promises one central assistant for every location, not a setup per location", () => {
    const item = byId("extra-locations")!;
    expect(item.promise).toContain(
      "One AYA answers for every location of a practice, as one central assistant",
    );
    expect(item.promise).toContain("at the plan's price again plus its setup fee once");
    expect(`${item.promise} ${item.left}`).not.toMatch(/its own setup|own agent configuration/);
    expect(item.left).toContain("AYA Web Chat and AYA Meta Chat packages bought first");
    expect(item.evidence).toContain("packages/catalog/src/central-assistant-acknowledgement.ts");
  });

  test("phone per location and the requests-only rule for later locations are tracked as building", () => {
    const phone = byId("location-phone");
    const calendar = byId("location-calendar");
    expect(phone?.status).toBe("building");
    expect(phone!.promise).toContain("forwards its own line to its own AYA number");
    expect(phone!.promise).toContain("that location's own direct line");
    expect(calendar?.status).toBe("building");
    expect(calendar!.promise).toContain("takes booking requests your team confirms");
    expect(calendar!.promise).toContain("nothing about it reaches Google Calendar");
  });

  test("no locations item holds go-live: an open item that did would stop every clinic's", () => {
    // launch.ts: no clinic goes live while an item that blocks go-live is
    // open, and one location works without any of these.
    for (const id of ["extra-locations", "location-phone", "location-calendar"]) {
      const item = byId(id);
      expect(item, id).toBeDefined();
      expect(item!.blocksGoLive, id).toBe(false);
      expect(item!.status, id).not.toBe("on");
    }
  });
});
