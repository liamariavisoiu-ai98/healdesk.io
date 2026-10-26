import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listDemoCallbacks, recordDemoCallback } from "@/lib/demo/callbacks";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * Queues › Demo call backs (owner, 26 October 2026), rendered as the operator
 * sees it: who asked, the number to ring, what about, and a "Called" that
 * deletes the row. Only an operator gets it.
 */

const operator = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@/lib/admin/operator", () => ({
  requireOperator: async () => (operator.signedIn ? "ops@healdesk.test" : null),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { default: DemoCallbacksSection } = await import("./DemoCallbacksSection");

async function render(result?: string): Promise<string> {
  const element = await DemoCallbacksSection({ searchParams: Promise.resolve(result ? { result } : {}) });
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  operator.signedIn = true;
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("Queues › Demo call backs", () => {
  test("each call back with its number to ring, its topic, its demo and a Called button", async () => {
    await recordDemoCallback({
      slug: "lumen-aesthetics-ab2cd3ef4g",
      clinicName: "Lumen Aesthetics",
      firstName: "Josh",
      phoneE164: "+15125550147",
      topic: "Pricing for two locations",
      test: true,
      offerEndsAt: null,
      leadEmail: null,
    });
    const html = await render();
    expect(html).toContain("Demo call backs (1)");
    expect(html).toContain("Josh at Lumen Aesthetics");
    expect(html).toContain('href="tel:+15125550147"');
    expect(html).toContain("+1 512 555 0147");
    expect(html).toContain("Pricing for two locations");
    expect(html).toContain("/demo/lumen-aesthetics-ab2cd3ef4g");
    expect(html).toContain("Test call");
    expect(html).toContain(">Called</button>");
    expect(html).toContain("deleted after 30 days");
    expect(await listDemoCallbacks()).toHaveLength(1);
  });

  test("an empty queue says so, and an outcome is shown under its own key", async () => {
    expect(await render()).toContain("None waiting.");
    expect(await render("called")).toContain("Marked called. The number is deleted.");
    expect(await render("bogus")).not.toContain("role=\"status\"");
  });

  test("only an operator", async () => {
    operator.signedIn = false;
    await expect(render()).rejects.toThrow("redirect /admin/sign-in");
  });
});
