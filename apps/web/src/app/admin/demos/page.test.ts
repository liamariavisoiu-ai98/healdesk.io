import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetDemoCacheForTests, createDemoSession, updateDemoSession } from "@/lib/demo/sessions";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * /admin/demos, rendered as the operator sees it: the pipeline strip above
 * the list counts the register, and when the register cannot be read it
 * prints em-dashes and says so rather than a quiet month of zeros.
 */

vi.mock("@/lib/admin/operator", () => ({
  requireOperator: async () => "ops@healdesk.test",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));

const { default: DemosPage } = await import("./page");

async function render(): Promise<string> {
  const element = await DemosPage();
  return renderToStaticMarkup(element)
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  // The fake Sheet counts as configured (isMarketingStoreConfigured).
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
});

afterEach(() => __setSheetsClientForTests(null));

describe("/admin/demos", () => {
  test("counts the register in the strip above the list", async () => {
    const now = new Date();
    const ready = await createDemoSession({ clinicName: "Glow Spa", websiteUrl: "https://glowspa.test/", createdBy: "ops@healdesk.test" }, now);
    await updateDemoSession(ready.slug, { status: "ready", readyAt: now, auditVerdict: "pass" });
    const sold = await createDemoSession({ clinicName: "Radiance", websiteUrl: "https://radiance.test/", createdBy: "webhook" }, now);
    await updateDemoSession(sold.slug, { status: "ready", readyAt: now, auditVerdict: "pass", claimed: true, claimedAt: now, claimedPlan: "voice-500" });
    await createDemoSession({ clinicName: "Peachy", websiteUrl: "https://peachystudio.test/", createdBy: "homepage" }, now);
    __resetDemoCacheForTests();

    const page = await render();
    expect(page).toContain("7 days: 3 requested → 2 built → 1 claimed (50%)");
    expect(page).toContain("now: 2 live · 0 held · 0 failed · 0 stalled");
    expect(page).toContain("by source: operator 0/1 · outreach 1/1 · homepage 0/0");
    expect(page).not.toContain("could not be read");
    // The list below is still there.
    expect(page).toContain("Glow Spa");
    expect(page).toContain("Peachy");
  });

  test("a register that cannot be read leaves the strip at em-dashes, not zeros", async () => {
    const broken = new FakeSheets();
    broken.getValues = async () => {
      throw new Error("quota exceeded");
    };
    __setSheetsClientForTests(broken);
    __resetSheetSchemaForTests();

    const page = await render();
    expect(page).toContain("7 days: — requested → — built → — claimed (—)");
    expect(page).toContain("could not be read");
    expect(page).toContain("quota exceeded");
    expect(page).not.toMatch(/\b0 requested/);
  });
});
