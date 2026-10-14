import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { UrgentScreen } from "@/app/c/[slug]/setup/screens/BehaviourScreens";

/**
 * Wizard 2.5, the urgent-help screen, in each practice's own words: a
 * veterinary practice is told what its urgent reply really says (the
 * emergency referral clinic, never 911), and every other practice what its
 * reply says (911, then the number below). No database.
 */

const COMMON = {
  slug: "paws",
  backHref: null,
  skipCost: "AYA gives your main number.",
  urgentHelp: "",
  urgentPlaceholder: "(415) 555-0123",
  urgentHint: "Leave it empty and AYA gives your direct line.",
  vetReferral: "",
  address: null,
};

function render(vet: boolean): string {
  return renderToStaticMarkup(
    createElement(UrgentScreen, { ...COMMON, vet, audience: vet ? "clients" : "patients" }),
  ).replace(/&#x27;|&rsquo;|’/g, "'");
}

describe("the urgent-help screen", () => {
  test("a veterinary practice is told its clients get the emergency referral clinic, not 911", () => {
    const html = render(true);
    expect(html).toContain("When a client reports an emergency with their animal");
    expect(html).toContain("your emergency referral clinic, and your own number while you're open");
    expect(html).not.toMatch(/\b911\b/);
    expect(html).not.toMatch(/\bpatients?\b/);
  });

  test("every other practice is told about 911 and the number it gives", () => {
    const html = render(false);
    expect(html).toContain("tells them to call 911");
    expect(html).not.toContain("emergency referral clinic");
  });
});
