import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { HelpPanel } from "@/app/c/[slug]/HelpPanel";
import { SupportChat } from "@/app/c/[slug]/SupportChat";

/**
 * The support chat's interface (plan Part H, F7 and F8), rendered on the
 * server as the portal first sends it: Help offers the chat and a bubble
 * keeps it in the corner of every screen; the input carries the permanent
 * line "This is product support. Please don't paste {patient|client}
 * information", worded by audience; a reply is announced through one polite
 * status region; and a message is a text node, never markup.
 */

const params = vi.hoisted(() => ({ value: { slug: "glow" } as { slug?: string } | null }));
vi.mock("next/navigation", () => ({ useParams: () => params.value }));

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  params.value = { slug: "glow" };
  SAVED.HEALDESK_SUPPORT_PHONE = process.env.HEALDESK_SUPPORT_PHONE;
  process.env.HEALDESK_SUPPORT_PHONE = "+18886889404";
});

afterEach(() => {
  if (SAVED.HEALDESK_SUPPORT_PHONE === undefined) delete process.env.HEALDESK_SUPPORT_PHONE;
  else process.env.HEALDESK_SUPPORT_PHONE = SAVED.HEALDESK_SUPPORT_PHONE;
});

const FAILURE =
  "Sorry, the support chat isn't working right now. A person can help: please call (888) 688-9404 or email hello@healdesk.io.";

describe("the support chat in Help", () => {
  test("Help offers the chat beside the phone and email, with a bubble and one polite status region", () => {
    const html = renderToStaticMarkup(createElement(HelpPanel, { audience: "patients" }));
    expect(html).toContain("Ask the support chat");
    expect(html).toContain("(888) 688-9404");
    expect(html).toContain("hello@healdesk.io");
    // The bubble, fixed in the corner of every screen.
    expect(html).toMatch(
      /<button[^>]*class="[^"]*fixed bottom-4 right-4[^"]*"[^>]*>Help<\/button>/,
    );
    expect(html.match(/role="status" aria-live="polite"/g)).toHaveLength(1);
  });

  test("the input carries the permanent line, worded for patients or clients", () => {
    for (const [audience, one] of [
      ["patients", "patient"],
      ["clients", "client"],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(SupportChat, { audience, failureLine: FAILURE, defaultOpen: true }),
      );
      expect(html).toContain(`This is product support. Please don’t paste ${one} information.`);
      const rule = /<p id="([^"]+)"[^>]*>This is product support/.exec(html)?.[1];
      expect(rule).toBeTruthy();
      expect(html).toContain(`aria-describedby="${rule}"`);
      expect(html).toContain(`maxLength="2000"`);
      // The opening message says it again, since the input's helper text is easy to miss.
      expect(html).toContain(`can pass you to a person. Please don’t paste ${one} information here.`);
    }
  });

  test("off a clinic's pages there is no chat to open", () => {
    params.value = null;
    expect(
      renderToStaticMarkup(
        createElement(SupportChat, { audience: "patients", failureLine: FAILURE }),
      ),
    ).toBe("");
  });

  test("the chat's route calls requirePortal itself, refuses other sites, and never names the internal origin", () => {
    const route = readFileSync(
      join(process.cwd(), "src", "app", "c", "[slug]", "help", "chat", "route.ts"),
      "utf8",
    );
    expect(route).toMatch(/const portal = await requirePortal\(slug\);/);
    expect(route).toContain('site !== "same-origin"');
    expect(route).not.toContain("HEALDESK_APP_URL");
  });

  test("messages render as text in a pre-wrapped paragraph: no markdown or markup is ever interpreted", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "app", "c", "[slug]", "SupportChat.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|marked|markdown-it|remark/);
    expect(source).toContain("whitespace-pre-wrap");
  });
});
