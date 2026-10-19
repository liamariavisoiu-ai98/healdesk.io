import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import type { ChannelState } from "@/lib/channels/state";
import type { PracticeState } from "@/lib/engine/practice/state";
import { needsAttention, type AttentionFacts } from "@/lib/portal/attention";
import { portalDay, portalMoment, portalMoney } from "@/lib/portal/format";
import { answeringStatus } from "@/lib/portal/header";
import {
  isBuiltSection,
  BOOKINGS_BY_EMAIL,
  conversationsUntilBuilt,
  OPENS_AFTER_GO_LIVE,
  portalNav,
  sectionPath,
  type PortalSection,
} from "@/lib/portal/nav";
import type { SetupScreenId } from "@/lib/setup/screen-ids";
import type { SetupState } from "@/lib/setup/state";

import {
  callsByName,
  checkPatientScreens,
  exportedFunctions,
  hasUseServer,
  patientScreenFiles,
} from "./setup/patient-screens-check";

/**
 * The portal's frame (plan Part F0 and F1), without a database: the six-item
 * menu, which never links to a screen that does not exist; the header's line
 * about AYA; Home's "Needs attention"; and the way the portal writes dates and
 * money. Plus three source checks that hold for every portal file: each page
 * and server action calls requirePortal itself, no page names the internal
 * origin, and no element carries an inline style the CSP would refuse.
 */

const at = new Date("2026-10-07T14:00:00Z");
const PORTAL_DIR = join(process.cwd(), "src", "app", "c", "[slug]");

function channel(over: Partial<ChannelState> & Pick<ChannelState, "channel">): ChannelState {
  return {
    enabled: true,
    readyAt: null,
    waitingOn: null,
    liveAt: null,
    firstAnswerAt: null,
    pausedUntil: null,
    status: "setting_up",
    ...over,
  };
}

describe("the menu", () => {
  test("the spec's order; each screen this build has is a link, and the patient screens say they open after go-live", () => {
    // A clinic with no live channel and no booking request yet.
    const nav = portalNav("glow", "home");
    const order: PortalSection[] = [
      "home",
      "settings",
      "knowledge",
      "conversations",
      "bookings",
      "billing",
    ];
    expect(nav.map((i) => i.section)).toEqual(
      order.filter((s) => isBuiltSection(s) || s === "conversations" || s === "bookings"),
    );
    for (const item of nav) {
      if (item.section === "conversations" || item.section === "bookings") {
        expect(item.href, item.section).toBeNull();
        expect(item.href === null && item.note).toBe(OPENS_AFTER_GO_LIVE);
      } else {
        expect(item.href).toBe(sectionPath("glow", item.section));
      }
    }
    expect(nav.find((i) => i.section === "home")).toMatchObject({ current: true });
    expect(sectionPath("glow", "home")).toBe("/c/glow");
    expect(sectionPath("glow", "billing")).toBe("/c/glow/billing");
  });

  test("Bookings is a link once the clinic has opened it, whatever Conversations' state", () => {
    expect(isBuiltSection("bookings")).toBe(true);
    const waiting = portalNav("glow", "home", ["conversations"]);
    expect(waiting.find((i) => i.section === "bookings")).toEqual({
      section: "bookings",
      label: "Bookings",
      href: null,
      current: false,
      note: OPENS_AFTER_GO_LIVE,
    });
    const opened = portalNav("glow", "home", ["bookings"]);
    expect(opened.find((i) => i.section === "bookings")).toEqual({
      section: "bookings",
      label: "Bookings",
      href: "/c/glow/bookings",
      current: false,
    });
    expect(opened.find((i) => i.section === "conversations")).toMatchObject({
      href: null,
      note: OPENS_AFTER_GO_LIVE,
    });
    // On Bookings itself, once opened, it is the current page.
    expect(
      portalNav("glow", "bookings", ["bookings"]).find((i) => i.section === "bookings"),
    ).toMatchObject({ href: "/c/glow/bookings", current: true });
  });

  test("once a channel is live, a patient screen not built yet stops saying it opens after go-live, and says where its contents go", () => {
    const before = portalNav("glow", "home");
    // A channel live: Conversations, built, links once opened (openPatientScreens);
    // Bookings, not built yet, says where its requests go meanwhile.
    const after = portalNav("glow", "home", ["conversations"], ["voice"]);
    expect(before.find((i) => i.section === "bookings")).toMatchObject({ href: null, note: OPENS_AFTER_GO_LIVE });
    for (const section of ["conversations", "bookings"] as const) {
      const item = after.find((i) => i.section === section)!;
      if (isBuiltSection(section)) {
        if (section === "conversations") expect(item.href).toBe(sectionPath("glow", section));
      } else {
        expect(item.href).toBeNull();
        expect(item.href === null && item.note).not.toBe(OPENS_AFTER_GO_LIVE);
      }
    }
    if (!isBuiltSection("bookings")) {
      expect(after.find((i) => i.section === "bookings")).toMatchObject({ note: BOOKINGS_BY_EMAIL });
      // Before any channel is live it still promises the opening.
      expect(portalNav("glow", "home", ["conversations"], []).find((i) => i.section === "bookings")).toMatchObject({
        note: OPENS_AFTER_GO_LIVE,
      });
    }
  });

  test("what a not-yet-built Conversations would say, per channel: Meta's are never emailed", () => {
    expect(conversationsUntilBuilt(["voice"])).toBe("Each call transcript is emailed to you");
    expect(conversationsUntilBuilt(["voice", "web"])).toBe("Each call and website chat transcript is emailed to you");
    expect(conversationsUntilBuilt(["meta"])).toBe("Instagram, Messenger and WhatsApp messages stay in those apps");
    expect(conversationsUntilBuilt(["web", "meta"])).toBe(
      "Each website chat transcript is emailed to you; Instagram, Messenger and WhatsApp messages stay in those apps",
    );
  });

  test("a screen is in the menu only when its page exists, and every screen page is in the menu", () => {
    const paths: Record<PortalSection, string> = {
      home: "page.tsx",
      settings: "settings/page.tsx",
      knowledge: "knowledge/page.tsx",
      conversations: "conversations/page.tsx",
      bookings: "bookings/page.tsx",
      billing: "billing/page.tsx",
    };
    for (const [section, file] of Object.entries(paths) as [PortalSection, string][]) {
      expect(existsSync(join(PORTAL_DIR, file)), section).toBe(isBuiltSection(section));
    }
  });
});

describe("the header's line about AYA", () => {
  test("not yet before any channel is live; answering, paused or off after", () => {
    expect(answeringStatus([channel({ channel: "web" })])).toEqual({ kind: "not_yet" });
    expect(answeringStatus([channel({ channel: "web", liveAt: at, status: "live" })])).toEqual({
      kind: "answering",
    });
    const until = new Date("2026-10-08T12:00:00Z");
    expect(
      answeringStatus([
        channel({ channel: "web", liveAt: at, status: "paused", pausedUntil: until }),
        channel({ channel: "voice" }),
      ]),
    ).toEqual({ kind: "paused", until });
    expect(
      answeringStatus([channel({ channel: "web", liveAt: at, status: "off", enabled: false })]),
    ).toEqual({ kind: "off" });
  });
});

/** A clinic's setup state, every screen answered, for the attention rules. */
function stateWith(over: Partial<AttentionFacts["state"]> = {}): AttentionFacts["state"] {
  const screens: SetupScreenId[] = [
    "basics",
    "hours",
    "services",
    "question",
    "tone",
    "deposits",
    "urgent",
    "calendar",
    "providers",
    "channels",
  ];
  return {
    screens,
    progress: new Map(screens.map((id) => [id, { outcome: "done" as const, at }])),
    clinic: { isCoveredEntity: false } as SetupState["clinic"],
    hasPasskey: true,
    hasBackup: true,
    billing: {
      boughtPlanId: "webchat-1000",
      interval: "month",
      status: "active",
      firstPaidAt: at,
      setupDeadlineAt: null,
      planStartedAt: null,
    },
    address: "info@glow.test",
    ...over,
  };
}

function facts(over: Partial<AttentionFacts> = {}): AttentionFacts {
  return { slug: "glow", state: stateWith(), addressUndeliverable: false, ...over };
}

describe("Needs attention", () => {
  test("nothing when setup is done, a device and a backup are added, and mail arrives", () => {
    expect(needsAttention(facts())).toEqual([]);
  });

  test("setup unfinished: the steps left and the first unanswered screen", () => {
    const state = stateWith();
    const progress = new Map(state.progress);
    progress.delete("tone");
    progress.delete("calendar");
    const items = needsAttention(facts({ state: { ...state, progress } }));
    expect(items.map((i) => i.id)).toEqual(["setup_unfinished"]);
    expect(items[0]).toMatchObject({
      text: "Setup isn't finished: 2 steps left.",
      action: { label: "Continue setup", href: "/c/glow/setup?s=tone" },
    });
  });

  test("screens skipped once setup is finished, and the insurance question on its own line", () => {
    const state = stateWith({
      screens: [...stateWith().screens, "insurance"],
      clinic: { isCoveredEntity: null } as SetupState["clinic"],
    });
    const progress = new Map(state.progress);
    progress.set("hours", { outcome: "skipped", at });
    progress.set("insurance", { outcome: "skipped", at });
    const items = needsAttention(facts({ state: { ...state, progress } }));
    expect(items.map((i) => [i.id, i.action.href])).toEqual([
      ["setup_skipped", "/c/glow/setup?s=hours"],
      ["insurance", "/c/glow/setup?s=insurance"],
    ]);
    expect(items[0]!.text).toBe("You skipped hours in setup.");
  });

  test("no device yet comes before the backup, which waits for the end of setup", () => {
    expect(
      needsAttention(facts({ state: stateWith({ hasPasskey: false, hasBackup: false }) })),
    ).toMatchObject([{ id: "passkey", action: { href: "/c/glow/protect?next=%2Fc%2Fglow" } }]);
    expect(needsAttention(facts({ state: stateWith({ hasBackup: false }) }))).toMatchObject([
      { id: "backup", action: { href: "/c/glow/setup?s=backup" } },
    ]);
  });

  test("after go-live, a calendar that stopped working; never before, and never one disconnected by choice", () => {
    const connected = {
      status: "active" as const,
      account: { email: "desk@glow.test", kind: "workspace" as const, domain: "glow.test" },
      calendar: { id: "primary", primary: true },
      connectedAt: at.toISOString(),
      lastVerifiedAt: at,
      brokenAt: null,
      lastError: null,
      disclosureCurrent: true,
    };
    const broken = { ...connected, status: "error" as const, brokenAt: at, lastError: "invalid_grant" };
    const accessRemoved = { status: "not_connected" as const, accessRemovedAt: at };
    const disconnectedByChoice = { status: "not_connected" as const, accessRemovedAt: null };

    for (const calendar of [broken, accessRemoved]) {
      expect(needsAttention(facts({ live: true, calendar }))).toEqual([
        {
          id: "calendar_disconnected",
          text: "Your calendar stopped working, so bookings arrive as requests your team confirms.",
          action: { label: "Reconnect it in Settings", href: "/c/glow/settings#calendar" },
        },
      ]);
      // Before go-live the calendar step of setup says it already.
      expect(needsAttention(facts({ live: false, calendar }))).toEqual([]);
    }
    // Healthy, merely unreachable this once, never connected or disconnected
    // by the clinic: nothing to do.
    for (const calendar of [
      connected,
      { ...connected, status: "degraded" as const },
      disconnectedByChoice,
    ]) {
      expect(needsAttention(facts({ live: true, calendar }))).toEqual([]);
    }
  });

  test("website chat waiting on its line: one item into Settings, where the line is, at any stage, and none once the line is seen or the channel is live", () => {
    const waiting = channel({
      channel: "web",
      readyAt: at,
      status: "waiting",
      waitingOn: "snippet",
    });
    for (const live of [false, true]) {
      expect(
        needsAttention(facts({ live, state: stateWith({ channels: [waiting] }) })),
      ).toEqual([
        {
          id: "website_line",
          text: "Website chat is ready: paste one line on your website, and AYA is designed to start answering there.",
          action: { label: "Get the line", href: "/c/glow/settings#website-line" },
        },
      ]);
    }
    for (const web of [
      // Ready, but setup is still the clinic's step; seen on the site, waiting on us; live; Off.
      { ...waiting, waitingOn: "setup" as const },
      { ...waiting, waitingOn: null },
      { ...waiting, status: "live" as const, liveAt: at, waitingOn: null },
      { ...waiting, status: "off" as const, enabled: false },
      // Phone's forwarding is not website chat's line.
      { ...waiting, channel: "voice" as const, waitingOn: "forwarding" as const },
    ]) {
      expect(needsAttention(facts({ state: stateWith({ channels: [web] }) }))).toEqual([]);
    }
  });

  test("an address that bounces and a payment that failed come first; the website list is M7's", () => {
    const items = needsAttention(
      facts({
        addressUndeliverable: true,
        state: stateWith({
          billing: { ...stateWith().billing!, status: "past_due" },
        }),
        paymentAccountDisconnected: true,
        websiteChanges: 2,
      }),
    );
    expect(items.map((i) => i.id)).toEqual([
      "address_undeliverable",
      "payment_failed",
      "payment_account",
      "website_changes",
    ]);
    expect(items[0]!.text).toBe(
      "We can't email info@glow.test, the address every healdesk email goes to.",
    );
    // Every action goes to a screen this build has, or to Help.
    for (const item of items) {
      const href = item.action.href;
      const section = (["settings", "billing", "knowledge"] as const).find((s) =>
        href.startsWith(sectionPath("glow", s)),
      );
      if (section) expect(isBuiltSection(section), href).toBe(true);
      else expect(href).toBe("#help");
    }
  });
});

describe("dates and money as the portal writes them", () => {
  test("a day in the clinic's zone, with the year only when it is not this one", () => {
    expect(portalDay("2026-10-13", "America/New_York", at)).toBe("Tuesday 13 October");
    expect(portalDay("2027-11-05", "America/New_York", at)).toBe("Friday 5 November 2027");
    // 02:00 UTC on the 8th is still the 7th in New York.
    expect(portalDay(new Date("2026-10-08T02:00:00Z"), "America/New_York", at)).toBe(
      "Wednesday 7 October",
    );
    expect(portalMoment(new Date("2026-10-07T18:32:00Z"), "America/New_York", at)).toBe(
      "2:32 pm EDT on Wednesday 7 October",
    );
    expect(portalMoney(89700)).toBe("$897");
    expect(portalMoney(2450)).toBe("$24.50");
  });
});

describe("Needs attention after go-live: the practice questions", () => {
  const latest = (over: Partial<NonNullable<PracticeState["latest"]>> = {}): PracticeState => ({
    pending: false,
    latest: {
      id: "11111111-2222-4333-8444-555555555555",
      status: "in_review",
      finishedAt: at,
      failedSection: null,
      failedCount: null,
      triggerSection: "prices",
      overridden: false,
      reviewDueOn: "2026-10-14",
      ...over,
    },
  });

  test("a change the questions did not pass shows \"We're double-checking your change to Prices\", linking to it, once a channel is live", () => {
    expect(needsAttention(facts({ live: true, practice: latest() }))).toEqual([
      { id: "double_checking", text: "We're double-checking your change to Prices.", action: { label: "Open Prices", href: "/c/glow/knowledge#prices" } },
    ]);
    // A failure the clinic must fix names the section that failed, here a Settings card.
    expect(needsAttention(facts({ live: true, practice: latest({ status: "failed", failedSection: "safety_net", failedCount: 1 }) }))[0]).toMatchObject({
      text: "We're double-checking your change to Safety net.",
      action: { href: "/c/glow/settings#safety-net" },
    });
  });

  test("not before go-live, where the tracker says it, and not once a run has passed", () => {
    expect(needsAttention(facts({ live: false, practice: latest() }))).toEqual([]);
    expect(needsAttention(facts({ live: true, practice: latest({ status: "passed" }) }))).toEqual([]);
    expect(needsAttention(facts({ live: true, practice: latest({ status: "error" }) }))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Source checks over every portal file
// -----------------------------------------------------------------------------

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("every portal file", () => {
  const portalFiles = files(PORTAL_DIR);

  /** A portal file as the compiler reads it: comments and strings are never code. */
  const parse = (file: string) =>
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const GUARDS = new Set(["requirePortal", "requirePatientPage", "contextFor", "portalFor"]);

  test("each page calls requirePortal(slug) itself, never trusting a layout", () => {
    const pages = portalFiles.filter((f) => f.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      // requirePatientPage calls requirePortal first (lib/portal/patient-page.ts).
      expect(
        callsByName(parse(page), new Set(["requirePortal", "requirePatientPage"])),
        relative(PORTAL_DIR, page),
      ).toBe(true);
    }
  });

  test("Conversations and Bookings open only through the patient-page guard", () => {
    // The screens that show patients (spec: a passkey before any
    // conversation or booking opens, and an access log naming the device).
    // tests/setup/patient-screens-check.ts says what holds for every file
    // under them, and tests/patient-screens-check.test.ts proves each rule
    // bites.
    const patientFiles = patientScreenFiles(PORTAL_DIR);
    expect(checkPatientScreens(patientFiles)).toEqual([]);
  }, 600_000);

  test("each server action calls requirePortal, except signing out, which needs no clinic", () => {
    const exempt = new Set(["signOut"]);
    const actionFiles = portalFiles.filter((file) => hasUseServer(parse(file)));
    expect(actionFiles.length).toBeGreaterThan(3);
    for (const file of actionFiles) {
      // Every export, however written: a function, an arrow, a default.
      const exported = exportedFunctions(parse(file));
      expect(exported.length, relative(PORTAL_DIR, file)).toBeGreaterThan(0);
      for (const { name, node } of exported) {
        if (exempt.has(name)) continue;
        expect(callsByName(node, GUARDS), `${relative(PORTAL_DIR, file)}: ${name}`).toBe(true);
      }
    }
  });

  test("no page names the internal origin, and no element carries an inline style", () => {
    for (const file of files(join(process.cwd(), "src", "app"))) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(process.cwd(), file)).not.toMatch(/HEALDESK_APP_URL/);
      if (file.startsWith(PORTAL_DIR) && file.endsWith(".tsx")) {
        // The page's Content-Security-Policy has no 'unsafe-inline' for
        // styles, so a style attribute is silently dropped.
        expect(source, relative(process.cwd(), file)).not.toMatch(/\sstyle=\{/);
      }
    }
  });
});
