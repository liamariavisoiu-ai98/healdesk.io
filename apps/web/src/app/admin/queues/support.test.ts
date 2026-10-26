import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Queues › Support (until 23 October 2026 /admin/support), as the operator sees it (WP5): the escalations still owed
 * a reply, each with a "Mark replied" form, those past their day flagged;
 * the replied ones with when they were marked; and the host-in-standby notice
 * rather than an error when apps/app does not answer.
 */

const state = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchSupportRequests: async () => state.result,
  markSupportReplied: async () => ({ ok: true, data: { status: "marked" } }),
}));

const { default: SupportRequestsPage } = await import("./SupportSection");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OWED = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const DONE = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";

async function render(result?: string): Promise<string> {
  const element = await SupportRequestsPage({
    searchParams: Promise.resolve(result ? { result } : {}),
  });
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.result = {
    ok: true,
    data: {
      unreadClinics: 0,
      requests: [
        {
          clinicId: CLINIC,
          clinicSlug: "radiance",
          requestId: OWED,
          topic: "billing",
          replyByOn: "2026-10-07",
          askedAt: "2026-10-06T15:00:00.000Z",
          repliedAt: null,
          pastDue: true,
        },
        {
          clinicId: CLINIC,
          clinicSlug: "radiance",
          requestId: DONE,
          topic: "forwarding",
          replyByOn: "2026-10-07",
          askedAt: "2026-10-06T14:00:00.000Z",
          repliedAt: "2026-10-07T13:00:00.000Z",
          pastDue: false,
        },
      ],
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/admin/support", () => {
  test("lists what is owed with a mark button, flags the past-due, and shows what was replied", async () => {
    const html = await render();
    expect(html).toContain("Waiting for a reply (1)");
    expect(html).toContain("Replied (1)");
    expect(html).toContain(OWED);
    expect(html).toContain("Past its reply day");
    expect(html).toContain(`value="${OWED}"`);
    expect(html).not.toContain(`value="${DONE}"`);
    expect(html).toContain("Replied, marked 7 Oct, 09:00");
    expect(html).toContain(`/admin/clinics/${CLINIC}/care`);
  });

  test("points at the Support page for the requests that opened a case, and says this list is only those with none", async () => {
    const html = await render();
    expect(html).toContain('href="/admin/support"');
    expect(html).toContain("Only requests with no case are listed here.");
  });

  test("says what the mark did", async () => {
    expect(await render("marked")).toContain("Marked replied.");
  });

  test("a host in standby is the standby notice, not an error", async () => {
    state.result = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
    const html = await render();
    expect(html).toContain("The AWS host is in standby.");
    expect(html).not.toContain("Waiting for a reply");
  });
});
