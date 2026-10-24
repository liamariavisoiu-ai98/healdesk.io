import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Setup tab's page (wave 2, lane A3): it reads the clinic's changes,
 * audits, lifecycle and billing with the clinic's own id; draws the "Setup
 * window" card only for a watched clinic, with the billing view's deadline;
 * its server actions call ops-client with exactly the arguments the cards
 * give them (the deadline shown, the clinic id on an acknowledgement, a
 * snooze held to 3, 7 or 14); a second extension after the first works
 * from the refreshed deadline; and the standby behaviour is unchanged.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CHANGE = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const state = vi.hoisted(() => ({
  reads: [] as unknown[][],
  writes: [] as [string, unknown[]][],
  onboarding: { ok: true, data: {} } as unknown,
  watched: true,
  deadlineIso: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-01 00:00 UTC",
  planStarted: false,
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
// The Setup tab reads one clinic; the whole Clinics strip is never loaded for it (lane A4).
vi.mock("@/lib/admin/clinic-strip", () => ({
  loadClinicRows: async () => {
    throw new Error("the Setup tab must not read every clinic's strip");
  },
}));
vi.mock("./OnboardingPanel", () => ({ OnboardingPanel: () => null }));
vi.mock("./SetupSummary", () => ({ SetupSummary: () => null }));
vi.mock("./ConnectLink", () => ({ ConnectLink: () => null }));
vi.mock("@/lib/admin/ops-client", () => {
  const write = (name: string, data: unknown) => async (...args: unknown[]) => {
    state.writes.push([name, args]);
    return { ok: true, data };
  };
  const idle = async () => null;
  return {
    fetchOnboarding: async (clinicId: string) => {
      state.reads.push(["fetchOnboarding", clinicId]);
      return state.onboarding;
    },
    fetchClinicCards: async () => {
      state.reads.push(["fetchClinicCards"]);
      return { ok: true, data: { cards: [], limit: 50 } };
    },
    fetchClinicChanges: async (filter: unknown) => {
      state.reads.push(["fetchClinicChanges", filter]);
      return { ok: true, data: { since: "2026-09-24T00:00:00.000Z", changes: [] } };
    },
    fetchClinicAudits: async (clinicId: string, options?: unknown) => {
      state.reads.push(["fetchClinicAudits", clinicId, options]);
      return { ok: true, data: { clinics: [], history: null } };
    },
    fetchClinicBilling: async (clinicId: string) => {
      state.reads.push(["fetchClinicBilling", clinicId]);
      return {
        ok: true,
        data: {
          entitlements: { status: "setting_up", isPlanStarted: state.planStarted, setupDeadlineAt: state.deadlineAt, setupDeadlineIso: state.deadlineIso },
          notices: [],
          transitions: [],
        },
      };
    },
    fetchLifecycle: async (clinicId?: string) => {
      state.reads.push(["fetchLifecycle", clinicId ?? null]);
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
                deadlineAt: "2026-10-25T00:00:00.000Z",
                remainingDays: 1,
                decision: "none",
                decidedBy: null,
                decidedAt: null,
                snoozedUntil: null,
                snoozedBy: null,
                undeliveredCount: 0,
                decisionOwed: true,
                recommendation: { action: "extend", days: 14, reason: "Progress was made: extend by 14 days." },
              },
            ]
          : [],
      };
    },
    acknowledgeClinicChange: write("acknowledgeClinicChange", { status: "acknowledged", acknowledgedAt: "2026-10-24T10:00:00.000Z", auditRecorded: true }),
    decideLifecycle: write("decideLifecycle", { outcome: "saved" }),
    extendSetupDeadline: write("extendSetupDeadline", { status: "extended", setupDeadlineAt: "2026-11-15 00:00 UTC", auditRecorded: true }),
    runClinicAudit: write("runClinicAudit", { status: "busy" }),
    snoozeLifecycle: write("snoozeLifecycle", { outcome: "saved" }),
    issueConnectLink: idle,
    attachMetaChannel: idle,
    confirmWebWidget: idle,
    setMetaFrontDoor: idle,
    setMetaPlatform: idle,
    completeOnboardingStep: idle,
    disconnectCalendar: idle,
    goLive: idle,
    issueCalendarLink: idle,
    reopenOnboardingStep: idle,
    rerunPracticeQuestions: idle,
    retryCalendarWrite: idle,
    setAutoConfirm: idle,
    setBookingRequirements: idle,
    setClinicTimezone: idle,
    setPhoneSettings: idle,
    startForwardingTest: idle,
    updateAgentConfig: idle,
  };
});

const { default: SetupPage } = await import("./page");
const { AvailabilityChanges } = await import("./AvailabilityChanges");
const { SetupWindow } = await import("./SetupWindow");

type Props = Record<string, unknown>;

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

/** The element of one component type in the tree, with its props: the cards and the actions the page bound to them. */
function find(node: ReactNode, type: unknown): Props | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Props & { children?: ReactNode }>;
  if (element.type === type) return element.props;
  return element.props.children === undefined ? null : find(element.props.children, type);
}

async function page(): Promise<ReactNode> {
  return resolve(await SetupPage({ params: Promise.resolve({ clinicId: CLINIC }) }));
}

beforeEach(() => {
  state.reads = [];
  state.writes = [];
  state.onboarding = { ok: true, data: {} };
  state.watched = true;
  state.deadlineIso = "2026-11-01T00:00:00.000Z";
  state.deadlineAt = "2026-11-01 00:00 UTC";
  state.planStarted = false;
});

describe("the Setup tab", () => {
  test("reads the changes, audits, lifecycle and billing for this clinic, and draws both cards with the billing deadline", async () => {
    const tree = await page();
    const html = renderToStaticMarkup(tree as ReactElement).replace(/<!-- -->/g, "");
    expect(state.reads).toContainEqual(["fetchClinicChanges", { clinicId: CLINIC }]);
    // This clinic's audits without their history, and its lifecycle row alone (lane A4).
    expect(state.reads).toContainEqual(["fetchClinicAudits", CLINIC, { history: false }]);
    expect(state.reads).toContainEqual(["fetchClinicBilling", CLINIC]);
    expect(state.reads).toContainEqual(["fetchLifecycle", CLINIC]);
    expect(html).toContain('id="setup-window"');
    expect(html).toContain('id="availability"');
    const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(words).toContain("Window ends 2026-11-01 00:00 UTC");
    expect(words).not.toContain("2026-10-25");
    const window = find(tree, SetupWindow)!;
    expect(window.deadline).toEqual({ at: "2026-11-01 00:00 UTC", iso: "2026-11-01T00:00:00.000Z" });
    expect(window.canExtend).toBe(true);
  });

  test("draws no Setup window for a clinic the watch does not cover, and no Extend once the plan has started", async () => {
    state.watched = false;
    expect(renderToStaticMarkup((await page()) as ReactElement)).not.toContain("Setup window");
    state.watched = true;
    state.planStarted = true;
    const window = find(await page(), SetupWindow)!;
    expect(window.canExtend).toBe(false);
  });

  test("the extension names the deadline the page showed, and a second press after an extension works from the refreshed one", async () => {
    const first = find(await page(), SetupWindow)!;
    const extend = first.onExtend as (input: { days: number; fromDeadline: string }) => Promise<{ ok: boolean; data: { status: string } }>;
    const result = await extend({ days: 14, fromDeadline: first.deadline !== null ? (first.deadline as { iso: string }).iso : "" });
    expect(result.data.status).toBe("extended");
    expect(state.writes).toEqual([["extendSetupDeadline", [CLINIC, { days: 14, fromDeadline: "2026-11-01T00:00:00.000Z" }]]]);

    // The extension moved the deadline; the page re-renders with the new one and the next press names it.
    state.deadlineIso = "2026-11-15T00:00:00.000Z";
    state.deadlineAt = "2026-11-15 00:00 UTC";
    const second = find(await page(), SetupWindow)!;
    expect(second.deadline).toEqual({ at: "2026-11-15 00:00 UTC", iso: "2026-11-15T00:00:00.000Z" });
    const extendAgain = second.onExtend as typeof extend;
    await extendAgain({ days: 7, fromDeadline: "2026-11-15T00:00:00.000Z" });
    expect(state.writes.at(-1)).toEqual(["extendSetupDeadline", [CLINIC, { days: 7, fromDeadline: "2026-11-15T00:00:00.000Z" }]]);

    // Days outside 1 to 30, or no deadline, run nothing.
    const refused = await extendAgain({ days: 31, fromDeadline: "2026-11-15T00:00:00.000Z" });
    expect(refused.data.status).toBe("refused");
    expect(state.writes).toHaveLength(2);
  });

  test("an acknowledgement carries the clinic's id, a snooze is held to 3, 7 or 14, and a decision passes through", async () => {
    const tree = await page();
    const changes = find(tree, AvailabilityChanges)!;
    await (changes.onAcknowledge as (id: string) => Promise<unknown>)(CHANGE);
    expect(state.writes.at(-1)).toEqual(["acknowledgeClinicChange", [CHANGE, CLINIC]]);
    await (changes.onRunAudit as () => Promise<unknown>)();
    expect(state.writes.at(-1)).toEqual(["runClinicAudit", [CLINIC]]);

    const window = find(tree, SetupWindow)!;
    const snooze = window.onSnooze as (days: number) => Promise<unknown>;
    for (const [asked, sent] of [
      [3, 3],
      [14, 14],
      [7, 7],
      [5, 7],
      [0, 7],
    ] as const) {
      await snooze(asked);
      expect(state.writes.at(-1), String(asked)).toEqual(["snoozeLifecycle", [CLINIC, sent]]);
    }
    await (window.onDecide as (d: string) => Promise<unknown>)("let_close");
    expect(state.writes.at(-1)).toEqual(["decideLifecycle", [CLINIC, "let_close"]]);
  });

  test("a host that does not answer is the standby notice, as before", async () => {
    state.onboarding = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
    const html = renderToStaticMarkup((await page()) as ReactElement);
    expect(html).toContain("The AWS host is in standby.");
    expect(html).not.toContain('id="availability"');
  });
});
