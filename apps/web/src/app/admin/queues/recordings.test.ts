import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Queues › Retell deletions (until 23 October 2026 /admin/recordings), as the operator sees it: the calls Retell still held
 * past the deletion window (a recording there before that is expected, not
 * a failure), each open one with a "Delete at Retell" form and the reason
 * its last delete failed; the deleted ones with when; and the
 * host-in-standby notice rather than an error when apps/app does not answer.
 * apps/web holds no Retell key and never sees a recording's address.
 */

const state = vi.hoisted(() => ({ result: null as unknown, deleted: [] as [string, string][] }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchRecordingAlerts: async () => state.result,
  deleteRecordedCall: async (clinicId: string, alertId: string) => {
    state.deleted.push([clinicId, alertId]);
    return { ok: true, data: { status: "deleted", resolvedAt: "2026-10-21T13:00:00.000Z" } };
  },
}));

const { default: RecordingsPage } = await import("./RecordingsSection");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OPEN = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const DONE = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";

async function render(result?: string): Promise<string> {
  const element = await RecordingsPage({
    searchParams: Promise.resolve(result ? { result } : {}),
  });
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.deleted = [];
  state.result = {
    ok: true,
    data: {
      unreadClinics: 0,
      alerts: [
        {
          alertId: OPEN,
          clinicId: CLINIC,
          clinicSlug: "radiance",
          callId: "call_open_1",
          detectedAt: "2026-10-21T12:00:00.000Z",
          attempts: 1,
          lastAttemptAt: "2026-10-21T12:30:00.000Z",
          lastError: "Retell answered 500",
          resolvedAt: null,
        },
        {
          alertId: DONE,
          clinicId: CLINIC,
          clinicSlug: "radiance",
          callId: "call_done_1",
          detectedAt: "2026-10-20T12:00:00.000Z",
          attempts: 1,
          lastAttemptAt: "2026-10-20T15:00:00.000Z",
          lastError: null,
          resolvedAt: "2026-10-20T15:00:00.000Z",
        },
      ],
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/admin/recordings", () => {
  test("lists the open alerts with a delete button and the last failure, and the deleted ones with when", async () => {
    const html = await render();
    expect(html).toContain("Retell deletions");
    expect(html).toContain("then the call is deleted at Retell automatically");
    // A recording at Retell is no longer framed as a broken promise.
    expect(html).not.toContain("breaks our promise");
    expect(html).toContain("still at Retell 21 Oct, 08:00");
    expect(html).toContain("To delete (1)");
    expect(html).toContain("Deleted (1)");
    expect(html).toContain("call_open_1");
    expect(html).toContain("Last try: Retell answered 500");
    expect(html).toContain("Delete at Retell");
    expect(html).toContain(`value="${OPEN}"`);
    expect(html).not.toContain(`value="${DONE}"`);
    expect(html).toContain("Deleted at Retell 20 Oct, 11:00");
    expect(html).toContain(`/admin/clinics/${CLINIC}/care`);
    // Nothing that could be a recording's address or a caller's number.
    expect(html).not.toMatch(/\.wav|recording_url|\+1\d{6,}/);
  });

  test("says what the delete did, each outcome in its own words", async () => {
    expect(await render("deleted")).toContain("Deleted at Retell. The alert is resolved.");
    expect(await render("too_soon")).toContain("Not yet");
    expect(await render("failed")).toContain("Retell did not delete it");
  });

  test("a host in standby is the standby notice, not an error", async () => {
    state.result = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
    const html = await render();
    expect(html).toContain("The AWS host is in standby.");
    expect(html).not.toContain("To delete");
  });
});
