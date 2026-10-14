import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HostStandbyNotice, HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import type { OpsResult } from "@/lib/admin/ops-client";

import { listHostRuns, readRun, type HostRun } from "./github";
import { hostState, isHostUnreachable, probeLiveness } from "./state";

/**
 * /admin/host's reading of the AWS host, and what the other admin pages show
 * when it is in standby. The runs are what was asked and whether it finished;
 * the probe is whether anything answers. Neither is allowed to stand in for
 * the other.
 */

function run(over: Partial<HostRun> = {}): HostRun {
  return {
    id: 1,
    mode: "active",
    reason: "from /admin",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-10-14T09:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
    url: "https://github.com/liamariavisoiu-ai98/healdesk.io/actions/runs/1",
    ...over,
  };
}

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hostState: from host.yml's runs (newest first) and the probe", () => {
  test("the newest finished switch, successful, decides: active", () => {
    const state = hostState([run({ id: 2, mode: "active" }), run({ id: 1, mode: "standby" })], "answers");
    expect(state).toMatchObject({ state: "active", mode: "active" });
    expect(state.run?.id).toBe(2);
    expect(state.note).toMatch(/answers/);
  });

  test("standby, with nothing answering", () => {
    const state = hostState([run({ mode: "standby" })], "unreachable");
    expect(state).toMatchObject({ state: "standby", mode: "standby" });
    expect(state.note).toMatch(/nothing answers/);
  });

  test("a run not finished is switching, whatever finished before it", () => {
    for (const status of ["queued", "in_progress", "other"] as const) {
      const state = hostState([run({ id: 3, mode: "standby", status, conclusion: null }), run({ id: 2 })], "answers");
      expect(state, status).toMatchObject({ state: "switching", mode: "standby" });
      expect(state.run?.id).toBe(3);
    }
  });

  test("a failed or cancelled last switch is unsettled, and says which way it was going", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const state = hostState([run({ mode: "standby", conclusion }), run({ id: 0, mode: "active" })], "edge");
      expect(state, conclusion).toMatchObject({ state: "unsettled", mode: "standby" });
      expect(state.note).toContain("to standby");
    }
  });

  test("runs that name no mode do not count; no switch at all is unknown, read from the probe", () => {
    const unnamed = run({ mode: null });
    expect(hostState([unnamed], "answers")).toMatchObject({ state: "unknown", mode: null, run: null });
    expect(hostState([], "unreachable").note).toMatch(/nothing answers/);
    expect(hostState([], "edge").note).toMatch(/answers/);
  });

  test("the two sources disagreeing is said, not hidden", () => {
    expect(hostState([run({ mode: "active" })], "unreachable").note).toMatch(/nothing answers .* alarms/);
    expect(hostState([run({ mode: "standby" })], "answers").note).toMatch(/yet something answers/);
  });
});

describe("readRun and listHostRuns: GitHub's runs, field by field", () => {
  test("reads the mode and the reason from the run's name", () => {
    expect(
      readRun({
        id: 7,
        display_title: "Host standby (from /admin)",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-14T09:00:00Z",
        updated_at: "2026-10-14T09:20:00Z",
        html_url: "https://github.com/o/r/actions/runs/7",
      }),
    ).toMatchObject({ id: 7, mode: "standby", reason: "from /admin", status: "completed", conclusion: "success" });
    expect(readRun({ id: 8, display_title: "Deploy apps/app", status: "waiting", html_url: "https://github.com/o/r/actions/runs/8" })).toMatchObject({ mode: null, status: "queued" });
  });

  test("refuses anything that is not a run, or links anywhere but GitHub", () => {
    expect(readRun(null)).toBeNull();
    expect(readRun({ id: "9", html_url: "https://github.com/x" })).toBeNull();
    expect(readRun({ id: 9, html_url: "javascript:alert(1)" })).toBeNull();
  });

  test("lists newest first, and says so when GitHub cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          workflow_runs: [
            { id: 1, display_title: "Host active", status: "completed", conclusion: "success", created_at: "2026-10-13T09:00:00Z", html_url: "https://github.com/o/r/actions/runs/1" },
            { id: 2, display_title: "Host standby", status: "in_progress", conclusion: null, created_at: "2026-10-14T09:00:00Z", html_url: "https://github.com/o/r/actions/runs/2" },
          ],
        }),
      ),
    );
    const listed = await listHostRuns({ token: "t", repo: "o/r" });
    expect(listed.ok && listed.runs.map((r) => r.id)).toEqual([2, 1]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const missing = await listHostRuns({ token: "t", repo: "o/r" });
    expect(missing).toMatchObject({ ok: false });
  });
});

describe("probeLiveness: HEALDESK_APP_URL's /api/health?probe=liveness, three seconds at most", () => {
  test("ok, the edge, nothing, and no address", async () => {
    vi.stubEnv("HEALDESK_APP_URL", "https://app-internal.healdesk.io");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        seen.push(String(url));
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ ok: true });
      }),
    );
    expect(await probeLiveness()).toBe("answers");
    expect(seen).toEqual(["https://app-internal.healdesk.io/api/health?probe=liveness"]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    expect(await probeLiveness()).toBe("edge");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND app-internal.healdesk.io"); }));
    expect(await probeLiveness()).toBe("unreachable");

    vi.stubEnv("HEALDESK_APP_URL", "");
    expect(await probeLiveness()).toBe("unconfigured");
  });
});

describe("the standby notice, where an ops page would otherwise show an error", () => {
  const failure = (code: string): OpsResult<unknown> => ({ ok: false, code: code as never, message: "m" });

  test("an unreachable or silent host is standby's case; a refusal or a failure from a host that answered is not", () => {
    expect(isHostUnreachable(failure("unreachable"))).toBe(true);
    expect(isHostUnreachable(failure("timeout"))).toBe(true);
    for (const code of ["failed", "refused", "unauthenticated", "unconfigured", "forbidden", "malformed"]) {
      expect(isHostUnreachable(failure(code)), code).toBe(false);
    }
    expect(isHostUnreachable({ ok: true, data: {} })).toBe(false);
  });

  test("says the host is in standby, what lives there, and links to the switch", () => {
    const notice = renderToStaticMarkup(h(HostStandbyNotice, { what: "The agreement register" }));
    expect(text(h(HostStandbyNotice, { what: "The agreement register" }))).toMatch(
      /^The AWS host is in standby\. The agreement register lives on the AWS host/,
    );
    expect(notice).toContain('href="/admin/host"');
    expect(notice).toContain('role="status"');
  });

  test("as a page, with its title and the way back", () => {
    const page = text(h(HostStandbyPage, { title: "Billing", back: { href: "/admin/ops", label: "Back to ops" } }));
    expect(page).toMatch(/^Back to ops Billing The AWS host is in standby\./);
    expect(page).toContain("Host: turn it on");
  });
});
