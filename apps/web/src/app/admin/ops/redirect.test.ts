import { describe, expect, test, vi } from "vitest";

/** /admin/ops, the old console, redirects forever to the Clinics list (E1 step 8): summary alerts and runbooks name it. */

vi.mock("next/navigation", () => ({
  permanentRedirect: (to: string) => {
    throw new Error(`308 ${to}`);
  },
}));

describe("the old ops console address", () => {
  test("/admin/ops redirects forever to /admin/clinics", async () => {
    const page = (await import("./page")).default;
    expect(() => page()).toThrow("308 /admin/clinics");
  });
});
