import { describe, expect, test, vi } from "vitest";

/**
 * The three registers moved under Compliance (E1 step 6) and their old
 * addresses redirect forever: counsel's bookmarks and the runbooks name
 * them. The agreements redirect carries the register's own filters and
 * nothing else.
 */

vi.mock("next/navigation", () => ({
  permanentRedirect: (to: string) => {
    throw new Error(`308 ${to}`);
  },
}));

describe("the old compliance routes", () => {
  test("/admin/incidents and /admin/notices", async () => {
    const incidents = (await import("../incidents/page")).default;
    expect(() => incidents()).toThrow("308 /admin/compliance/incidents");
    const notices = (await import("../notices/page")).default;
    expect(() => notices()).toThrow("308 /admin/compliance/notices");
  });

  test("/admin/agreements keeps the register's filters", async () => {
    const agreements = (await import("../agreements/page")).default;
    await expect(agreements({ searchParams: Promise.resolve({ q: "Glow", status: "in_effect", evil: "x" }) })).rejects.toThrow(
      "308 /admin/compliance/agreements?q=Glow&status=in_effect",
    );
    await expect(agreements({ searchParams: Promise.resolve({}) })).rejects.toThrow("308 /admin/compliance/agreements");
  });
});
