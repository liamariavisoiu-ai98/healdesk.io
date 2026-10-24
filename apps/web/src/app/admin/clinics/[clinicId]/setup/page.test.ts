import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Setup tab's page (wave 2, lane A3): it reads the clinic's changes,
 * its audits and the lifecycle with the clinic's own id, draws the "Setup
 * window" card only for a clinic the watch covers and the "Availability
 * changes" card always, and keeps the standby behaviour: a host that does
 * not answer is one notice. The onboarding panel and the summary are the
 * same as before and are stubbed here.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const state = vi.hoisted(() => ({
  calls: [] as [string, unknown][],
  onboarding: { ok: true, data: {} } as unknown,
  watched: true,
}));

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/clinic-strip", () => ({
  loadClinicRows: async () => ({
    clinics: { ok: true, data: { clinics: [], connectionStateLimit: 50 } },
    cards: { ok: true, data: { cards: [], limit: 50 } },
    health: { ok: true, data: [] },
    strip: null,
    rows: [],
  }),
}));
vi.mock("./OnboardingPanel", () => ({ OnboardingPanel: () => null }));
vi.mock("./SetupSummary", () => ({ SetupSummary: () => null }));
vi.mock("./ConnectLink", () => ({ ConnectLink: () => null }));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchOnboarding: async (clinicId: string) => {
    state.calls.push(["fetchOnboarding", clinicId]);
    return state.onboarding;
  },
  fetchClinicChanges: async (filter: unknown) => {
    state.calls.push(["fetchClinicChanges", filter]);
    return { ok: true, data: { since: "2026-09-23T00:00:00.000Z", changes: [] } };
  },
  fetchClinicAudits: async (clinicId: string) => {
    state.calls.push(["fetchClinicAudits", clinicId]);
    return { ok: true, data: { clinics: [], history: null } };
  },
  fetchLifecycle: async () => {
    state.calls.push(["fetchLifecycle", null]);
    return {
      ok: true,
      data: state.watched
        ? [
            {
              clinicId: CLINIC,
              clinicSlug: "radiance",
              clinicName: "Radiance Med Spa",
              stage: "in_setup",
              stageSince: "2026-10-02T09:00:00.000Z",
              stepsLeft: 2,
              channelsWaiting: 0,
              lastProgressAt: null,
              deadlineAt: "2026-11-01T00:00:00.000Z",
              remainingDays: 8,
              decision: "none",
              decidedBy: null,
              decidedAt: null,
              snoozedUntil: null,
              snoozedBy: null,
              undeliveredCount: 0,
              decisionOwed: true,
              recommendation: { action: "extend", days: 14, reason: "Progress was made." },
            },
          ]
        : [],
    };
  },
  acknowledgeClinicChange: async () => ({ ok: true, data: { status: "acknowledged" } }),
  decideLifecycle: async () => ({ ok: true, data: { outcome: "saved" } }),
  extendSetupDeadline: async () => ({ ok: true, data: { status: "extended" } }),
  runClinicAudit: async () => ({ ok: true, data: { status: "busy" } }),
  snoozeLifecycle: async () => ({ ok: true, data: { outcome: "saved" } }),
  issueConnectLink: async () => ({ ok: true, data: { status: "refused", message: "x" } }),
  attachMetaChannel: async () => null,
  confirmWebWidget: async () => null,
  setMetaFrontDoor: async () => null,
  setMetaPlatform: async () => null,
  completeOnboardingStep: async () => null,
  disconnectCalendar: async () => null,
  goLive: async () => null,
  issueCalendarLink: async () => null,
  reopenOnboardingStep: async () => null,
  rerunPracticeQuestions: async () => null,
  retryCalendarWrite: async () => null,
  setAutoConfirm: async () => null,
  setBookingRequirements: async () => null,
  setClinicTimezone: async () => null,
  setPhoneSettings: async () => null,
  startForwardingTest: async () => null,
  updateAgentConfig: async () => null,
}));

const { default: SetupPage } = await import("./page");

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return resolve(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  return { ...element, props: { ...element.props, children: await resolve(children) } } as ReactElement;
}

async function render(): Promise<string> {
  const tree = await resolve(await SetupPage({ params: Promise.resolve({ clinicId: CLINIC }) }));
  return renderToStaticMarkup(tree as ReactElement).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.calls = [];
  state.onboarding = { ok: true, data: {} };
  state.watched = true;
});

describe("the Setup tab", () => {
  test("reads the changes, the audits and the lifecycle for this clinic, and draws both cards for a watched clinic", async () => {
    const html = await render();
    expect(state.calls).toContainEqual(["fetchClinicChanges", { clinicId: CLINIC }]);
    expect(state.calls).toContainEqual(["fetchClinicAudits", CLINIC]);
    expect(state.calls).toContainEqual(["fetchLifecycle", null]);
    expect(html).toContain('id="setup-window"');
    expect(html).toContain('id="availability"');
    expect(html).toContain("Run audit now");
    expect(html).toContain("Extend the setup window");
  });

  test("draws no Setup window for a clinic the watch does not cover, and still the changes card", async () => {
    state.watched = false;
    const html = await render();
    expect(html).not.toContain('id="setup-window"');
    expect(html).not.toContain("Setup window");
    expect(html).toContain('id="availability"');
  });

  test("a host that does not answer is the standby notice, as before", async () => {
    state.onboarding = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
    const html = await render();
    expect(html).toContain("The AWS host is in standby.");
    expect(html).not.toContain('id="availability"');
  });
});
