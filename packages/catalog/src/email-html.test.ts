import { describe, expect, test } from "vitest";

import { EMAIL_HTML_MAX_BYTES, emailHtmlDocument, htmlTwinOfText } from "./email-html";

/**
 * The HTML twin apps/web's emails get from their text (Annex X1.8): one
 * column, system fonts, no images and nothing fetched, under 100 KB, and
 * nothing in it the text does not say.
 */

const TEXT = [
  "Hi Sam,",
  "",
  "Here is your setup link for Radiance <Med> Spa & Co:",
  "",
  "https://healdesk.io/start?t=abc.def",
  "",
  "It works until Tuesday 20 October. Questions: https://healdesk.io/contact.",
  "",
  "--",
  "You're getting this because you asked.",
  "Replies reach the healdesk team. Please leave out patient details.",
].join("\n");

function visible(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<\/p>|<hr[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("htmlTwinOfText", () => {
  const html = htmlTwinOfText("Your setup link", TEXT)!;

  test("says every word the text says, escaped, and nothing else", () => {
    expect(visible(html)).toBe(
      TEXT.replace(/\n--\n/, "\n")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(html).not.toContain("<Med>");
    expect(html).toContain("Radiance &lt;Med&gt; Spa &amp; Co");
  });

  test("links only the addresses the text carries, without their trailing full stop", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://healdesk.io/start?t=abc.def", "https://healdesk.io/contact"]);
  });

  test("one column, system fonts, no images, nothing remote, light and dark", () => {
    expect(html).not.toMatch(/<img|<table|src=|url\(|@import|<link/i);
    expect(html).toContain("-apple-system");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("max-width:600px");
  });

  test("the footer after the rule is set apart, one line to a paragraph", () => {
    expect(html).toContain("<hr");
    expect(html).toMatch(/class="hd-muted"[^>]*>You&#39;re getting this because you asked\.<\/p>/);
  });

  test("a text that would be over the ceiling gets no twin rather than a clipped one", () => {
    expect(htmlTwinOfText("Long", "a".repeat(EMAIL_HTML_MAX_BYTES))).toBeNull();
    expect(new TextEncoder().encode(html).length).toBeLessThan(EMAIL_HTML_MAX_BYTES);
  });

  test("the document escapes its title", () => {
    expect(emailHtmlDocument("A <b> title", "<p>x</p>")).toContain(
      "<title>A &lt;b&gt; title</title>",
    );
  });
});
