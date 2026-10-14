import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { BookingView, OnboardingView } from "@/lib/admin/ops-client";

import { OnboardingPanel } from "./OnboardingPanel";

/**
 * The onboarding page's booking and calendar cards (plan §10, C17).
 *
 * The booking mode is derived in apps/app from the location's calendar
 * terms, its Google Calendar, its hours and zone, going live, Auto-confirm
 * and the owner's kill switch. The cards must say why a location takes
 * requests, in the clinic's words, and must never offer a control the mode
 * would ignore: no direct-booking switch, no PHI basis, no kill switch.
 * Auto-confirm is offered under every terms kind, because the mode weighs it
 * under every kind.
 *
 * The mode is what the location's settings allow, not what any channel does:
 * no channel books for a real clinic yet (calls take requests until the
 * Retell runtime exists, and only healdesk's demo clinic's voice harness can
 * book; Meta always takes requests), so the card never says the assistant
 * books (CLAUDE.md, "Claims and copy").
 *
 * Rendered to static markup and read as text, as the other admin honesty
 * rules are.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type Actions = Parameters<typeof OnboardingPanel>[0]["actions"];

const NOT_IN_A_RENDER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const ACTIONS: Actions = {
  completeStep: NOT_IN_A_RENDER,
  reopenStep: NOT_IN_A_RENDER,
  savePhone: NOT_IN_A_RENDER,
  saveAgent: NOT_IN_A_RENDER,
  approveAgent: NOT_IN_A_RENDER,
  goLive: NOT_IN_A_RENDER,
  startForwardingTest: NOT_IN_A_RENDER,
  attachMeta: NOT_IN_A_RENDER,
  setMeta: NOT_IN_A_RENDER,
  setMetaPlatform: NOT_IN_A_RENDER,
  saveRequirements: NOT_IN_A_RENDER,
  confirmTimezone: NOT_IN_A_RENDER,
  retryCalendarWrite: NOT_IN_A_RENDER,
  setAutoConfirm: NOT_IN_A_RENDER,
  sendCalendarLink: NOT_IN_A_RENDER,
  disconnectCalendar: NOT_IN_A_RENDER,
  attestAudit: NOT_IN_A_RENDER,
  confirmWidget: NOT_IN_A_RENDER,
};

const COVERED: BookingView = {
  mode: "manual",
  canOfferTimes: true,
  reasons: [
    { code: "not_production", sentence: "Your assistant isn't live yet." },
    { code: "kill_switch_off", sentence: "healdesk hasn't switched on live booking yet." },
  ],
  autoConfirm: true,
  autoConfirmChangedAt: null,
  killSwitchOn: false,
  demo: false,
  terms: {
    kind: "covered",
    source: "agreement",
    clauseId: "google-calendar-covered",
    documentVersion: "1.3.0",
    documentReleased: true,
    electedAt: "2026-10-08 09:00 UTC",
    reason: null,
  },
  calendar: {
    connectionId: "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a",
    status: "active",
    accountKind: "workspace",
    hostedDomain: "glow.test",
    timeZoneMatches: true,
    disclosureCurrent: true,
    connectedAt: "2026-10-08 09:05 UTC",
    lastVerifiedAt: "2026-10-12 08:00 UTC",
    lastError: null,
    brokenAt: null,
  },
  calendarLinkOutstanding: false,
  pendingAssistantWrites: 0,
};

function page(
  booking: BookingView | "unreadable" | null,
  platforms: OnboardingView["meta"]["platforms"] = null,
  channels: OnboardingView["channels"] = null,
): string {
  const view: OnboardingView = {
    clinic: {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      slug: "glow-a1b2c3",
      name: "Glow Aesthetics",
      specialty: "med-spa",
      timezone: "America/New_York",
      dataClassification: "synthetic",
      attributionMode: "estimated",
      isCoveredEntity: true,
      phoneSystemType: "landline",
      callRouting: "conditional",
      callRoutingConfirmedAt: null,
      carrier: null,
      assistantNumberE164: null,
      publishedPhoneE164: null,
      openingHoursPresent: false,
      wentLiveAt: null,
    },
    steps: [],
    forwardingTest: { windowUntil: null, observed: null },
    stripeConnect: { accountId: null, connectedAt: null, authorizeUrl: null },
    meta: {
      enabled: false,
      platforms,
      channels: [],
      bookingRequests: { waiting: 0, accepted: 0, confirmed: 0, declined: 0 },
    },
    forwarding: null,
    agent: null,
    goLive: { ok: false, missing: [] },
    requirements: {
      fields: [],
      confirmedAt: null,
      source: null,
      setupLinkOutstanding: false,
      catalogue: [],
      neverAsked: [],
    },
    timezoneConfirmedAt: null,
    timezone: "America/New_York",
    calendarWrites: [],
    booking,
    channels,
  };
  return text(h(OnboardingPanel, { view: { ok: true, data: view }, actions: ACTIONS }));
}

/** The booking card alone: from its section title to the time zone's. */
function bookingCard(said: string): string {
  return said.slice(said.indexOf("Booking mode —"), said.indexOf("Time zone"));
}

const NON_DEMO_CALLS =
  "Calls: requests, with no times offered, until the Retell runtime exists. The voice harness can book only for healdesk's demo clinic.";

describe("the booking card shows the derived mode and why", () => {
  test("every reason is shown in the clinic's words, and Auto-confirm is the only switch", () => {
    const said = page(COVERED);
    expect(said).toContain("Booking mode — requests for staff to confirm");
    expect(said).toContain(
      "Settings allow real free times from the location's Google Calendar, each booking a request for staff to confirm.",
    );
    expect(said).toContain("Your assistant isn't live yet. not_production");
    expect(said).toContain("healdesk hasn't switched on live booking yet. kill_switch_off");
    expect(said).toContain("Switch Auto-confirm off");
    // The owner's kill switch is shown, never offered.
    expect(said).toContain(
      "HEALDESK_DIRECT_BOOKING_ENABLED is the owner’s, set only in the environment",
    );
    // The addendum's switch and the vendor basis are gone from both cards.
    const cards = said.slice(said.indexOf("Booking mode —"), said.indexOf("Go live"));
    expect(cards).toContain("Calendar writes needing attention");
    expect(cards).not.toMatch(/direct booking|desk confirms|basis|addendum/i);
    expect(said).toContain(
      "Clause google-calendar-covered of 1.3.0 (released), from the signed agreement",
    );
  });

  test("where the terms let healdesk write nothing yet, Auto-confirm is still offered, and says when it counts", () => {
    for (const terms of [
      { ...COVERED.terms, kind: "not_used" as const, clauseId: "google-calendar-not-used" },
      {
        kind: "none" as const,
        source: null,
        clauseId: null,
        documentVersion: null,
        documentReleased: null,
        electedAt: null,
        reason: "no_agreement",
      },
      {
        kind: "needs_election" as const,
        source: null,
        clauseId: null,
        documentVersion: null,
        documentReleased: null,
        electedAt: null,
        reason: "legacy_agreement",
      },
    ]) {
      const said = page({ ...COVERED, canOfferTimes: false, terms, calendar: null });
      expect(said, terms.kind).toContain("Switch Auto-confirm off");
      expect(said, terms.kind).toContain(
        "It takes effect once the calendar terms let healdesk write.",
      );
      expect(said, terms.kind).toContain(
        "Settings allow requests only: a preferred time for staff to confirm, with no times offered.",
      );
      expect(page({ ...COVERED, autoConfirm: false, terms }), terms.kind).toContain(
        "Switch Auto-confirm on",
      );
    }
    expect(
      page({
        ...COVERED,
        terms: { ...COVERED.terms, kind: "none", reason: "no_agreement", clauseId: null },
      }),
    ).toContain("The organisation has no agreement in effect.");
  });

  test("live is what the settings allow; a real clinic's calls and Meta still take requests", () => {
    const live = page({ ...COVERED, mode: "live", reasons: [], killSwitchOn: true });
    expect(live).toContain("Booking mode — settings allow live booking");
    expect(live).toContain("Settings allow live booking into the location's Google Calendar.");
    expect(live).not.toContain("Why it takes requests");
    for (const said of [live, page(COVERED)]) {
      const card = bookingCard(said);
      expect(card).toContain(`What each channel does now ${NON_DEMO_CALLS} Meta: always requests.`);
      // No channel books for a real clinic, so nothing says the assistant does.
      expect(card).not.toMatch(/assistant books (?!nothing)|books (callers|directly|straight)/i);
    }
    // The Meta card says the same of Meta and of calls.
    expect(live).toContain(
      "Meta conversations always take requests. Calls take requests too: a call can book only at healdesk’s demo clinic, and only while the booking mode below allows live booking.",
    );
    expect(live).not.toContain("Until the Google Calendar adapter exists");
  });

  test("healdesk's demo clinic: its voice harness reads the settings, and can book only while they allow it", () => {
    const card = bookingCard(
      page({ ...COVERED, demo: true, mode: "live", reasons: [], killSwitchOn: true }),
    );
    expect(card).toContain(
      "Calls: the voice harness reads these settings for healdesk's demo clinic alone. It can book only while they allow live booking, and takes a request otherwise. Meta: always requests.",
    );
    expect(card).not.toContain(NON_DEMO_CALLS);
  });

  test("an older apps/app says it sent no mode", () => {
    const older = page(null);
    expect(older).toContain("Booking mode — unknown");
    expect(older).toContain("apps/app sent no booking mode");
    expect(older).not.toContain("Switch Auto-confirm");
    expect(older).not.toContain("Send calendar link");
  });

  test("a booking state it could not read is said on the two cards, and the rest of the page still shows", () => {
    const said = page("unreadable");
    expect(said).toContain("Booking mode — could not be read");
    const unreadable =
      "apps/app sent a booking state this console could not read, so no booking mode or calendar is shown rather than a guess.";
    expect(said.split(unreadable)).toHaveLength(3);
    expect(said).not.toContain("Switch Auto-confirm");
    expect(said).not.toContain("Send calendar link");
    expect(said).not.toMatch(/\bDisconnect\b/);
    expect(said).not.toMatch(/Settings allow/);
    // Everything else on the page is read as before.
    expect(said).toContain("Glow Aesthetics");
    expect(said).toContain("Calendar writes needing attention: 0");
    expect(said).toContain("Go live");
  });
});

describe("the calendar card", () => {
  test("shows the connection's health and offers the link and a disconnect", () => {
    const said = page(COVERED);
    expect(said).toContain("Active.");
    expect(said).toContain("Google Workspace, glow.test.");
    expect(said).toContain("Connected 2026-10-08 09:05 UTC; last verified 2026-10-12 08:00 UTC.");
    expect(said).toContain("Send calendar link");
    expect(said).toContain("Disconnect");
  });

  test("a revoked connection offers no disconnect; a broken one says since when", () => {
    const revoked = page({
      ...COVERED,
      calendar: { ...COVERED.calendar!, status: "revoked" },
    });
    expect(revoked).toContain("Revoked:");
    expect(revoked).not.toMatch(/\bDisconnect\b/);
    const broken = page({
      ...COVERED,
      calendar: {
        ...COVERED.calendar!,
        status: "error",
        brokenAt: "2026-10-11 22:10 UTC",
        lastError: "invalid_grant",
      },
    });
    expect(broken).toContain(
      "Broken: the practice must reconnect. Broken since 2026-10-11 22:10 UTC.",
    );
    expect(broken).toContain("Last error: invalid_grant");
  });
});

describe("the Meta front door shows the clinic's own platform switches beneath it", () => {
  /** The Meta section alone: from its title to the next section's. */
  const metaSection = (said: string) =>
    said.slice(said.indexOf("Meta front door —"), said.indexOf("Booking request fields"));

  test("each platform's switch, as the clinic left it, under the front door that still gates them", () => {
    const said = metaSection(page(COVERED, { instagram: true, messenger: false, whatsapp: true }));
    expect(said).toContain("Meta front door — off");
    expect(said).toContain("a message is answered only when the front door and its platform are both on");
    expect(said).toContain("Instagram: on");
    expect(said).toContain("Messenger: off");
    expect(said).toContain("WhatsApp: on");
  });

  test("an apps/app that predates the switches shows none", () => {
    const said = metaSection(page(COVERED, null));
    expect(said).not.toMatch(/Instagram: (on|off)/);
    expect(said).not.toContain("beneath the front door");
  });
});

describe("the channels card", () => {
  test("each channel says where it stands and what it still needs; the audit is offered only until it passed or the channel is live", () => {
    const said = page(null, null, [
      {
        channel: "voice",
        readyAt: "2026-10-14T15:00:00.000Z",
        waitingOn: "forwarding",
        liveAt: null,
        firstAnswerAt: null,
        auditPassed: true,
        missing: ["clinic_step"],
      },
      {
        channel: "web",
        readyAt: null,
        waitingOn: null,
        liveAt: null,
        firstAnswerAt: null,
        auditPassed: false,
        missing: ["go_live", "audit", "clinic_step"],
      },
      {
        channel: "meta",
        readyAt: "2026-10-10T15:00:00.000Z",
        waitingOn: null,
        liveAt: "2026-10-11T15:00:00.000Z",
        firstAnswerAt: null,
        auditPassed: true,
        missing: [],
      },
    ]);
    const card = said.slice(said.indexOf("Channels"));
    expect(card).toContain("Phone · ready since 2026-10-14, waiting on forwarding · audit passed");
    expect(card).toContain(
      "No forwarding-test call observed with the caller's number intact: run the forwarding test above. A stamped step is not enough. clinic_step",
    );
    expect(card).toContain("Website chat · not ready on our side");
    expect(card).toContain(
      "Nobody has confirmed the chat is on the clinic's website. Open the site, check the chat is there and answers, then confirm below. clinic_step",
    );
    // The audit's words send the operator to the preview or a test number, never an ordinary call.
    expect(card).toContain("calling from one of healdesk's test numbers (HEALDESK_TEST_NUMBERS)");
    expect(card).toContain("Instagram, Messenger & WhatsApp · live since 2026-10-11, no patient answered yet");
    // Offered once: for website chat, whose audit hasn't passed and which isn't live.
    expect(card.match(/audit passed/g)).toHaveLength(3);
    expect(card.match(/I checked AYA’s answers/g)).toHaveLength(1);
    // Website chat's line is confirmed by the operator who looked, never by a widget's Origin.
    expect(card.match(/The line is on their website/g)).toHaveLength(1);
  });

  test("an apps/app with no channel states says so rather than showing nothing", () => {
    expect(page(null)).toContain("apps/app sent no channel states");
  });
});
