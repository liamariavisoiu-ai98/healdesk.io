import { describe, expect, it } from "vitest";

import { normalizeProfile } from "@/lib/demo/profile";

import { DEMO_PAGE_CALLBACK_CONSENT, usMobileE164 } from "./callback";
import { renderDemoV2 } from "./render";
import { CHAT_SLOT_ID, VOICE_SLOT_ID } from "./slots";

const PROFILE = normalizeProfile(
  {
    clinic_name: "Glow <Med> Spa",
    summary: "Injectables and facials in Austin.",
    specialty: "med_spa",
    phone: "(737) 555-0199",
    address: "1 Congress Ave, Austin, TX",
    hours: [{ days: "Mon–Fri", hours: "9am–6pm" }],
    services: [{ name: "Botox", description: "", price: "$12 per unit", duration: "30 min" }],
    providers: [],
    faqs: [],
    policies: [],
    booking: "",
    highlights: [],
  },
  "Glow <Med> Spa",
);

function render(percentOff = 50) {
  return renderDemoV2({
    slug: "glow-med-spa-ab12",
    url: "https://healdesk.io/demo/glow-med-spa-ab12",
    profile: PROFILE,
    name: "Glow <Med> Spa",
    logoUrl: null,
    leadEmail: "owner@glow.example",
    percentOff,
    offerEndsAt: new Date("2026-11-01T12:00:00Z"),
    ayaImage: "/aya.png",
  });
}

function data(script: string): Record<string, unknown> {
  const json = script.slice("window.__HD_DEMO__ = ".length, script.indexOf(";\n"));
  return JSON.parse(json) as Record<string, unknown>;
}

describe("the owner's demo page, filled for one clinic", () => {
  it("leaves nothing of the sample clinic", () => {
    const { body, script } = render();
    for (const sample of ["Lumen", "LUMEN", "lumen", "elena@", "(512) 555-0100"]) {
      expect(body, sample).not.toContain(sample);
      expect(script, sample).not.toContain(sample);
    }
  });

  it("prints the clinic's own name, escaped, and its own number", () => {
    const { body } = render();
    expect(body).toContain("Glow &lt;Med&gt; Spa");
    expect(body).not.toContain("<Med>");
    expect(body).toContain("(737) 555-0199");
    expect(body).toContain("healdesk.io/demo/glow-med-spa-ab12");
  });

  it("swaps the stand-in voice and chat for the real cards' slots", () => {
    const { body, script } = render();
    expect(body).toContain(`id="${VOICE_SLOT_ID}"`);
    expect(body).toContain(`id="${CHAT_SLOT_ID}"`);
    expect(body).not.toContain('class="vseg-wrap"');
    expect(body).not.toContain('class="chtabs"');
    expect(script).not.toContain("scripted placeholder for Retell");
  });

  it("prints the demo's own discount, and checkout's setup prices for it", () => {
    const thirty = render(30);
    expect(thirty.body).not.toContain("50%");
    expect(thirty.body).toContain("30%");
    const { setup, setupAfter, offerEndsAt } = data(thirty.script) as {
      setup: Record<string, number>;
      setupAfter: Record<string, number>;
      offerEndsAt: number;
    };
    expect(setup).toMatchObject({ voice: 697, web: 259, meta: 697, "voice+web": 956 });
    expect(setupAfter).toMatchObject({ voice: 488, web: 182, "voice+web": 670 });
    expect(offerEndsAt).toBe(Date.parse("2026-11-01T12:00:00Z"));
  });

  it("sends Pay, the Meta waitlist and the call back to this demo's routes", () => {
    const { script } = render();
    const hd = data(script);
    expect(hd).toMatchObject({
      onboard: "/demo/glow-med-spa-ab12/onboard",
      events: "/api/demo/glow-med-spa-ab12/event",
      callback: "/api/demo/glow-med-spa-ab12/callback",
    });
    expect(script).toContain('HD.onboard + "?from=checkout&plan="');
    expect(script).toContain('name:"metachat_vip"');
    expect(script).toContain("fetch(HD.callback");
  });

  it("says above the two cards what the demo made up, and what it still could not find", () => {
    // Owner, 1 November 2026: invent what the website did not show, "with a visible disclaimer".
    const { body } = render();
    const note = body.indexOf('class="hd-note"');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(body.indexOf('class="demo-grid"'));
    expect(body).toContain("Made up for this demo");
    expect(body).toContain("we invented these for this demo only");
    expect(body).toContain("<li>The free times Aya offers: a demo isn&#39;t connected to your calendar</li>");
    expect(body).toContain("<li>A $50 deposit and its payment link, and a 24-hour cancellation rule</li>");
    // This profile lists no team: never made up, so it is listed as still not found.
    expect(body).toContain("Still not found, so Aya won't say them");
    expect(body).toContain("<li>Your team</li>");
  });

  it("cannot close its own script tag with the clinic's data", () => {
    const { script } = render();
    expect(script.slice(0, script.indexOf(";\n"))).not.toContain("</");
  });
});

describe("the page's call back form", () => {
  it("takes a ten-digit US number, with or without its 1", () => {
    expect(usMobileE164("(737) 555-0199")).toBe("+17375550199");
    expect(usMobileE164("1 737 555 0199")).toBe("+17375550199");
    expect(usMobileE164("555-0199")).toBeNull();
    expect(usMobileE164(7375550199)).toBeNull();
  });

  it("keeps what the visitor said yes to, versioned", () => {
    expect(DEMO_PAGE_CALLBACK_CONSENT.version).toMatch(/^demo-page-callback-\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(DEMO_PAGE_CALLBACK_CONSENT.text.length).toBeGreaterThan(20);
  });
});
