import { describe, expect, it } from "vitest";

import { demoGaps } from "./gaps";
import { normalizeProfile } from "./profile";
import { SAMPLE_DEPOSIT_POLICY, withDemoSamples } from "./samples";

/**
 * What a live demo makes up when the website did not show it (owner,
 * 1 November 2026), and what it never makes up.
 */
const profile = (raw: Record<string, unknown>) => normalizeProfile({ clinic_name: "Glow Med Spa", ...raw }, "Glow Med Spa");

describe("a demo's made-up values", () => {
  it("prices every treatment the site listed without one, and keeps the ones it priced", () => {
    const { profile: p, invented } = withDemoSamples(profile({ services: [{ name: "Botox", price: "$12/unit" }, { name: "Lip Filler", price: null }, { name: "HydraFacial" }, { name: "Mystery Glow" }] }));
    expect(p.services.map((s) => [s.name, s.price])).toEqual([["Botox", "$12/unit"], ["Lip Filler", "from $650"], ["HydraFacial", "$199"], ["Mystery Glow", "from $150"]]);
    expect(invented).toContain("prices");
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

  it("gives a dental practice a dental menu", () => {
    const { profile: p } = withDemoSamples(profile({ specialty: "dental" }));
    expect(p.services.map((s) => s.name)).toContain("Teeth whitening");
  });
});
