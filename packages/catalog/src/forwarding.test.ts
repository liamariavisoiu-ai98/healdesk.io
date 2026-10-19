import { describe, expect, test } from "vitest";

import { COVERAGE_MODES, type CoverageModeId } from "./assistant-settings";
import {
  CARRIER_SERVICE_NUMBERS,
  CARRIERS,
  coverageForForwarding,
  forwardingInstructions,
  type Carrier,
} from "./forwarding";

/**
 * Forwarding for each of the spec's three coverage modes, with every code as
 * the carrier's own page gave it on 19 October 2026 (the sources are named
 * beside each carrier in forwarding.ts, and the published guide cites them).
 * Until then every landline carrier got *90{n} and *92{n}, which forward
 * nothing on Verizon (its *90 and *92 go to a number the Business Office
 * fixes), miss AT&T Phone's #, and are not Spectrum's or Xfinity's codes, so
 * the table below pins each one.
 *
 * After hours only forwards every call while the clinic is closed, so on a
 * landline it is all-call forwarding switched on at closing and off at
 * opening, and its undo is all-call forwarding's, never the busy and
 * no-answer codes, which would leave the line forwarded.
 *
 * Every path's steps end with what the emails must print although there is
 * nothing to dial: the warning about a machine or greeting answering first
 * (Overflow and after hours) and the test call. PINNED holds the carrier's
 * own steps; TAIL is what follows them in each mode.
 */

const AYA = "+14155550100";

const dials = (steps: { dial: string }[]) => steps.map((s) => s.dial);
const forward = (carrier: Carrier | null, routing: CoverageModeId, phoneSystemType: "landline" | "voip" | "unknown" = "landline") =>
  forwardingInstructions({ carrier, phoneSystemType, routing, destinationE164: AYA });

/** The steps after the carrier's own in each mode, none of them a code. */
const TAIL: Record<CoverageModeId, string[]> = {
  all_calls: [""],
  overflow_after_hours: ["", ""],
  after_hours_only: [""],
};

/** Every carrier we have codes for, each mode, what it dials and what undoes it. */
const PINNED: Record<Exclude<Carrier, "other">, Record<CoverageModeId, { steps: string[]; undo: string[] }>> = {
  verizon: {
    all_calls: { steps: ["*724155550100"], undo: ["*73"] },
    overflow_after_hours: { steps: ["*424155550100", "*714155550100"], undo: ["*43", "", "*73"] },
    after_hours_only: { steps: ["*724155550100", "*73"], undo: ["*73"] },
  },
  att: {
    all_calls: { steps: ["*724155550100#", "*724155550100", AYA], undo: ["*73#", "*73", "#21#"] },
    overflow_after_hours: {
      steps: ["*904155550100#", "*924155550100#", "*3724155550100#", AYA, AYA],
      undo: ["*91#", "*93#", "*373#", "", "", ""],
    },
    after_hours_only: {
      steps: ["*724155550100#", "*73#", "*724155550100", "*73", AYA, "#21#"],
      undo: ["*73#", "*73", "#21#"],
    },
  },
  tmobile: {
    all_calls: { steps: ["**21*14155550100#"], undo: ["##21#"] },
    overflow_after_hours: {
      steps: ["**67*14155550100#", "**61*14155550100#", "**62*14155550100#"],
      undo: ["##004#", "##67#", "##61#", "##62#"],
    },
    after_hours_only: { steps: ["**21*14155550100#", "##21#"], undo: ["##21#"] },
  },
  spectrum: {
    all_calls: { steps: ["*724155550100"], undo: ["*73"] },
    overflow_after_hours: { steps: ["*714155550100", AYA], undo: ["*73", ""] },
    after_hours_only: { steps: ["*724155550100", "*73"], undo: ["*73"] },
  },
  comcast: {
    all_calls: { steps: ["*724155550100"], undo: ["*73"] },
    overflow_after_hours: { steps: ["*904155550100", "*924155550100", AYA], undo: ["*91", "*93", ""] },
    after_hours_only: { steps: ["*724155550100", "*73"], undo: ["*73"] },
  },
};

describe("the codes, carrier by carrier", () => {
  for (const [carrier, modes] of Object.entries(PINNED)) {
    for (const [mode, expected] of Object.entries(modes)) {
      test(`${carrier}, ${mode}`, () => {
        const f = forward(carrier as Carrier, mode as CoverageModeId);
        expect(dials(f.steps)).toEqual([...expected.steps, ...TAIL[mode as CoverageModeId]]);
        expect(dials(f.undo)).toEqual(expected.undo);
        expect(f.needsCarrierHelp).toBe(false);
      });
    }
  }

  test("every carrier we have codes for is pinned above", () => {
    expect(Object.keys(PINNED).sort()).toEqual(
      CARRIERS.filter((c) => c.id !== "other")
        .map((c) => c.id)
        .sort(),
    );
  });
});

describe("Verizon", () => {
  test("busy and no-answer on a home phone uses the code that takes a number, and says its two documents disagree", () => {
    const f = forward("verizon", "overflow_after_hours");
    const [home, mobile] = f.steps;
    expect(home!.label).toMatch(/Verizon home phone/);
    expect(home!.label).toMatch(/star-code page gives \*42/);
    expect(home!.label).toMatch(/User Guide gives \*41/);
    expect(home!.label).toMatch(/test call/);
    expect(mobile!.label).toMatch(/Verizon mobile line/);
    // *90 and *92 forward to a number Verizon's Business Office fixes: never dialled with ours.
    expect(dials(f.steps).join(" ")).not.toMatch(/\*9[0-3]/);
    expect(f.notes.join(" ")).toMatch(/\*90 and \*92 .*Business Office/);
    expect(f.undo.map((u) => u.label)).toEqual([
      "Cancel busy and no-answer forwarding on a Verizon home phone:",
      "If Verizon pointed your home phone's busy and no-answer forwarding at your assistant by service order instead, *43 doesn't undo it: ask Verizon to set it back to where it went before.",
      "Cancel forwarding on a Verizon mobile line:",
    ]);
  });

  test("the mobile *71 is documented for busy and unanswered calls only, so the label says to leave the phone on", () => {
    const mobile = forward("verizon", "overflow_after_hours").steps[1]!;
    expect(mobile.label).toMatch(/not for a phone that is switched off/);
    expect(mobile.label).toMatch(/leave the phone on while you're closed/);
  });

  test("all-call forwarding on a home phone starts once the call Verizon places is answered, and then the clinic hangs up", () => {
    for (const mode of ["all_calls", "after_hours_only"] as const) {
      expect(forward("verizon", mode).steps[0]!.label, mode).toMatch(
        /stay on the line until your assistant answers, which is when forwarding starts, then hang up:$/,
      );
    }
  });

  test("names Verizon's toll restriction, which stops a home phone forwarding to a toll number", () => {
    for (const mode of COVERAGE_MODES) {
      expect(forward("verizon", mode).notes.join(" "), mode).toMatch(/toll-restricted line can't forward to a toll number/);
    }
  });
});

describe("AT&T", () => {
  test("AT&T Phone puts # after the number and after every cancel code", () => {
    for (const mode of COVERAGE_MODES) {
      const f = forward("att", mode);
      for (const step of [...f.steps, ...f.undo].filter((s) => /AT&T Phone/.test(s.label) && s.dial)) {
        expect(step.dial, `${mode}: ${step.label}`).toMatch(/#$/);
      }
    }
  });

  test("a traditional landline says forwarding starts only once the call AT&T places is answered, then to hang up", () => {
    const traditional = forward("att", "all_calls").steps[1]!;
    expect(traditional.label).toMatch(/traditional AT&T landline/);
    expect(traditional.label).toMatch(/forwarding starts only once it's answered/);
    expect(traditional.label).toMatch(/then hang up:$/);
    expect(traditional.dial).toBe("*724155550100");
  });

  test("undoing busy and no-answer forwarding on AT&T Phone says how to bring voicemail back", () => {
    const voicemail = forward("att", "overflow_after_hours").undo.find((s) => /voicemail/.test(s.label))!;
    expect(voicemail.label).toMatch(/^On AT&T Phone, those codes don't bring back AT&T voicemail/);
    expect(voicemail.label).toMatch(/Voicemail Settings/);
    expect(voicemail.label).toMatch(/Forward to Voice Mail/);
    expect(voicemail.dial).toBe("");
  });

  test("a traditional landline's busy and no-answer forwarding is set by calling AT&T, not by a code", () => {
    const f = forward("att", "overflow_after_hours");
    const traditional = f.steps.find((s) => /traditional AT&T landline/.test(s.label))!;
    expect(traditional.label).toMatch(/800\.288\.2020/);
    expect(traditional.dial).toBe(AYA);
    expect(f.undo.find((s) => /traditional AT&T landline/.test(s.label))!.label).toMatch(/800\.288\.2020/);
  });

  test("a mobile line sets forwarding on the phone itself, as AT&T allows only that, and turns it off with #21#", () => {
    for (const mode of COVERAGE_MODES) {
      const f = forward("att", mode);
      const mobile = [...f.steps, ...f.undo].filter((s) => /AT&T mobile line/.test(s.label));
      for (const step of mobile) {
        // AT&T will not change a mobile line's forwarding on request or online.
        expect(step.label, mode).not.toMatch(/ask AT&T/);
        expect(step.dial, mode).toMatch(/^(#21#|\+14155550100|)$/);
      }
      const on = f.steps.filter((s) => /AT&T mobile line/.test(s.label) && s.dial === AYA);
      expect(on, mode).toHaveLength(1);
      expect(on[0]!.label, mode).toMatch(/changed only from the phone itself/);
      expect(on[0]!.label, mode).toMatch(/phone's own call-forwarding settings/);
    }
    expect(forward("att", "all_calls").undo.find((s) => /AT&T mobile line/.test(s.label))!.dial).toBe("#21#");
    expect(forward("att", "after_hours_only").steps.find((s) => /AT&T mobile line, each day when you open/.test(s.label))!.dial).toBe(
      "#21#",
    );
    expect(forward("att", "overflow_after_hours").undo.find((s) => /AT&T mobile line/.test(s.label))!.label).toMatch(
      /phone's own call-forwarding settings/,
    );
  });

  test("every number a label prints is AYA's or a carrier service number the support chat lets through", () => {
    const printed = new Set<string>();
    for (const { id } of CARRIERS) {
      for (const system of ["landline", "voip", "unknown"] as const) {
        for (const mode of COVERAGE_MODES) {
          const f = forward(id, mode, system);
          const text = [...f.steps, ...f.undo].map((s) => s.label).concat(f.notes).join(" ");
          for (const run of text.match(/\d(?:[ .-]?\d){6,}/g) ?? []) printed.add(run.replace(/\D/g, ""));
        }
      }
    }
    const allowed = CARRIER_SERVICE_NUMBERS.map((n) => n.replace(/^\+1/, ""));
    for (const digits of printed) expect(allowed, digits).toContain(digits.slice(-10));
    for (const number of allowed) expect([...printed], number).toContain(number);
  });
});

describe("T-Mobile", () => {
  test("writes the number as 1 and the ten digits, as T-Mobile's page does", () => {
    for (const mode of COVERAGE_MODES) {
      for (const dial of dials(forward("tmobile", mode).steps)) {
        if (dial.startsWith("**")) expect(dial, mode).toContain("*14155550100#");
      }
    }
  });

  test("overflow also forwards when the phone is off or out of range, and ##004# comes first to return it to the default", () => {
    const f = forward("tmobile", "overflow_after_hours");
    expect(f.steps[2]!.label).toMatch(/off or out of signal range/);
    expect(f.steps[0]!.label).toMatch(/dialling out/);
    expect(f.undo[0]).toEqual({
      label: "Return T-Mobile's busy, no-answer and not-reachable forwarding to its default in one code:",
      dial: "##004#",
    });
    for (const alternative of f.undo.slice(1)) expect(alternative.label).toMatch(/^Or cancel .* on its own:$/);
    // ##004# resets conditional forwarding; the all-call undo stays ##21#.
    expect(dials(forward("tmobile", "all_calls").undo)).not.toContain("##004#");
  });
});

describe("Spectrum and Comcast", () => {
  test("Spectrum's busy and no-answer code is *71, and *73 cancels both kinds", () => {
    for (const mode of COVERAGE_MODES) expect(JSON.stringify(forward("spectrum", mode)), mode).not.toMatch(/\*9[0-3]/);
    expect(forward("spectrum", "overflow_after_hours").undo[0]!.label).toMatch(/\*73 turns off both kinds/);
  });

  test("Spectrum's *71 is labelled for Spectrum Voice, and Spectrum Business Voice is told to ask", () => {
    const f = forward("spectrum", "overflow_after_hours");
    expect(f.steps[0]!.label).toMatch(/^On Spectrum Voice \(Spectrum's home phone service\)/);
    expect(f.steps[1]).toEqual({
      label:
        "On Spectrum Business Voice, the Spectrum pages we could open give no code for this: ask Spectrum Business to forward busy and unanswered calls to:",
      dial: AYA,
    });
    expect(f.undo[1]!.label).toMatch(/^On Spectrum Business Voice, ask Spectrum Business/);
  });

  test("the busy and no-answer codes are offered for Comcast Business VoiceEdge and Managed Voice only; Xfinity Voice asks", () => {
    const f = forward("comcast", "overflow_after_hours");
    for (const step of f.steps.filter((s) => /^\*9/.test(s.dial))) {
      expect(step.label).toMatch(/Comcast Business VoiceEdge or Managed Voice/);
    }
    expect(f.steps[0]!.label).toMatch(/call waiting is off/);
    expect(f.steps[2]!.label).toMatch(/Xfinity Voice/);
    expect(f.steps[2]!.label).toMatch(/ask Comcast/);
    // Xfinity's Advanced Call Forwarding rings extra numbers alongside the clinic's phones.
    expect(f.steps[2]!.label).toMatch(/rings at the same time as your phones/);
    expect(f.notes.join(" ")).toMatch(/Unlimited Saver and Local With More/);
  });
});

describe("forwarding for each coverage mode", () => {
  test("Overflow and after hours never shows an all-call code", () => {
    for (const { id } of CARRIERS) {
      expect(JSON.stringify(forward(id, "overflow_after_hours")), id).not.toMatch(/\*72|\*\*21\*/);
    }
  });

  test("After hours only switches all-call forwarding on at closing and off at opening, never the busy and no-answer codes", () => {
    for (const { id } of CARRIERS.filter((c) => c.id !== "other")) {
      const f = forward(id, "after_hours_only");
      expect(f.steps[0]!.label, id).toMatch(/when you close/);
      expect(f.steps[1]!.label, id).toMatch(/when you open/);
      expect(JSON.stringify(f), id).not.toMatch(/\*9[0-3]|\*4[1-3]|\*71|##6[127]#|##004#/);
      expect(f.notes.join(" "), id).toMatch(/two codes a day/);
      expect(f.needsCarrierHelp, id).toBe(false);
    }
  });

  test("every carrier we have codes for undoes After hours only with its all-call code, the same one as All calls", () => {
    for (const { id } of CARRIERS.filter((c) => c.id !== "other")) {
      expect(forward(id, "after_hours_only").undo, id).toEqual(forward(id, "all_calls").undo);
    }
  });

  test("busy and no-answer forwarding warns, in a step the emails print, that a machine or greeting answering first takes the call", () => {
    for (const carrier of [...CARRIERS.map((c) => c.id), null]) {
      for (const system of ["landline", "voip", "unknown"] as const) {
        const at = `${carrier} ${system}`;
        const warning = forward(carrier, "overflow_after_hours", system).steps.at(-2)!;
        expect(warning.label, at).toMatch(/answering machine, a voicemail box or a closed-hours greeting/);
        expect(warning.dial, at).toBe("");
        for (const mode of ["all_calls", "after_hours_only"] as const) {
          expect(JSON.stringify(forward(carrier, mode, system)), `${at} ${mode}`).not.toMatch(/answering machine/);
        }
      }
    }
  });

  test("every path's last step is the test call for its mode, not a note, and no note tells a mobile line not to dial from a cell phone", () => {
    for (const carrier of [...CARRIERS.map((c) => c.id), null]) {
      for (const system of ["landline", "voip", "unknown"] as const) {
        for (const mode of COVERAGE_MODES) {
          const at = `${carrier} ${system} ${mode}`;
          const f = forward(carrier, mode, system);
          expect(f.steps.at(-1)!.label, at).toMatch(/^Then test it/);
          expect(f.steps.at(-1)!.dial, at).toBe("");
          expect(f.notes.join(" "), at).not.toMatch(/test it/);
          expect(f.notes.join(" "), at).not.toMatch(/cell phone/);
        }
      }
    }
    expect(forward("spectrum", "overflow_after_hours").steps.at(-1)!.label).toMatch(/Test once while you're closed too/);
    expect(forward("spectrum", "after_hours_only").steps.at(-1)!.label).toMatch(/on the first evening/);
  });

  test("an unknown carrier refuses to guess, names only *73 for all-call forwarding, and no code for busy and no answer", () => {
    const afterHours = forward(null, "after_hours_only");
    expect(afterHours.needsCarrierHelp).toBe(true);
    expect(afterHours.steps[0]!.label).toMatch(/while you're closed/);
    expect(afterHours.undo[0]!.label).toMatch(/\*73/);
    expect(afterHours.undo[0]!.label).not.toMatch(/\*91|\*93/);
    expect(forward(null, "all_calls").undo).toEqual(afterHours.undo);
    const overflow = forward(null, "overflow_after_hours");
    expect(overflow.undo[0]!.label).toMatch(/^Ask the carrier to remove the forwarding/);
    expect(overflow.undo[0]!.label).not.toMatch(/[*#]\d/);
    expect(overflow.steps[0]!.dial).toBe(AYA);
  });

  test("a cloud phone system gets a rule, never a star code, and is warned about key presses and Google Voice", () => {
    for (const mode of COVERAGE_MODES) {
      const f = forward("other", mode, "voip");
      expect(JSON.stringify(f), mode).not.toMatch(/\*7|\*9/);
      expect(JSON.stringify(f), mode).not.toMatch(/not by star code/);
      expect(f.steps.some((s) => /press a key/.test(s.label)), mode).toBe(true);
      expect(f.notes.join(" "), mode).toMatch(/Google Voice/);
    }
    const afterHours = forward("other", "after_hours_only", "voip");
    expect(afterHours.steps[0]!.label).toMatch(/business-hours rule/);
    expect(afterHours.undo[0]!.label).toMatch(/after-hours rule/);
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

  test("with no destination, as the undo-only callers pass it, the undo steps are unchanged", () => {
    for (const { id } of CARRIERS) {
      for (const mode of COVERAGE_MODES) {
        const blank = forwardingInstructions({ carrier: id, phoneSystemType: "landline", routing: mode, destinationE164: "" });
        expect(blank.undo, `${id} ${mode}`).toEqual(forward(id, mode).undo);
      }
    }
  });
});
