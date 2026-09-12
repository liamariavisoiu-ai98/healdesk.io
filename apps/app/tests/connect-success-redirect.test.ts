import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The contract that keeps a finished setup from being reported as a failure.
 *
 * The bug this file exists to prevent had two halves and one cause. Without
 * JavaScript the connect form does a real POST to `/connect/<token>` — React 19
 * serialises its progressive-enhancement fields into the SSR'd markup — and Next
 * renders that page again to build the response. If `submitCredential()` returns
 * instead of redirecting, that second render re-resolves a token the same request
 * has just spent and ships the clinic to `/connect/invalid`. And if the redirect
 * is moved one line into the try block, `redirect()`'s NEXT_REDIRECT throw is
 * caught by the catch-all, logged, and answered with "We couldn't save that" —
 * to a clinic whose credential is committed and whose link is burned.
 *
 * Neither half is visible to the database-backed suite in connect-links.test.ts,
 * which exercises the store and never the action. So this file mocks everything
 * below the action and asserts the two things that actually broke: success
 * leaves this URL, and the leaving is not swallowed.
 *
 * `redirect` is mocked to *throw*, not to record and return. Stubbing it into a
 * quiet no-op would make the test pass with the redirect back inside the try,
 * which is the exact regression it is here to catch.
 */

// Declared inside the hoisted block because vi.mock factories are lifted above
// everything else in the file, and they need this class to exist.
const mocks = vi.hoisted(() => {
  /** Stands in for Next's NEXT_REDIRECT, which is also an exception. */
  class RedirectSignal extends Error {
    constructor(
      readonly url: string,
      readonly type: unknown,
    ) {
      super("NEXT_REDIRECT");
      this.name = "RedirectSignal";
    }
  }

  return {
    RedirectSignal,
    redirect: vi.fn((url: string, type?: unknown) => {
      throw new RedirectSignal(url, type);
    }),
    /** Flipped per test to drive the branch under examination. */
    burnSucceeds: { value: true },
    saveThrows: { value: null as Error | null },
    auditEntries: [] as unknown[],
  };
});

const { RedirectSignal } = mocks;

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  RedirectType: { push: "push", replace: "replace" },
}));

vi.mock("@/lib/connections/attempt-limit", () => ({
  withinConnectAttemptLimit: () => true,
}));

vi.mock("../src/app/connect/[token]/request-context", () => ({
  connectRequestContext: async () => ({
    ipAddress: "203.0.113.7",
    userAgent: "vitest",
  }),
}));

vi.mock("@/lib/connections/links", () => ({
  resolveConnectionLink: async () => ({
    linkId: "11111111-1111-4111-8111-111111111111",
    clinicId: "22222222-2222-4222-8222-222222222222",
    clinicName: "Radiance Med Spa",
    clinicSlug: "radiance",
    platformId: "acuity",
    attributionMode: "estimated",
  }),
  consumeConnectionLinkWithin: async () => mocks.burnSucceeds.value,
}));

vi.mock("@/lib/connections/store", () => ({
  saveConnection: async () => {
    if (mocks.saveThrows.value) throw mocks.saveThrows.value;
    return "33333333-3333-4333-8333-333333333333";
  },
}));

type FakeTx = {
  db: unknown;
  audit: { record: (entry: unknown) => void };
  clinicId: string;
};

vi.mock("@/lib/tenant", () => ({
  withTenant: async (
    _context: unknown,
    fn: (tx: FakeTx) => Promise<unknown>,
  ) =>
    fn({
      db: {},
      audit: { record: (entry: unknown) => mocks.auditEntries.push(entry) },
      clinicId: "22222222-2222-4222-8222-222222222222",
    }),
}));

// verify.ts is deliberately NOT mocked: it is pure, it reads the real
// catalogue, and letting it run is what makes "userId + apiKey" below the
// actual Acuity contract rather than this file's opinion of it.
const { submitCredential } = await import(
  "../src/app/connect/[token]/actions"
);

function acuityForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("token", "a-token-the-mocked-resolver-accepts");
  form.set("userId", "12345679");
  form.set("apiKey", "not-the-placeholder");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

let errors: unknown[][];

beforeEach(() => {
  mocks.redirect.mockClear();
  mocks.burnSucceeds.value = true;
  mocks.saveThrows.value = null;
  mocks.auditEntries.length = 0;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a stored credential leaves /connect/[token]", () => {
  test("success redirects to the static done page instead of returning", async () => {
    // Throwing out of the action is the pass condition. A resolved value here
    // means either no redirect at all (the no-JS render re-runs on a spent
    // token) or a redirect the catch-all ate.
    await expect(submitCredential({ status: "idle" }, acuityForm())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect.mock.calls[0]?.[0]).toBe("/connect/done");
  });

  test("it replaces the history entry, so Back is not a dead link", async () => {
    // `push` is the Server Action default, and it leaves /connect/<token> one
    // Back away — a spent token, which answers "This link is no longer valid"
    // to someone who was just told they were finished.
    await expect(
      submitCredential({ status: "idle" }, acuityForm()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mocks.redirect.mock.calls[0]?.[1]).toBe("replace");
  });

  test("nothing is logged as a failure on the way out", async () => {
    await expect(
      submitCredential({ status: "idle" }, acuityForm()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    // The signature of the swallowed-redirect regression: a committed
    // credential written to the log as a failed submission.
    expect(errors).toEqual([]);
  });

  test("losing the burn still ends at done, and still records the loss", async () => {
    // A second submission against a link the clinic's own first tab already
    // spent. actions.ts tells them it worked, because for them it did — that
    // has to survive as a redirect rather than an exception.
    mocks.burnSucceeds.value = false;

    await expect(
      submitCredential({ status: "idle" }, acuityForm()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mocks.redirect.mock.calls[0]?.[0]).toBe("/connect/done");
    expect(mocks.auditEntries).toContainEqual(
      expect.objectContaining({
        resourceType: "connection_link",
        metadata: expect.objectContaining({ reason: "lost_the_burn" }),
      }),
    );
  });
});

describe("failures still come back as state, not as a redirect", () => {
  test("a missing field is answered on the field, and nobody is sent anywhere", async () => {
    const state = await submitCredential(
      { status: "idle" },
      acuityForm({ apiKey: "" }),
    );

    expect(state).toEqual({
      status: "failed",
      message: "API key is required.",
      field: "apiKey",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  test("a pasted placeholder is caught before anything is written", async () => {
    const state = await submitCredential(
      { status: "idle" },
      acuityForm({ apiKey: "abc123…" }),
    );

    expect(state).toMatchObject({ status: "failed", field: "apiKey" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  test("a database failure is still the generic message, and still logged", async () => {
    mocks.saveThrows.value = new Error("connection terminated unexpectedly");

    const state = await submitCredential({ status: "idle" }, acuityForm());

    expect(state).toMatchObject({ status: "failed" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    // Never the driver's message: on this path its bound parameters are the
    // clinic's credential. See describeError().
    expect(JSON.stringify(errors)).not.toContain("not-the-placeholder");
  });
});
