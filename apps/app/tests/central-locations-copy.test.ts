import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { copyProblems, visibleText } from "@/lib/email/lint";
import { clinicReason } from "@/lib/email/templates/context";
import { LOCATION_ADDED_ENTRY } from "@/lib/email/templates/location_added";
import type { TemplateContext } from "@/lib/email/templates/types";
import { portalMetaOutcome } from "@/lib/meta/portal-return";
import { connectRefusalText } from "@/lib/portal/settings-calendar";
import { calendarNoticeWords } from "@/lib/setup/calendar";

/**
 * The portal's words for a practice with several locations, under the
 * owner's decision of 20 October 2026: one account, answered by one central
 * AYA like a call centre, not a separate assistant (or a separate setup, a
 * separate Google account, a separate Page) for each location.
 *
 * Copy first, then the switch (CLAUDE.md): these say what the product is
 * designed to do before Add a location is offered, and LAUNCH_PROMISES'
 * "extra-locations" tracks the gap. Until then the words said the old design,
 * in which a location was its own healdesk account: the calendar and Meta
 * refusals told a practice that "each location connects its own", the
 * location-added email and the Billing toast sent it to a setup of its own,
 * the wizard asked which location "this AYA" was for, and the portal's
 * switcher called the separate accounts one sign-in opens "locations".
 */

const SRC = join(__dirname, "..", "src");

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  vi.stubEnv("HEALDESK_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function source(path: string): string {
  return readFileSync(join(SRC, path), "utf8");
}

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const context: TemplateContext = {
  clinicName: "Radiance Med Spa",
  audience: "patients",
  reason: clinicReason("Radiance Med Spa"),
  raisedAt: new Date("2026-10-20T14:00:00Z"),
  timeZone: "America/New_York",
};

describe("a refusal between accounts says accounts", () => {
  const ACCOUNT_IN_USE =
    /^That Google account is already connected to another healdesk account[,;] /;

  test("the calendar refusals name another account, and no per-location rule", () => {
    // One Google account connects to one healdesk account (the one-account
    // index); under the central model that is the boundary, not a location.
    const setup = calendarNoticeWords("account_in_use", null).text;
    const settings = connectRefusalText("account_in_use");
    expect(setup).toMatch(ACCOUNT_IN_USE);
    expect(settings).toMatch(ACCOUNT_IN_USE);
    const link = source("app/calendar/[token]/CalendarView.tsx");
    expect(link).toContain(
      '"That Google account is already connected to another healdesk account; nothing was stored."',
    );
    for (const text of [setup, settings, link]) {
      expect(text).not.toMatch(/another healdesk location|Each location connects its own/);
    }
  });

  test("the Meta refusal for two Pages says the account answers on one Page for all its locations", () => {
    const portal = portalMetaOutcome("several_pages");
    const words =
      "More than one Page was chosen. Your account answers on one Facebook Page for all your locations, so sign in again and choose only that Page.";
    expect(portal).toEqual({ ok: false, text: words });
    expect(source("app/channels/meta/[token]/page.tsx")).toContain(`"${words}"`);
  });
});

describe("adding a location adds it to the one AYA, not a setup of its own", () => {
  test("the location-added email says the same AYA answers for it, in both branches", () => {
    for (const isBeforeStart of [false, true]) {
      const email = LOCATION_ADDED_ENTRY.render(
        { ...LOCATION_ADDED_ENTRY.fixture, isBeforeStart },
        context,
      );
      const words = visibleText(email.html).replace(/\s+/g, " ");
      expect(email.preheader).toBe("The same AYA answers for every one of your locations.");
      expect(words).toContain(
        "The same AYA answers for every location, as one central assistant with one knowledge base and price list. It answers for this one once you confirm its address, hours and phone numbers in your portal.",
      );
      expect(`${email.preheader} ${email.text}`).not.toMatch(/its own setup/);
      expect(copyProblems(words)).toEqual([]);
    }
  });

  test("the Billing toast asks for the location's facts, not a new setup", () => {
    const actions = source("app/c/[slug]/billing/actions.ts");
    expect(actions).toContain(
      '"The location is added. Next, confirm its address, hours and phone numbers, so AYA can answer for it."',
    );
    expect(actions).not.toContain("Its own setup comes next");
  });

  test("the wizard asks for the main location, and says one AYA answers for all of them", () => {
    const screens = source("app/c/[slug]/setup/screens/PracticeScreens.tsx");
    expect(screens).toContain(
      'legend="Your website lists more than one location. Which one is your main location? The same AYA answers for all of them: add the others from Billing after setup."',
    );
    expect(screens).not.toContain("Which one is this AYA for?");
  });
});

describe("no portal word still describes a location as an account of its own", () => {
  test("none of the old design's phrases is left in apps/app's sources", () => {
    const retired = [
      "another healdesk location",
      "Each location connects its own",
      "Each location answers on one Page",
      "this location's Page",
      "has its own setup",
      "Its own setup comes next",
      "this AYA for?",
      "switch location",
      'aria-label="Other locations"',
    ];
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const phrase of retired) if (text.includes(phrase)) found.push(`${file}: ${phrase}`);
    }
    expect(found).toEqual([]);
  });
});
