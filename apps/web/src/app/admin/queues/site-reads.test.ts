import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SiteReadFailureRow } from "@/lib/admin/ops-client";

/**
 * Queues › Site reads (until 23 October 2026 /admin/site-reads), rendered as the operator sees it: "Read it again" sits
 * only beside a clinic that was set up and still has no profile, whose
 * purchase gave a website; a purchase never set up, or one whose profile has
 * arrived since, has nothing to read again.
 */

const operator = vi.hoisted(() => ({ signedIn: true }));
const failures = vi.hoisted(() => ({ rows: [] as SiteReadFailureRow[] }));

vi.mock("@/lib/admin/operator", () => ({
  requireOperator: async () => (operator.signedIn ? "ops@healdesk.test" : null),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/ops-client", async (original) => ({
  ...(await original<typeof import("@/lib/admin/ops-client")>()),
  fetchSiteReadFailures: async () => ({
    ok: true,
    data: { failures: failures.rows, limit: 100 },
  }),
}));

const { default: SiteReadsPage } = await import("./SiteReadsSection");

function row(over: Partial<SiteReadFailureRow>): SiteReadFailureRow {
  return {
    ref: "0b1c2d3e-4f50-4617-8899-aabbccddeeff",
    clinicName: "Glow Med Spa",
    website: "https://glowmedspa.com",
    createdAt: "2026-10-14T10:00:00.000Z",
    provisionedAt: "2026-10-14T10:05:00.000Z",
    clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    profileSince: false,
    ...over,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await SiteReadsPage()).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  operator.signedIn = true;
});

describe("/admin/site-reads", () => {
  test("offers a read again only to a clinic set up without a profile, with a website to read", async () => {
    failures.rows = [row({})];
    expect(await render()).toContain("Read it again");

    for (const over of [
      { profileSince: true },
      { clinicId: null, provisionedAt: null },
      { website: null },
    ]) {
      failures.rows = [row(over)];
      expect(await render(), JSON.stringify(over)).not.toContain("Read it again");
    }
  });
});
