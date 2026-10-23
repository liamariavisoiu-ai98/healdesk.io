import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { buildFixPrompt, decodeFixLink } from "@/lib/admin/fix-with-claude";

/**
 * The "Fix with Claude" panel (E7 step 3): drawn only under /admin, with the
 * prompt read-only and links that decode back to it; a refused prompt is
 * said with its reason and gets no link.
 */

const router = vi.hoisted(() => ({ pathname: "/admin/clinics/x/setup" }));
vi.mock("next/navigation", () => ({ usePathname: () => router.pathname }));

const { FixWithClaude } = await import("./FixWithClaude");

const ALERT = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("the Fix with Claude panel", () => {
  test("renders only on /admin", () => {
    const built = buildFixPrompt({ event: "calendar_broken", alertId: ALERT, clinicId: CLINIC });
    router.pathname = "/admin/clinics/" + CLINIC + "/setup";
    expect(renderToStaticMarkup(h(FixWithClaude, { built }))).toContain("Open in Claude Code");
    router.pathname = "/c/radiance/home";
    expect(renderToStaticMarkup(h(FixWithClaude, { built }))).toBe("");
    router.pathname = "/administer";
    expect(renderToStaticMarkup(h(FixWithClaude, { built }))).toBe("");
  });

  test("the link decodes back to the template, and the prompt is on the page read-only", () => {
    router.pathname = "/admin";
    const built = buildFixPrompt({ event: "transcript_undelivered", alertId: ALERT, clinicId: CLINIC, raisedAt: "2026-10-23T09:12:00.000Z", repeats: 2 });
    if (!built.ok) throw new Error(built.reason);
    const html = renderToStaticMarkup(h(FixWithClaude, { built }));
    const cli = html.match(/href="(claude-cli:[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(cli).toBeDefined();
    expect(decodeFixLink(cli!)).toBe(built.prompt);
    const code = html.match(/href="(vscode:[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(decodeFixLink(code!)).toBe(built.prompt);
    expect(html).toContain("<pre");
    expect(html).toContain("Copy prompt");
    expect(html).toContain("docs/on-call.md#transcripts");
    expect(html).not.toContain("<textarea");
  });

  test("a refused prompt is said and gets no link", () => {
    router.pathname = "/admin";
    const html = renderToStaticMarkup(h(FixWithClaude, { built: buildFixPrompt({ event: "Radiance Med Spa", alertId: ALERT }) }));
    expect(html).toContain("No prompt for this issue: not an ops event from the closed list.");
    expect(html).not.toContain("claude-cli:");
  });
});
