import { describe, expect, test } from "vitest";

import { EMAIL_LOGO, EMAIL_WIDTH } from "./email-brand";
import { EMAIL_HTML_MAX_BYTES, emailHtmlDocument, htmlTwinOfText } from "./email-html";

/**
 * The HTML twin apps/web's emails get from their text (Annex X1.8): one
 * column in healdesk's branded shell (owner, 1 November 2026), system fonts,
 * the logo the only thing fetched, under 100 KB, and nothing in it the text
 * does not say.
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

  test("branded: the logo is the one image and the one thing fetched; system fonts, light and dark", () => {
    expect([...html.matchAll(/<img\b[^>]*>/g)]).toHaveLength(1);
    expect([...html.matchAll(/\bsrc="([^"]*)"/g)].map((m) => m[1])).toEqual([EMAIL_LOGO.url]);
    expect(html).toContain('alt="healdesk"');
    expect(html).not.toMatch(/url\(|@import|<link|<script|<iframe/i);
    expect(html).toContain("-apple-system");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(`width="${EMAIL_WIDTH}"`);
  });

  test("no title: these emails are letters, and the twin says only what the text says", () => {
    expect(html).not.toContain("<h1");
  });

  test("the footer after the rule is set apart under the hairline, one line to a paragraph", () => {
    const rule = html.indexOf('class="hd-rule"');
    expect(rule).toBeGreaterThan(html.indexOf("Questions:"));
    expect(html.indexOf("You&#39;re getting this because you asked.")).toBeGreaterThan(rule);
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
