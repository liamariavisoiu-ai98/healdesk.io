import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { postInternalAlert, SLACK_TAG } from "./alert";

/**
 * apps/web's Slack alerts share the #alerts address with apps/app's ops
 * alerts (owner, 23 October 2026), so each post says which side sent it:
 * `[web]` here, `[app]` there.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("postInternalAlert", () => {
  test("tags every post [web]", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T000/B000/xyz");
    await postInternalAlert("Demo claimed: Radiance Aesthetics");
    expect(SLACK_TAG).toBe("[web]");
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { text: string };
    expect(body.text).toBe("[web] Demo claimed: Radiance Aesthetics");
  });

  test("posts nothing without a Slack address, or to anything else", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    await postInternalAlert("x");
    for (const url of [
      "https://example.com/hook",
      "https://hooks.slack.com@evil.example/services/x",
      "https://hooks.slack.com.evil.example/services/x",
      "http://hooks.slack.com/services/x",
    ]) {
      vi.stubEnv("SLACK_WEBHOOK_URL", url);
      await postInternalAlert("x");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
