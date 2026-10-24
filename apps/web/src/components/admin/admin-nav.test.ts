import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * The console's five sections (E1 step 8), with the current one marked from
 * the router's segment: a page that keeps its old address under System
 * (map, host, seo) still lights System, and an old section that now
 * redirects lights the section it became.
 */

const router = vi.hoisted(() => ({ segment: null as string | null }));
vi.mock("next/navigation", () => ({ useSelectedLayoutSegment: () => router.segment }));

const { AdminNav, SECTIONS, sectionFor } = await import("./AdminNav");

describe("the admin nav", () => {
  test("has exactly five sections", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual(["Home", "Clinics", "Queues", "Compliance", "System"]);
  });

  test("marks the section the segment belongs to", () => {
    expect(sectionFor(null)).toBe("/admin");
    expect(sectionFor("clinics")).toBe("/admin/clinics");
    expect(sectionFor("ops")).toBe("/admin/clinics");
    expect(sectionFor("support")).toBe("/admin/queues");
    expect(sectionFor("agreements")).toBe("/admin/compliance");
    // Lane P6b: the Patient rights page is under Compliance; the approval inbox's old address lights Queues.
    expect(sectionFor("rights")).toBe("/admin/compliance");
    expect(sectionFor("inbox")).toBe("/admin/queues");
    expect(sectionFor("map")).toBe("/admin/system");
    expect(sectionFor("host")).toBe("/admin/system");
    expect(sectionFor("sign-in")).toBeNull();
  });

  test("renders aria-current on the current section only", () => {
    router.segment = "queues";
    const html = renderToStaticMarkup(h(AdminNav));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Queues</);
    expect(html).toContain('href="/admin/compliance"');
  });
});
