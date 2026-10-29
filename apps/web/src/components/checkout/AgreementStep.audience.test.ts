import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { AgreementStep } from "./AgreementStep";

/**
 * The agreement step a veterinary practice reaches once the Data Protection
 * Agreement is released (20 October 2026): its "Inbound only" box says
 * clients, never patients, because a vet's patients are animals and the
 * people who call are their owners. The release is stood in for here, as
 * agreementKindFor's `dpaReleased` lets a test do; on main the DPA's own flag
 * decides (agreement-kind.ts), and until it is set a vet is offered no
 * agreement at all.
 */
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    agreementKindFor: (input: Parameters<typeof actual.agreementKindFor>[0]) =>
      actual.agreementKindFor({ ...input, dpaReleased: true }),
  };
});

const noop = () => undefined;

function said(specialty: "veterinary" | "med-spa"): string {
  return renderToStaticMarkup(
    h(AgreementStep, {
      step: 3,
      totalSteps: 4,
      onBack: noop,
      clinicName: "Paws & Claws LLC",
      specialty,
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
      covered: specialty === "veterinary" ? null : "yes",
      onCovered: noop,
      contactName: "Dana Vet",
      contactTitle: "Owner",
      contactEmail: "info@pawsandclaws.test",
      onContact: noop,
      signed: null,
      onSigned: noop,
      onContinue: noop,
      onResign: noop,
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function inboundBox(words: string): string {
  const start = words.indexOf("Inbound only");
  expect(start, words).toBeGreaterThanOrEqual(0);
  return words.slice(start, words.indexOf("consent warranty", start));
}

describe("the Inbound only box, in the practice's own word", () => {
  test("a vet's says clients, and never patients", () => {
    const box = inboundBox(said("veterinary"));
    expect(box).toContain("It never calls your clients or texts them first");
    expect(box).toContain("every conversation it has is one a client started");
    expect(box).not.toMatch(/\bpatients?\b/i);
  });

  test("a practice whose patients are people still says patients", () => {
    const box = inboundBox(said("med-spa"));
    expect(box).toContain("It never calls your patients or texts them first");
    expect(box).toContain("every conversation it has is one a patient started");
  });
});
