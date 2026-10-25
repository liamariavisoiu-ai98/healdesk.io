import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * /admin/queues as the operator sees it with the AWS host in standby: ONE
 * standby notice, the apps/app sections absent, and the Sheet-backed setup
 * requests section still there, since it does not need the host.
 */

const state = vi.hoisted(() => ({ liveness: "unreachable" as string }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/host/state", () => ({ probeLiveness: async () => state.liveness, isHostUnreachable: () => false }));
vi.mock("@/lib/sheets/client", () => ({ isMarketingStoreConfigured: () => false }));
vi.mock("@/lib/admin/ops-client", () => {
  const never = async () => {
    throw new Error("the host must not be read in standby");
  };
  return {
    fetchPracticeReviews: never,
    fetchAgreementReviews: never,
    fetchSupportRequests: never,
    fetchRecordingAlerts: never,
    fetchSiteReadFailures: never,
    fetchApprovals: never,
    fetchApprovalHistory: never,
    fetchIncidentApprovals: never,
    fetchIncidentApprovalHistory: never,
    previewApprovalDraft: never,
    fetchJobs: never,
  };
});
vi.mock("@/lib/admin/approval-decide", () => ({
  decideApprovalWithCode: async () => {
    throw new Error("no decision is made during a render");
  },
}));

const { default: QueuesPage } = await import("./page");

/**
 * react-dom/server cannot render an async server component, so the page's
 * async sections are called and awaited here first, the way the router
 * would, and their elements put in their place.
 */
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

describe("/admin/queues in standby", () => {
  test("is one standby notice, with the setup requests still shown and nothing read from the host", async () => {
    state.liveness = "unreachable";
    const tree = await resolve(await QueuesPage({ searchParams: Promise.resolve({}) }));
    const html = renderToStaticMarkup(tree as ReactElement).replace(/<!-- -->/g, "");
    expect(html.match(/The AWS host is in standby\./g)).toHaveLength(1);
    expect(html).toContain("Every queue but the setup requests");
    expect(html).toContain("No lead register is configured");
    expect(html).not.toContain('id="reviews"');
    expect(html).not.toContain('id="support"');
    expect(html).not.toContain('id="approvals"');
    // The section is still in the page's own nav, first: the owner's money decisions.
    expect(html).toContain('href="#approvals"');
  });
});
