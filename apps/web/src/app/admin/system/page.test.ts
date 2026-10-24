import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The System page (Phase 5, lane P5b): it reads the machine queues, the
 * stuck calendar writes (without demo clinics) and the undelivered
 * transcripts, draws "Requires your attention" and "Being watched" above the
 * page links, and with the AWS host in standby shows the one notice in their
 * place while the links still draw.
 */

const state = vi.hoisted(() => ({
  reads: [] as unknown[][],
  unreachable: false,
}));

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/components/admin/DemoPipelineRow", () => ({ LiveDemoPipelineRow: () => null }));
vi.mock("@/lib/admin/ops-client", () => {
  const unreachable = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
  return {
    fetchMachineQueues: async () => {
      state.reads.push(["fetchMachineQueues"]);
      if (state.unreachable) return unreachable;
      return {
        ok: true,
        data: {
          queues: [
            { key: "outbox", words: "Emails waiting to send", count: 2, oldestAgeMinutes: 90, needsAttention: true, tone: "warn", href: "/admin/system#attention", lowerBound: false },
            { key: "billing_requests", words: "Billing requests not done", count: 0, oldestAgeMinutes: null, needsAttention: false, tone: "ok", href: "/admin/system#attention", lowerBound: false },
          ],
          partial: [],
        },
      };
    },
    fetchStuckCalendarWrites: async (options?: unknown) => {
      state.reads.push(["fetchStuckCalendarWrites", options ?? null]);
      if (state.unreachable) return unreachable;
      return { ok: true, data: { writes: [], count: 0, truncated: false, unreadClinics: 0 } };
    },
    fetchUndeliveredTranscripts: async () => {
      state.reads.push(["fetchUndeliveredTranscripts"]);
      if (state.unreachable) return unreachable;
      return { ok: true, data: { clinics: [], unreadClinics: 0 } };
    },
  };
});

const { default: SystemPage } = await import("./page");

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

async function page(): Promise<string> {
  return renderToStaticMarkup((await resolve(await SystemPage())) as ReactElement).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.reads = [];
  state.unreachable = false;
});

describe("the System page", () => {
  test("reads the three sources (stuck writes without demo clinics) and draws the two sections above the links", async () => {
    const html = await page();
    expect(state.reads).toEqual([["fetchMachineQueues"], ["fetchStuckCalendarWrites", null], ["fetchUndeliveredTranscripts"]]);
    expect(html).toContain('id="attention"');
    const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(words).toContain("Requires your attention");
    expect(words).toContain("Emails waiting to send 2 oldest waiting 2 hours");
    expect(words).toContain("Being watched");
    expect(words).toContain("Billing requests not done 0");
    expect(html.indexOf('id="attention"')).toBeLessThan(html.indexOf('href="/admin/host"'));
    expect(html).toContain('href="/admin/system/jobs"');
    expect(html).not.toContain("The AWS host is in standby.");
  });

  test("a host that does not answer is one standby notice in the sections' place; the links still draw", async () => {
    state.unreachable = true;
    const html = await page();
    expect(html.match(/The AWS host is in standby\./g)).toHaveLength(1);
    expect(html).not.toContain('id="attention"');
    expect(html).not.toContain("Being watched");
    expect(html).not.toContain("Could not read");
    expect(html).toContain('href="/admin/host"');
    expect(html).toContain('href="/admin/system/jobs"');
  });
});
