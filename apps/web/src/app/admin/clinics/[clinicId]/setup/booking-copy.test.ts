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
  rerunPractice: NOT_IN_A_RENDER,
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
  return text(
    h(OnboardingPanel, { view: { ok: true, data: viewOf(booking, platforms, channels) }, actions: ACTIONS }),
  );
}

function viewOf(
  booking: BookingView | "unreadable" | null,
  platforms: OnboardingView["meta"]["platforms"] = null,
  channels: OnboardingView["channels"] = null,
  clinic: Partial<OnboardingView["clinic"]> = {},
  agent: OnboardingView["agent"] = null,
): OnboardingView {
  return {
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
      coverageMode: "overflow_after_hours",
      callRouting: "conditional",
      callRoutingConfirmedAt: null,
      callName: null,
      shortNameSet: false,
      carrier: null,
      assistantNumberE164: null,
      publishedPhoneE164: null,
      openingHoursPresent: false,
      wentLiveAt: null,
      ...clinic,
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
    agent,
    goLive: { ok: false, missing: [], notBuilt: [] },
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
    expect(cards).toContain("Writes not yet in the calendar whose time has not come are listed under Calendar writes above, with a Retry for each.");
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
    // Everything else on the page is read as before (the shell above the panel says the name; the panel does not repeat it).
    expect(said).toContain("Writes not yet in the calendar whose time has not come are listed under Calendar writes above, with a Retry for each.");
    expect(said).toContain("No calendar write attempted yet.");
    expect(said).toContain("Go live");
  });
});

describe("the calendar card's write history", () => {
  // Phase 5 (lane P5c): the unsettled writes and their Retry live in the
  // Setup tab's own "Calendar writes" section (CalendarWrites.tsx). Listed
  // here again with a second Retry, the card and the section disagreed on
  // the count and offered the same press twice, so the card keeps the
  // history (with Google's own word, which the section's reason words send
  // the reader here for) and offers no Retry.
  const WRITES: OnboardingView["calendarWrites"] = [
    { appointmentId: "6d2b0f1e-0000-4000-8000-000000000001", slotAt: "2026-11-02T15:00:00.000Z", status: "written", error: null, requestChannel: "web_chat" },
    { appointmentId: "6d2b0f1e-0000-4000-8000-000000000002", slotAt: "2026-11-03T16:00:00.000Z", status: "failed", error: "backendError", requestChannel: "voice" },
    { appointmentId: "6d2b0f1e-0000-4000-8000-000000000003", slotAt: "2026-11-04T17:00:00.000Z", status: "unknown", error: "timeout", requestChannel: "meta" },
  ];

  test("lists every write with its state and Google's word, points at Calendar writes, and offers no Retry", () => {
    const said = text(
      h(OnboardingPanel, { view: { ok: true, data: { ...viewOf(COVERED), calendarWrites: WRITES } }, actions: ACTIONS }),
    );
    const card = said.slice(said.indexOf("Writes not yet in the calendar"), said.indexOf("Go live"));
    // apps/app sends the writes with the latest booked times (listCalendarWritesWithin orders by the slot), so the title says so.
    expect(card).toContain("Latest writes attempted, by booked time");
    expect(card).toContain("written 2026-11-02 15:00 UTC web_chat");
    expect(card).toContain("failed 2026-11-03 16:00 UTC voice backendError");
    expect(card).toContain("unknown 2026-11-04 17:00 UTC meta timeout");
    // The one Retry the card names is the section's, in the pointer sentence.
    expect(card.split("Retry")).toHaveLength(2);
    expect(card).not.toContain("Calendar writes needing attention");
    expect(renderToStaticMarkup(h(OnboardingPanel, { view: { ok: true, data: { ...viewOf(COVERED), calendarWrites: WRITES } }, actions: ACTIONS }))).toContain(
      'href="#calendar-writes"',
    );
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
  test("each channel says where it stands and what it still needs; no audit is ever offered to pass by hand", () => {
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
      "Nobody has confirmed the chat is on the clinic's website. Open the site, check the chat bubble is there (until you confirm, it tells visitors to call the practice), then confirm below. clinic_step",
    );
    // The audit's words send the operator to the review queue, the one operator path (19 October 2026).
    expect(card).toContain(
      "Its practice questions haven't passed. While the practice-questions job is on in System › Jobs, they run by themselves once the clinic's answers are set up, and again after each change it makes; a run they flag waits for you in Queues › Reviews (/admin/queues#reviews), and your decision there is the only way an operator passes one. audit",
    );
    expect(card).toContain("Instagram, Messenger & WhatsApp · live since 2026-10-11, no patient answered yet");
    // Said for the two whose audit passed; never offered as a button.
    expect(card.match(/audit passed/g)).toHaveLength(2);
    expect(card).not.toMatch(/I checked AYA’s answers/);
    // Website chat's line is confirmed by the operator who looked, never by a widget's Origin.
    expect(card.match(/The line is on their website/g)).toHaveLength(1);
  });

  test("an apps/app with no channel states says so rather than showing nothing", () => {
    expect(page(null)).toContain("apps/app sent no channel states");
  });
});

/**
 * The phone card, trimmed (plan Part K: no two-mode routing). The select it
 * had, "Practice answers first" or "AYA answers everything", could not say
 * the spec's "after hours only" and rewrote the clinic's own choice when an
 * operator changed it. And the deposit note said a payment link "waits on
 * 10DLC", which implies texting, which v1 never does.
 */
describe("the phone card shows the clinic's coverage and offers no routing of its own", () => {
  const panel = (view: OnboardingView) =>
    renderToStaticMarkup(h(OnboardingPanel, { view: { ok: true, data: view }, actions: ACTIONS }));

  test("the clinic's mode, read-only, in the spec's words", () => {
    const html = panel(viewOf(null, null, null, { coverageMode: "after_hours_only" }));
    const said = text(h("div", { dangerouslySetInnerHTML: { __html: html } }));
    expect(said).toContain("Which calls reach AYA");
    expect(said).toContain("After hours only: AYA answers only while you're closed.");
    expect(said).toContain("The clinic chooses this in its setup or Settings");
    expect(said).not.toMatch(/Call routing|Practice answers first|AYA answers everything|saving confirms it/);
    expect(html).not.toContain('name="callRouting"');
  });

  test("an apps/app that does not report the mode reads as not reported, not as a guess", () => {
    const html = panel(viewOf(null, null, null, { coverageMode: null }));
    expect(text(h("div", { dangerouslySetInnerHTML: { __html: html } }))).toContain(
      "Which calls reach AYA Not reported by apps/app.",
    );
  });

  test("a deposit the desk collects says AYA never texts, and nothing implies a text channel", () => {
    const html = panel(
      viewOf(null, null, null, {}, {
        version: 1,
        greeting: "Thanks for calling.",
        services: [],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: { required: true, amountUsd: 50, collection: "front_desk" },
        approvedAt: null,
        approvedByLabel: null,
      }),
    );
    const said = text(h("div", { dangerouslySetInnerHTML: { __html: html } }));
    expect(said).toContain("The clinic takes a booking deposit");
    expect(said).toContain("AYA never texts anyone");
    expect(said).not.toMatch(/10DLC|text channel/i);
  });
});
