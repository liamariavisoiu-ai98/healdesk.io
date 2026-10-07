import { describe, expect, test } from "vitest";

import {
  decodeEntities,
  htmlToText,
  pageTexts,
  pickPages,
  readLinks,
  sameSite,
  TEXT_LIMITS,
} from "./html";

describe("htmlToText", () => {
  test("keeps the words, drops scripts, styles and markup, and breaks lines at blocks", () => {
    const html = `<!doctype html><html><head><title>Glow Med Spa</title>
      <style>body { color: red }</style><script>window.secret = "x"</script>
      <script type="application/ld+json">{"@type":"LocalBusiness"}</script></head>
      <body><nav><ul><li>Home</li><li>Services</li></ul></nav>
      <h1>Glow &amp; Co</h1><p>Open <b>Mon&ndash;Fri</b> 9&nbsp;am to 5 pm.</p>
      <!-- <p>hidden</p> --><noscript><p>Enable JavaScript</p></noscript>
      <svg><text>icon</text></svg><table><tr><td>Botox</td><td>$14 per unit</td></tr></table></body></html>`;
    expect(htmlToText(html).split("\n")).toEqual([
      "Glow Med Spa",
      "Home",
      "Services",
      "Glow & Co",
      "Open Mon–Fri 9 am to 5 pm.",
      "Botox | $14 per unit",
    ]);
  });

  test("a stray < is text, and an unterminated tag ends the document", () => {
    expect(htmlToText("<p>Facials under <$200</p><p>more")).toBe("Facials under <$200\nmore");
    expect(htmlToText("<p>Hello</p><div class='x")).toBe("Hello");
  });

  test("a skipped element with no end skips the rest", () => {
    expect(htmlToText("<p>Before</p><script>never closed")).toBe("Before");
  });

  test("upper-case markup reads the same", () => {
    expect(htmlToText("<P>One</P><SCRIPT>x()</SCRIPT><DIV>Two</DIV>")).toBe("One\nTwo");
  });

  test("stays linear on adversarial markup", () => {
    const hostile = `${"<".repeat(200_000)}${"<!--".repeat(50_000)}${"<a href=".repeat(20_000)}`;
    const started = performance.now();
    htmlToText(hostile);
    readLinks(hostile, new URL("https://glow.com/"));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("decodeEntities", () => {
  test("named, decimal and hex entities; unknown ones and prototype names stay as written", () => {
    expect(decodeEntities("&lt;b&gt; &#36;14 &#x24;14 &eacute; &bogus; &constructor;")).toBe(
      "<b> $14 $14 é &bogus; &constructor;",
    );
  });

  test("a code point out of range stays as written", () => {
    expect(decodeEntities("&#xD800; &#1114112;")).toBe("&#xD800; &#1114112;");
  });
});

describe("readLinks", () => {
  test("resolves links against the page, keeps their text, drops fragments and other schemes", () => {
    const links = readLinks(
      `<a href="/services">Our <b>Services</b></a> <a href='pricing#top'>Prices</a>
       <a href=https://other.com/x>Elsewhere</a> <a href="mailto:hi@glow.com">Mail</a>
       <a href="tel:+15125550100">Call</a> <a href="javascript:alert(1)">x</a> <a name="anchor">no href</a>`,
      new URL("https://glow.com/home/"),
    );
    expect(links.map((l) => [l.url.href, l.text])).toEqual([
      ["https://glow.com/services", "Our Services"],
      ["https://glow.com/home/pricing", "Prices"],
      ["https://other.com/x", "Elsewhere"],
    ]);
  });
});

describe("pickPages", () => {
  const home = new URL("https://www.glowmedspa.com/");
  const link = (href: string, text = "") => ({ url: new URL(href, home), text });

  test("one page of each kind first, menu and prices before the rest, shallow before deep", () => {
    const picked = pickPages(
      [
        link("/about-us", "About"),
        link("/faq", "FAQ"),
        link("/contact", "Contact"),
        link("/meet-the-team", "Our team"),
        link("/services/botox", "Botox"),
        link("/services", "Services"),
        link("/pricing", "Pricing"),
        link("/blog/why-botox", "Why Botox"),
        link("/privacy-policy"),
        link("/privacy", "Privacy"),
        link("/gallery", "Gallery"),
        link("/menu.pdf", "Menu PDF"),
        link("https://book.glowmedspa.com/services", "Book"),
        link("https://glowmedspa.com/", "Home"),
      ],
      home,
      7,
    );
    expect(picked.map((u) => u.pathname)).toEqual([
      "/services",
      "/pricing",
      "/meet-the-team",
      "/contact",
      "/faq",
      "/about-us",
      "/services/botox",
    ]);
  });

  test("never more than asked, and never a page with no kind", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      link(`/services/treatment-${i}`, "Treatment"),
    );
    expect(pickPages(many, home, 7)).toHaveLength(7);
    expect(pickPages([link("/gallery"), link("/shop-gift-cards")], home, 7)).toEqual([]);
  });

  test("the same page twice is read once", () => {
    const picked = pickPages(
      [link("/services"), link("/services/"), link("https://glowmedspa.com/services")],
      home,
      7,
    );
    expect(picked).toHaveLength(1);
  });
});

test("www and the bare name are one site; a subdomain is not", () => {
  expect(sameSite("www.glow.com", "glow.com")).toBe(true);
  expect(sameSite("GLOW.com.", "www.glow.com")).toBe(true);
  expect(sameSite("book.glow.com", "glow.com")).toBe(false);
});

describe("pageTexts", () => {
  test("drops the repeated navigation from later pages but never a line with a digit", () => {
    const shell = (body: string) =>
      `<nav><p>Home</p><p>Book now</p></nav>${body}<footer><p>Call (512) 555-0100</p></footer>`;
    const texts = pageTexts([
      { url: "https://glow.com/", html: shell("<p>Welcome</p>") },
      {
        url: "https://glow.com/pricing",
        html: shell("<p>Hydrafacial</p><p>$199</p><p>Dermaplaning</p><p>$199</p>"),
      },
    ]);
    expect(texts[0]!.text).toBe("Home\nBook now\nWelcome\nCall (512) 555-0100");
    expect(texts[1]!.text).toBe("Hydrafacial\n$199\nDermaplaning\n$199\nCall (512) 555-0100");
  });

  test("keeps within the per-page and total limits, home page first", () => {
    const long = `<p>${"word ".repeat(10_000)}</p>`;
    const texts = pageTexts(
      Array.from({ length: 8 }, (_, i) => ({
        url: `https://glow.com/${i}`,
        html: `<p>page ${i}</p>${long}`,
      })),
    );
    expect(texts[0]!.url).toBe("https://glow.com/0");
    for (const page of texts) expect(page.text.length).toBeLessThanOrEqual(TEXT_LIMITS.perPage);
    expect(texts.reduce((sum, page) => sum + page.text.length, 0)).toBeLessThanOrEqual(
      TEXT_LIMITS.total,
    );
  });
});
