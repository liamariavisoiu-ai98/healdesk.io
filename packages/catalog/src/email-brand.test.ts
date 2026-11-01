import { describe, expect, test } from "vitest";

import {
  brandedEmailDocument,
  EMAIL_COLORS,
  EMAIL_DARK_COLORS,
  EMAIL_LOGO,
  emailButtonHtml,
  escapeEmailHtml,
} from "./email-brand";

/**
 * healdesk's branded email shell (owner, 1 November 2026: every email
 * branded, Apple-like): the logo at the top, the title, the body, the footer
 * under a hairline. These pin what every email inherits from it.
 */

const doc = (over: Partial<Parameters<typeof brandedEmailDocument>[0]> = {}) =>
  brandedEmailDocument({
    subject: "Your healdesk sign-in link",
    preheader: "It works once.",
    title: "Your healdesk sign-in link",
    bodyHtml: '<p class="hd-ink">BODY_MARK</p>',
    footerHtml: '<p class="hd-muted">FOOTER_MARK</p>',
    ...over,
  });

describe("the logo", () => {
  test("is one public file at one fixed URL: no query, no id, nothing about the reader", () => {
    const url = new URL(EMAIL_LOGO.url);
    expect(url.protocol).toBe("https:");
    expect(url.origin).toBe("https://healdesk.io");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.pathname).toBe("/brand/healdesk-logo-email.png");
  });

  test("is the one image and the one thing fetched, its alt text the name", () => {
    const html = doc();
    expect([...html.matchAll(/<img\b[^>]*>/g)]).toHaveLength(1);
    expect([...html.matchAll(/\bsrc="([^"]*)"/g)].map((m) => m[1])).toEqual([EMAIL_LOGO.url]);
    expect(html).toContain(`alt="${EMAIL_LOGO.alt}"`);
    expect(html).toContain(`width="${EMAIL_LOGO.width}" height="${EMAIL_LOGO.height}"`);
    expect(html).not.toMatch(/url\(|@import|<link|<script|<iframe|@font-face/i);
  });

  test("is not a link", () => {
    expect(doc({ bodyHtml: "", footerHtml: "" })).not.toMatch(/href=/);
  });
});

describe("the document", () => {
  test("escapes the subject, the title and the preheader", () => {
    const html = doc({ subject: "A <b> & co", title: "T <i>", preheader: "P \"q\" 'x'" });
    expect(html).toContain("<title>A &lt;b&gt; &amp; co</title>");
    expect(html).toContain(">T &lt;i&gt;</h1>");
    expect(html).toContain("P &quot;q&quot; &#39;x&#39;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });

  test("prints the title under the logo, or none", () => {
    const html = doc();
    expect(html.indexOf("<h1")).toBeGreaterThan(html.indexOf("<img"));
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("BODY_MARK"));
    expect(doc({ title: null })).not.toContain("<h1");
    expect(doc({ title: "  " })).not.toContain("<h1");
  });

  test("puts the footer under its hairline, after the body, and leaves it out when there is none", () => {
    const html = doc();
    // The footer opens with the document's one <hr>: the email above it, the footer below.
    const rule = html.indexOf("<hr");
    expect(html.indexOf("<hr", rule + 1)).toBe(-1);
    expect(html.slice(rule, html.indexOf(">", rule))).toContain(`border-top:1px solid ${EMAIL_COLORS.rule}`);
    expect(rule).toBeGreaterThan(html.indexOf("BODY_MARK"));
    expect(html.indexOf("FOOTER_MARK")).toBeGreaterThan(rule);
    expect(doc({ footerHtml: "" })).not.toContain("<hr");
  });

  test("a hidden preheader, stopped before the body runs into the inbox preview", () => {
    const html = doc();
    expect(html).toMatch(/<div style="display:none;[^"]*">It works once\.(&#847;&zwnj;&nbsp;)+<\/div>/);
    expect(doc({ preheader: "" })).not.toContain("display:none");
  });

  test("light by inline style, dark by class: every colour dark mode repaints is named", () => {
    const html = doc();
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    for (const colour of Object.values(EMAIL_DARK_COLORS)) expect(html).toContain(colour);
    expect(html).toContain(`background:${EMAIL_COLORS.page}`);
    expect(html).toContain("[data-ogsc] .hd-ink");
  });

  test("a 600-pixel column, the system font stack, and Outlook's own fallbacks", () => {
    const html = doc();
    expect(html).toContain('width="600"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain("-apple-system,BlinkMacSystemFont,'SF Pro Text'");
    expect(html).toContain("<!--[if mso]>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  test("stays small: the shell alone is a few kilobytes of Gmail's 102", () => {
    expect(new TextEncoder().encode(doc()).length).toBeLessThan(8 * 1024);
  });
});

describe("the button", () => {
  test("escapes its label and its address", () => {
    const html = emailButtonHtml('Sign <in> "now"', "https://app.healdesk.test/x?a=1&b=2");
    expect(html).toContain('href="https://app.healdesk.test/x?a=1&amp;b=2"');
    expect(html).toContain(">Sign &lt;in&gt; &quot;now&quot;</a>");
  });

  test("the first is the filled pill dark mode inverts; a later one is outlined", () => {
    const primary = emailButtonHtml("Sign in", "https://app.healdesk.test/x");
    expect(primary).toContain('class="hd-action"');
    expect(primary).toContain(`background:${EMAIL_COLORS.ink}`);
    expect(primary).toContain("border-radius:980px");
    const secondary = emailButtonHtml("Open Billing", "https://app.healdesk.test/b", "secondary");
    expect(secondary).not.toContain('class="hd-action"');
    expect(secondary).toContain(`border:1px solid ${EMAIL_COLORS.ink}`);
    // A collapsed table squares a cell's corners: the button's own table keeps them round.
    for (const html of [primary, secondary]) expect(html).toContain("border-collapse:separate");
  });
});

test("escapeEmailHtml escapes the five characters HTML gives meaning to", () => {
  expect(escapeEmailHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});
