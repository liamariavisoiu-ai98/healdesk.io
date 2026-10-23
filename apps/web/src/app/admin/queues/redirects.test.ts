import { describe, expect, test, vi } from "vitest";

/**
 * Every old queue address redirects forever to its section on /admin/queues
 * (E1 step 5, owner decision D11): runbooks, the setup-replies cron's email
 * and the ops alerts name them. A form's outcome travels into the section's
 * own query key; anything that is not an outcome word is dropped.
 */

vi.mock("next/navigation", () => ({
  permanentRedirect: (to: string) => {
    throw new Error(`308 ${to}`);
  },
}));

describe("the old queue routes", () => {
  test("/admin/reviews and /admin/site-reads", async () => {
    const reviews = (await import("../reviews/page")).default;
    expect(() => reviews()).toThrow("308 /admin/queues#reviews");
    const siteReads = (await import("../site-reads/page")).default;
    expect(() => siteReads()).toThrow("308 /admin/queues#site-reads");
  });

  test("/admin/support, /admin/recordings and /admin/setup keep a form's outcome in their own key", async () => {
    const support = (await import("../support/page")).default;
    await expect(support({ searchParams: Promise.resolve({ result: "marked" }) })).rejects.toThrow("308 /admin/queues?support=marked#support");
    await expect(support({ searchParams: Promise.resolve({}) })).rejects.toThrow("308 /admin/queues#support");
    const recordings = (await import("../recordings/page")).default;
    await expect(recordings({ searchParams: Promise.resolve({ result: "deleted" }) })).rejects.toThrow(
      "308 /admin/queues?retell=deleted#retell-deletions",
    );
    const setup = (await import("../setup/page")).default;
    await expect(setup({ searchParams: Promise.resolve({ result: "closed" }) })).rejects.toThrow("308 /admin/queues?setup=closed#setup-requests");
    await expect(setup({ searchParams: Promise.resolve({ result: "<script>" }) })).rejects.toThrow("308 /admin/queues#setup-requests");
  });
});
