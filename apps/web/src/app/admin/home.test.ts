import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * /admin, Home, as the operator sees it: with the AWS host in standby, ONE
 * standby notice and no list; otherwise the list from lib/admin/inbox.ts.
 */

const state = vi.hoisted(() => ({ liveness: "answers" as string, loads: 0 }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/host/state", () => ({ probeLiveness: async () => state.liveness }));
vi.mock("@/lib/admin/inbox", () => ({
  loadOpsInbox: async () => {
    state.loads += 1;
    return {
      rows: [
        {
          id: "queue:support",
          kind: "support_owed",
          count: 2,
          sentence: "support requests are owed a reply from hello@.",
          clinic: null,
          button: { label: "Open Queues › Support", kind: "link", href: "/admin/queues#support" },
          tone: "warn",
          dueAt: null,
        },
      ],
      checkedAt: "2026-10-23T09:12:00.000Z",
      unreadable: [],
    };
  },
}));

const { default: HomePage } = await import("./page");

async function render(): Promise<string> {
  return renderToStaticMarkup(await HomePage()).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.loads = 0;
});

describe("/admin", () => {
  test("a host in standby is one standby notice, with no list and no read", async () => {
    state.liveness = "unreachable";
    const html = await render();
    expect(html).toContain("The AWS host is in standby.");
    expect(html.match(/The AWS host is in standby\./g)).toHaveLength(1);
    expect(html).not.toContain("support requests are owed");
    expect(state.loads).toBe(0);
  });

  test("otherwise the list, each row with its count, sentence and button", async () => {
    state.liveness = "answers";
    const html = await render();
    expect(html).not.toContain("The AWS host is in standby.");
    expect(html).toContain("support requests are owed a reply from hello@.");
    expect(html).toContain('href="/admin/queues#support"');
    expect(html).toContain("Last checked 09:12 UTC.");
    expect(state.loads).toBe(1);
  });
});
