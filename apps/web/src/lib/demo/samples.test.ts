import { describe, expect, it } from "vitest";

import { BENCHMARKS, benchmarkFor, CONSULTATION_PRICE, priceFigure } from "./benchmarks";
import { demoGaps } from "./gaps";
import { normalizeProfile } from "./profile";
import {
  applyDemoFill,
  checkDemoFill,
  DEMO_SAMPLES,
  fillDemo,
  fillFingerprint,
  liveDemo,
  SAMPLE_DEPOSIT_POLICY,
  sampledForCall,
  withDemoSamples,
  type DemoFill,
} from "./samples";
import { demoNoteHtml } from "./v2/render";

/**
 * What a live demo makes up when the website did not show it (owner,
 * 1 November 2026), what it never makes up, and the stored fill every
 * surface reads.
 */
const profile = (raw: Record<string, unknown>) => normalizeProfile({ clinic_name: "Glow Med Spa", ...raw }, "Glow Med Spa");
const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("a demo's made-up values", () => {
  it("prices every treatment the site listed without one from the benchmarks, and keeps the ones it priced", () => {
    const { profile: p, invented } = withDemoSamples(profile({ services: [{ name: "Botox", price: "$12/unit" }, { name: "Lip Filler", price: null }, { name: "HydraFacial" }, { name: "Mystery Glow" }] }));
    expect(p.services.map((s) => [s.name, s.price])).toEqual([["Botox", "$12/unit"], ["Lip Filler", "$712/syringe"], ["HydraFacial", "$199"], ["Mystery Glow", CONSULTATION_PRICE]]);
    expect(invented).toContain("prices");
  });

  it("gives a treatment no benchmark covers no price at all, and lists no made-up prices for it", () => {
    const fill = fillDemo(profile({ services: [{ name: "Mystery Glow" }], hours: [{ days: "Mon", hours: "9-5" }], policies: ["24-hour cancellation."] }), NOW);
    expect(fill.items).toEqual([{ kind: "calendar", basis: "sample" }, { kind: "price", basis: "consultation", index: 0, service: "Mystery Glow", value: CONSULTATION_PRICE, benchmark: null }]);
    expect(liveDemo(profile({ services: [{ name: "Mystery Glow" }] }), null).invented).not.toContain("prices");
    expect(sampledForCall(fill).prices).toEqual([]);
  });

  it("makes up a menu, hours and a deposit rule when none was found, and always the calendar", () => {
    const { profile: p, invented } = withDemoSamples(profile({}));
    expect(p.services.length).toBeGreaterThan(2);
    expect(p.hours).toEqual([{ days: "Mon-Fri", hours: "9am-6pm" }]);
    expect(p.policies).toContain(SAMPLE_DEPOSIT_POLICY);
    expect(invented).toEqual(["calendar", "menu", "hours", "deposit"]);
    // With it all filled in, the demo knows them.
    expect(demoGaps(p)).not.toEqual(expect.arrayContaining(["treatments", "prices", "hours", "policy"]));
  });

  it("never makes up the address, the phone number or the team, and changes nothing the site showed", () => {
    const full = profile({
      services: [{ name: "Botox", price: "$12/unit" }],
      hours: [{ days: "Mon-Sat", hours: "10am-7pm" }],
      policies: ["48-hour cancellation policy."],
    });
    const { profile: p, invented } = withDemoSamples(full);
    expect(invented).toEqual(["calendar"]);
    expect(p).toEqual(full);
    const bare = withDemoSamples(profile({})).profile;
    expect([bare.address, bare.phone, bare.providers]).toEqual([null, null, []]);
  });

  it("gives a dental practice a dental menu, priced from the benchmarks", () => {
    const { profile: p } = withDemoSamples(profile({ specialty: "dental" }));
    expect(p.services.map((s) => [s.name, s.price])).toContainEqual(["Teeth whitening", "$583"]);
  });

  it("tells the voice call exactly which values are samples", () => {
    const fill = fillDemo(profile({ services: [{ name: "Botox" }, { name: "Mystery Glow" }, { name: "Peel", price: "$150" }] }), NOW);
    expect(sampledForCall(fill)).toEqual({ prices: ["Botox"], menu: false, hours: true, deposit: true });
  });
});

describe("the stored fill", () => {
  const p = profile({ services: [{ name: "Microneedling" }] });

  it("is what every surface reads when it was made for this profile", () => {
    const stored = fillDemo(p, NOW);
    const item = stored.items.find((i) => i.kind === "price")!;
    if (item.kind === "price") item.value = "$700";
    const live = liveDemo(p, JSON.parse(JSON.stringify(stored)));
    expect(live.profile.services[0]!.price).toBe("$700");
    // The page's note reads the same fill.
    expect(demoNoteHtml(p, stored)).toContain("Typical prices for the treatments we found without one");
  });

  it("is worked out afresh for an old row with none, or for a profile it was not made for", () => {
    expect(liveDemo(p, null).profile.services[0]!.price).toBe("$938");
    const other = fillDemo(profile({ services: [{ name: "Botox" }] }), NOW);
    expect(liveDemo(p, other).profile.services[0]!.price).toBe("$938");
    expect(liveDemo(p, { nonsense: true }).profile.services[0]!.price).toBe("$938");
  });

  it("lists exactly the stored items in the page's note, and a price left at consultation as still missing", () => {
    const html = demoNoteHtml(profile({ services: [{ name: "Mystery Glow" }], hours: [{ days: "Mon", hours: "9-5" }], policies: ["24-hour cancellation."] }));
    expect(html).toContain("The free times Aya offers");
    expect(html).not.toContain("Typical prices");
    expect(html).toContain("Your prices");
  });

  it("hashes the same after the round trip through the Sheet", () => {
    const back = normalizeProfile(JSON.parse(JSON.stringify(p)) as Record<string, unknown>, "Glow Med Spa");
    expect(fillFingerprint(back)).toBe(fillFingerprint(p));
  });

  it("applies to the profile without changing what the website said", () => {
    const fill = fillDemo(p, NOW);
    applyDemoFill(p, fill);
    expect(p.services[0]!.price).toBeNull();
  });
});

describe("the fill's check", () => {
  const p = profile({ services: [{ name: "Botox" }, { name: "Mystery Glow" }] });
  const clone = (fill: DemoFill): DemoFill => JSON.parse(JSON.stringify(fill)) as DemoFill;

  it("passes the fill the build works out, for every kind of practice", () => {
    expect(checkDemoFill(p, fillDemo(p, NOW))).toEqual([]);
    for (const specialty of ["dental", "veterinary", "massage-chiro", "glp1", "hair-restoration", "med-spa", null]) {
      const bare = profile({ specialty });
      expect(checkDemoFill(bare, fillDemo(bare, NOW))).toEqual([]);
    }
  });

  it("fails a benchmark price outside its range", () => {
    const fill = clone(fillDemo(p, NOW));
    const item = fill.items.find((i) => i.kind === "price" && i.basis === "benchmark")!;
    if (item.kind === "price") item.value = "$90/unit";
    expect(checkDemoFill(p, fill)).toEqual([expect.stringMatching(/outside the benchmark range for neurotoxin/)]);
  });

  it("fails an item the note does not list, and a fill made for another profile", () => {
    const fill = clone(fillDemo(p, NOW));
    fill.items.push({ kind: "parking", basis: "sample" } as never);
    expect(checkDemoFill(p, fill)).toEqual([expect.stringMatching(/"parking" is not one the demo's note lists/)]);
    expect(checkDemoFill(profile({ services: [{ name: "Botox" }] }), fillDemo(p, NOW))).toContainEqual(expect.stringMatching(/different profile/));
  });

  it("fails a sample that fills what the website showed", () => {
    const shown = profile({ services: [{ name: "Botox", price: "$12/unit" }], hours: [{ days: "Mon", hours: "9-5" }], policies: ["No-show fee."] });
    const fill = clone(fillDemo(shown, NOW));
    fill.items.push({ kind: "hours", basis: "sample", value: [{ days: "Mon-Fri", hours: "9am-6pm" }] }, { kind: "deposit", basis: "sample", value: SAMPLE_DEPOSIT_POLICY });
    expect(checkDemoFill(shown, fill)).toEqual([expect.stringMatching(/hours were found/), expect.stringMatching(/policy was found/)]);
  });
});

describe("the benchmark table", () => {
  it("prints every price in a form the menu reads, inside its own range, with a source and a date or a null for the owner", () => {
    const ids = new Set<string>();
    for (const b of BENCHMARKS) {
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
      const figure = priceFigure(b.price);
      expect(figure, b.id).not.toBeNull();
      expect(figure! >= b.range[0] && figure! <= b.range[1], b.id).toBe(true);
      if (b.source === null) expect(b.checked).toBeNull();
      else {
        expect(b.source).toMatch(/^https:\/\//);
        expect(b.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("classifies by the specialty where it matters", () => {
    expect(benchmarkFor("Wellness exam", "veterinary")?.id).toBe("vet-wellness");
    expect(benchmarkFor("Wellness exam", "med-spa")).toBeNull();
    expect(benchmarkFor("Laser hair removal", null)?.id).toBe("laser-hair-removal");
    expect(benchmarkFor("Dysport", null)).toBeNull();
  });

  it("lists only kinds the note knows", () => {
    expect(DEMO_SAMPLES).toEqual(["calendar", "prices", "menu", "hours", "deposit"]);
  });
});
