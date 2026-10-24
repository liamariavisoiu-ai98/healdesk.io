import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OnboardingView } from "@/lib/admin/ops-client";

import { OnboardingPanel, rerunSaid } from "./OnboardingPanel";

/**
 * The onboarding page offers no way to pass an audit by hand (19 October
 * 2026). The spec's Stage 3: the practice questions run by themselves, a
 * pass approves the agent, and anything flagged goes to a short internal
 * review; principle 7, a person reviews only what the audit flags. apps/app
 * retired the two controls that cleared a channel's audit with no question
 * asked, "Record approval" (approveAgentConfig) and "I checked AYA's
 * answers: audit passed" (attestChannelAudit), and this page went with them,
 * in the same change: the console deploys the moment main moves, apps/app
 * only when the owner deploys, and a control left here would only ever be
 * refused.
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

function page(agent: OnboardingView["agent"], channels: OnboardingView["channels"]): string {
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
      coverageMode: "overflow_after_hours",
      wentLiveAt: null,
    },
    steps: [],
    forwardingTest: { windowUntil: null, observed: null },
    stripeConnect: { accountId: null, connectedAt: null, authorizeUrl: null },
    meta: {
      enabled: false,
      platforms: null,
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
    booking: null,
    channels,
  };
  return text(h(OnboardingPanel, { view: { ok: true, data: view }, actions: ACTIONS }));
}

const AGENT: NonNullable<OnboardingView["agent"]> = {
  version: 3,
  greeting: "Thanks for calling Glow Aesthetics.",
  services: [],
  escalationPhone: null,
  escalationHours: null,
  notes: null,
  depositPolicy: null,
  approvedAt: null,
  approvedByLabel: null,
};

const NOT_AUDITED: NonNullable<OnboardingView["channels"]> = [
  {
    channel: "voice",
    readyAt: null,
    waitingOn: null,
    liveAt: null,
    firstAnswerAt: null,
    auditPassed: false,
    missing: ["audit", "runtime", "setup"],
  },
  {
    channel: "web",
    readyAt: null,
    waitingOn: null,
    liveAt: null,
    firstAnswerAt: null,
    auditPassed: false,
    missing: ["audit", "setup", "clinic_step"],
  },
];

describe("no audit is passed by hand on the onboarding page", () => {
  test("the agent script offers no approval: it says the practice questions approve it, and where a flagged run waits", () => {
    const said = page(AGENT, NOT_AUDITED);
    expect(said).toContain("Agent script — version 3, not approved");
    expect(said).not.toContain("Record approval");
    expect(said).not.toMatch(/Who at the clinic approved/);
    expect(said).toContain(
      "Not approved yet. The practice questions approve this version when they pass it; a run they flag waits for you in Queues › Reviews (/admin/queues#reviews).",
    );
    expect(said).not.toContain("until the clinic approves it again");
  });

  test("a channel whose audit has not passed offers no attestation, and says the review queue is the one operator path", () => {
    const said = page(AGENT, NOT_AUDITED);
    expect(said).not.toMatch(/I checked AYA.s answers/);
    expect(said).not.toMatch(/Until the practice questions exist/);
    const line =
      "Its practice questions haven't passed. While the practice-questions job is on in System › Jobs, they run by themselves once the clinic's answers are set up, and again after each change it makes; a run they flag waits for you in Queues › Reviews (/admin/queues#reviews), and your decision there is the only way an operator passes one. audit";
    expect(said.split(line)).toHaveLength(3);
    // Website chat's own step is a fact an operator looks at, and stays.
    expect(said).toContain("The line is on their website");
  });

  test("beside the channels waiting on their audit, the console can ask the practice questions again, once for every channel, and nothing more", () => {
    const said = page(AGENT, NOT_AUDITED);
    expect(said.split("Ask the practice questions again")).toHaveLength(2);
    expect(said).toContain("For every channel at once. It asks them; it passes nothing.");
    // Nothing left waiting on an audit, or only a live channel: nothing to ask.
    const audited = NOT_AUDITED.map((c) => ({
      ...c,
      auditPassed: true,
      missing: c.missing.filter((m) => m !== "audit"),
    }));
    expect(page(AGENT, audited)).not.toContain("Ask the practice questions again");
    expect(
      page(
        AGENT,
        NOT_AUDITED.map((c) => ({ ...c, liveAt: "2026-10-15T09:00:00.000Z", missing: [] })),
      ),
    ).not.toContain("Ask the practice questions again");
  });

  test("once asked, the console says only what is true: whether the job is on, the answers it waits for, and a write the security log missed", () => {
    const on = rerunSaid({ status: "updated", auditRecorded: true, jobEnabled: true });
    expect(on).toBe(
      "Asked: the practice questions run again for every channel in about two minutes, once the clinic's answers are set up. If they flag something, it waits in Reviews.",
    );
    // The job ships off (drizzle/0080): nothing runs, and the console says so.
    expect(rerunSaid({ status: "updated", auditRecorded: true, jobEnabled: false })).toBe(
      "Asked, but the practice-questions job is off in System › Jobs, so nothing runs until it is switched on. Then they run for every channel within two minutes, once the clinic's answers are set up.",
    );
    // An older apps/app does not say: the line names the condition rather than promising a run.
    const unknown = rerunSaid({ status: "updated", auditRecorded: true, jobEnabled: null });
    expect(unknown).toContain("while the practice-questions job is on in System › Jobs");
    expect(unknown).not.toMatch(/^Asked: the practice questions run again/);
    // A write that missed the security log says so, as the page's other writes do.
    expect(rerunSaid({ status: "updated", auditRecorded: false, jobEnabled: true })).toBe(
      `${on} Done, but the audit entry could not be written. Tell whoever keeps the security log.`,
    );
    // A refusal is apps/app's own sentence.
    expect(
      rerunSaid({
        status: "refused",
        message: "A run of the practice questions waits in Reviews: decide it there.",
      }),
    ).toBe("A run of the practice questions waits in Reviews: decide it there.");
  });

  test("a version approved before the retirement, as apps/app still reports it, is said as it was recorded", () => {
    // An apps/app that predates the change answers getOnboarding in the same
    // shape: the old override's label reads as any approval does.
    const said = page(
      {
        ...AGENT,
        approvedAt: "2026-10-15T09:00:00.000Z",
        approvedByLabel: "Laura Owner (recorded by ops@healdesk.test)",
      },
      NOT_AUDITED.map((c) => ({
        ...c,
        auditPassed: true,
        missing: c.missing.filter((m) => m !== "audit"),
      })),
    );
    expect(said).toContain("Agent script — version 3, approved");
    expect(said).toContain("Approved by Laura Owner (recorded by ops@healdesk.test).");
    expect(said).toContain("audit passed");
    expect(said).not.toContain("Record approval");
  });
});
