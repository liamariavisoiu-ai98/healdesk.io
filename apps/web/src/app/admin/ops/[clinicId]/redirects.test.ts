import { describe, expect, test, vi } from "vitest";

/**
 * Every old per-clinic address redirects forever to its tab on the clinic
 * panel (E1 step 3): the alert emails apps/app sent before the redesign link
 * to /admin/ops/<id>/care and /onboarding, and a link in a mailbox cannot be
 * recalled. A 308, not a 404; an id that is not an id is not found, never
 * forwarded.
 */

vi.mock("next/navigation", () => ({
  permanentRedirect: (to: string) => {
    throw new Error(`308 ${to}`);
  },
  redirect: (to: string) => {
    throw new Error(`307 ${to}`);
  },
  notFound: () => {
    throw new Error("404");
  },
}));

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const params = Promise.resolve({ clinicId: CLINIC });

type OldPage = (props: { params: Promise<{ clinicId: string }> }) => Promise<unknown>;

describe("the old per-clinic routes", () => {
  test.each<[string, string, () => Promise<{ default: OldPage }>]>([
    ["onboarding", "setup", () => import("./onboarding/page")],
    ["billing", "billing", () => import("./billing/page")],
    ["care", "care", () => import("./care/page")],
    ["account", "account", () => import("./account/page")],
  ])("/admin/ops/<id>/%s redirects forever to the %s tab", async (_old, tab, load) => {
    const { default: page } = await load();
    await expect(page({ params })).rejects.toThrow(`308 /admin/clinics/${CLINIC}/${tab}`);
    await expect(page({ params: Promise.resolve({ clinicId: "radiance" }) })).rejects.toThrow("404");
  });

  test("/admin/ops/<id>/transcripts redirects to Deliveries, keeping an offered window and dropping anything else", async () => {
    const { default: page } = await import("./transcripts/page");
    await expect(page({ params, searchParams: Promise.resolve({ days: "90" }) })).rejects.toThrow(
      `308 /admin/clinics/${CLINIC}/deliveries?days=90`,
    );
    await expect(page({ params, searchParams: Promise.resolve({ days: "365" }) })).rejects.toThrow(
      `308 /admin/clinics/${CLINIC}/deliveries`,
    );
    await expect(page({ params, searchParams: Promise.resolve({}) })).rejects.toThrow(`308 /admin/clinics/${CLINIC}/deliveries`);
  });

  test("/admin/clinics/<id> opens the Setup tab", async () => {
    const { default: page } = await import("../../clinics/[clinicId]/page");
    await expect(page({ params })).rejects.toThrow(`307 /admin/clinics/${CLINIC}/setup`);
  });
});
