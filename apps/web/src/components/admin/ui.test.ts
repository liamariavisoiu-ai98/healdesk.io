import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ActionButton, Chip, ClinicId, Empty, Failure, Row, Section, Tag, TONES } from "./ui";

/**
 * The admin console's shared pieces (E1 §3): every tone renders, with a
 * different pill and dot per tone, red only for `bad`; a failure names what
 * could not be read and says the ops client's sentence; an id is selectable
 * text with a copy control. Static markup,
 * read as text, as the other admin honesty rules are.
 */

const CLINIC = "259b4543-6709-495e-b804-692cc37c9e97";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

describe("the five tones", () => {
  test("every tone draws a tag and a chip, each with its own pill, and red is for bad alone", () => {
    const pills = new Set<string>();
    for (const tone of TONES) {
      const tag = renderToStaticMarkup(h(Tag, { tone, children: tone }));
      const chip = renderToStaticMarkup(h(Chip, { tone, children: tone }));
      expect(tag).toContain(`>${tone}<`);
      expect(chip).toContain(`<span>${tone}</span>`);
      const pill = tag.match(/class="([^"]+)"/)?.[1] ?? "";
      pills.add(pill);
      expect(pill.includes("text-red-deep")).toBe(tone === "bad");
    }
    expect(pills.size).toBe(TONES.length);
  });

  test("a chip with a link is an anchor to the tab that owns the state", () => {
    const html = renderToStaticMarkup(h(Chip, { tone: "warn", href: `/admin/clinics/${CLINIC}/billing`, children: "82%" }));
    expect(html).toMatch(/^<a href="\/admin\/clinics\/[0-9a-f-]+\/billing"/);
    expect(html).toContain("82%");
  });
});

describe("empty and failed", () => {
  test("a failure says what could not be read and the ops client's sentence, and offers a door only when signed out", () => {
    const failed = renderToStaticMarkup(
      h(Failure, { failure: { ok: false, code: "unreachable", message: "Could not reach the ops API." }, what: "the clinic list" }),
    );
    expect(failed).toContain("Could not read the clinic list: Could not reach the ops API.");
    expect(failed).not.toContain("/admin/sign-in");
    const out = renderToStaticMarkup(
      h(Failure, { failure: { ok: false, code: "unauthenticated", message: "Sign in first." }, what: "the jobs" }),
    );
    expect(out).toContain("/admin/sign-in");
  });

  test("an empty state is one line", () => {
    expect(renderToStaticMarkup(h(Empty, { children: "No clinics." }))).toBe('<p class="text-muted mt-4 text-sm">No clinics.</p>');
  });
});

describe("the small pieces", () => {
  test("a section is a card with a small-caps heading and an optional anchor", () => {
    const html = renderToStaticMarkup(h(Section, { title: "Jobs", id: "jobs", children: "body" }));
    expect(html).toMatch(/^<section id="jobs"/);
    expect(html).toContain("<h2");
    expect(html).toContain("Jobs");
    expect(html).toContain("body");
  });

  test("a row is a dt and a dd", () => {
    const html = renderToStaticMarkup(h("dl", null, h(Row, { label: "Last run", children: "Never" })));
    expect(html).toContain("<dt");
    expect(html).toContain("Last run");
    expect(html).toContain("<dd");
    expect(html).toContain("Never");
  });

  test("a clinic id is selectable text with a copy control", () => {
    const html = renderToStaticMarkup(h(ClinicId, { id: CLINIC }));
    expect(html).toContain("Clinic id");
    expect(html).toContain(`<code class="font-mono select-all">${CLINIC}</code>`);
    expect(html).toContain("Copy id");
  });

  test("an action button is idle with its verb, and a destructive one is not primary", () => {
    const send = renderToStaticMarkup(h(ActionButton, { label: "Send again", run: NEVER, variant: "primary" }));
    expect(send).toContain(">Send again</button>");
    expect(send).toContain("bg-ink");
    expect(send).not.toContain('role="status"');
    const close = renderToStaticMarkup(h(ActionButton, { label: "Close", run: NEVER, variant: "destructive", confirm: "This cancels the subscription." }));
    expect(close).not.toContain("bg-ink");
    // The confirm sentence waits for the first press.
    expect(close).not.toContain("This cancels the subscription.");
  });
});
