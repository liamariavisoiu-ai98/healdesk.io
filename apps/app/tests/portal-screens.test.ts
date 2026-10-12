import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";

/**
 * The portal's screens as a clinic's browser receives them (plan Part F),
 * rendered from a provisioned clinic with the sign-in stood in: what each
 * screen says, that nothing on it is about a patient, and that every link on
 * it goes somewhere this build has (tests/setup/portal-links.ts).
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const grants: { clinicId: string; slug: string; name: string }[] = [];

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "the clinic's sign-in", steppedUp: false }),
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

let clinic: PortalClinic;

async function renderHome(): Promise<string> {
  const { default: ClinicHome } = await import("@/app/c/[slug]/page");
  return renderToStaticMarkup(
    await ClinicHome({ params: Promise.resolve({ slug: portal.clinicSlug }) }),
  );
}

describeDb("the portal's screens", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("screens");
    Object.assign(portal, {
      userId: clinic.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.clinicSlug,
    });
    grants.splice(0, grants.length, {
      clinicId: clinic.clinicId,
      slug: clinic.clinicSlug,
      name: "screens Med Spa LLC",
    });
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  describe("Home", () => {
    test("before go-live: the header's line, what needs the clinic, the tracker, the locked preview, the channels and the plan", async () => {
      const html = await renderHome();
      expect(html).toContain("AYA isn’t answering patients yet.");
      expect(html).toContain(`href="/c/${portal.clinicSlug}#tracker"`);
      expect(html).toContain("Needs attention");
      expect(html).toContain("Setup isn&#x27;t finished: 4 steps left.");
      expect(html).toContain("Building your AYA");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Talk to your AYA<\/button>/);
      expect(html).toContain("Website chat");
      expect(html).toContain("Phone");
      expect(html).toContain("Monthly billing ($897) starts the day AYA first answers a patient.");
      // No dates for a channel's opening, and no newness words.
      expect(html).not.toMatch(/opens? (on )?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
      expect(html).not.toMatch(/\b(pilot|beta|early access|founding|cohort)\b/i);
      expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
    });

    test("the menu: Conversations and Bookings say they open after go-live and are not links", async () => {
      const html = await renderHome();
      expect(html).toMatch(/<a href="\/c\/[^"]+" aria-current="page"[^>]*>Home<\/a>/);
      expect(html).toMatch(
        /aria-disabled="true"[^>]*><span[^>]*>Conversations<\/span><span[^>]*>Opens after go-live/,
      );
      expect(html).toMatch(
        /aria-disabled="true"[^>]*><span[^>]*>Bookings<\/span><span[^>]*>Opens after go-live/,
      );
      expect(html).not.toContain("/conversations");
      expect(html).not.toContain("/bookings");
    });

    test("one location shows no switcher; several show the others, each a link to the same screen", async () => {
      expect(await renderHome()).not.toContain("switch location");
      grants.push({
        clinicId: "00000000-0000-4000-8000-000000000001",
        slug: "screens-uptown",
        name: "Uptown",
      });
      try {
        const html = await renderHome();
        expect(html).toContain("switch location");
        expect(html).toContain('href="/c/screens-uptown"');
      } finally {
        grants.pop();
      }
    });

    test("an address that bounces is the first thing Home says", async () => {
      await inTenant(clinic.clinicId, async (c) => {
        await c.query(
          `insert into report_deliveries (clinic_id, kind, period_key, recipient, status, delivery_status, delivery_at)
           values ($1, 'setup_reminder', 'bounce-test', $2, 'sent', 'bounced', now())`,
          [clinic.clinicId, clinic.email],
        );
      });
      const html = await renderHome();
      const attention = html.slice(html.indexOf("Needs attention"));
      expect(attention.indexOf(`We can&#x27;t email ${clinic.email}`)).toBeGreaterThan(0);
      expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
    });
  });
});
