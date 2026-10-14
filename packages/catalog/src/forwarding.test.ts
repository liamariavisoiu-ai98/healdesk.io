import { describe, expect, test } from "vitest";

import { COVERAGE_MODES } from "./assistant-settings";
import { CARRIERS, coverageForForwarding, forwardingInstructions } from "./forwarding";

/**
 * Forwarding for each of the spec's three coverage modes. After hours only
 * forwards every call while the clinic is closed, so on a landline it is
 * all-call forwarding switched on at closing and off at opening, and its undo
 * is all-call forwarding's: *73, never the busy and no-answer pair (*91 and
 * *93), which would leave the line forwarded.
 */

const AYA = "+14155550100";

const dials = (steps: { dial: string }[]) => steps.map((s) => s.dial);

describe("forwarding for each coverage mode", () => {
  test("All calls forwards everything and undoes with *73", () => {
    const f = forwardingInstructions({
      carrier: "verizon",
      phoneSystemType: "landline",
      routing: "all_calls",
      destinationE164: AYA,
    });
    expect(dials(f.steps)).toEqual(["*724155550100"]);
    expect(dials(f.undo)).toEqual(["*73"]);
  });

  test("Overflow and after hours forwards on busy and no answer, never *72", () => {
    const f = forwardingInstructions({
      carrier: "verizon",
      phoneSystemType: "landline",
      routing: "overflow_after_hours",
      destinationE164: AYA,
    });
    expect(dials(f.steps)).toEqual(["*904155550100", "*924155550100"]);
    expect(dials(f.undo)).toEqual(["*91", "*93"]);
    expect(JSON.stringify(f)).not.toContain("*72");
  });

  test("After hours only switches all-call forwarding on at closing and off at opening, and undoes with *73", () => {
    const f = forwardingInstructions({
      carrier: "att",
      phoneSystemType: "landline",
      routing: "after_hours_only",
      destinationE164: AYA,
    });
    expect(dials(f.steps)).toEqual(["*724155550100", "*73"]);
    expect(f.steps[0]!.label).toMatch(/when you close/);
    expect(f.steps[1]!.label).toMatch(/when you open/);
    expect(dials(f.undo)).toEqual(["*73"]);
    expect(JSON.stringify(f)).not.toMatch(/\*9[0-3]/);
    expect(f.notes.join(" ")).toMatch(/two codes a day/);
    expect(f.needsCarrierHelp).toBe(false);
  });

  test("on T-Mobile, After hours only uses the GSM all-call codes", () => {
    const f = forwardingInstructions({
      carrier: "tmobile",
      phoneSystemType: "landline",
      routing: "after_hours_only",
      destinationE164: AYA,
    });
    expect(dials(f.steps)).toEqual(["**21*4155550100#", "##21#"]);
    expect(dials(f.undo)).toEqual(["##21#"]);
  });

  test("every carrier we have codes for undoes After hours only with its all-call code, the same one as All calls", () => {
    for (const { id } of CARRIERS.filter((c) => c.id !== "other")) {
      const args = { carrier: id, phoneSystemType: "landline" as const, destinationE164: AYA };
      const afterHours = forwardingInstructions({ ...args, routing: "after_hours_only" });
      const allCalls = forwardingInstructions({ ...args, routing: "all_calls" });
      expect(afterHours.undo, id).toEqual(allCalls.undo);
    }
  });

  test("an unknown carrier refuses to guess, and names only *73 for After hours only", () => {
    const f = forwardingInstructions({
      carrier: null,
      phoneSystemType: "landline",
      routing: "after_hours_only",
      destinationE164: AYA,
    });
    expect(f.needsCarrierHelp).toBe(true);
    expect(f.steps[0]!.label).toMatch(/while you're closed/);
    expect(f.undo[0]!.label).toMatch(/\*73/);
    expect(f.undo[0]!.label).not.toMatch(/\*91|\*93/);
  });

  test("a cloud phone system gets a business-hours rule for After hours only", () => {
    const f = forwardingInstructions({
      carrier: "other",
      phoneSystemType: "voip",
      routing: "after_hours_only",
      destinationE164: AYA,
    });
    expect(f.steps[0]!.label).toMatch(/business-hours rule/);
    expect(f.undo[0]!.label).toMatch(/after-hours rule/);
    expect(JSON.stringify(f)).not.toMatch(/\*7|\*9/);
  });

  test("the older call routing reads as the mode it means, word for word", () => {
    expect(coverageForForwarding("always")).toBe("all_calls");
    expect(coverageForForwarding("conditional")).toBe("overflow_after_hours");
    for (const mode of COVERAGE_MODES) expect(coverageForForwarding(mode)).toBe(mode);
    const args = {
      carrier: "comcast" as const,
      phoneSystemType: "landline" as const,
      destinationE164: AYA,
    };
    expect(forwardingInstructions({ ...args, routing: "always" })).toEqual(
      forwardingInstructions({ ...args, routing: "all_calls" }),
    );
    expect(forwardingInstructions({ ...args, routing: "conditional" })).toEqual(
      forwardingInstructions({ ...args, routing: "overflow_after_hours" }),
    );
  });
});
