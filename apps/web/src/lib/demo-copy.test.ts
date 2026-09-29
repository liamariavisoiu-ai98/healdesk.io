import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The demo must not describe a product that does not exist.
 *
 * Two sentences the prompt and the knowledge tree used to carry — that the
 * agent "texts a confirmation" and "calls back missed numbers automatically"
 * — described features the product deliberately does not have (no texts, by
 * decision of 21 September 2026; no call the person did not agree to, by the
 * design of 23 September). A prospect who heard either from the demo would
 * have bought something the compliant product cannot deliver.
 *
 * The call-back and direct-booking sentences are the other half: designed,
 * but behind runtime switches on the PHI side that stay off until counsel
 * answers. They may appear only once `NEXT_PUBLIC_CALLBACKS_LIVE` /
 * `NEXT_PUBLIC_DIRECT_BOOKING_LIVE` are set at build time, so the modules are
 * loaded fresh under each environment here: both flags are read at module
 * scope (so Next can inline them), which means a cached import would carry
 * whatever the flags were when the first test touched it.
 */

const CALLBACK_SENTENCE = "With the caller's spoken permission it can ring back to settle a time";
const DIRECT_BOOKING_SENTENCE =
  "Clinics that accept the direct booking addendum let the phone assistant book straight in";

async function loadCopy(flags: { callbacks?: string; directBooking?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CALLBACKS_LIVE", flags.callbacks ?? "");
  vi.stubEnv("NEXT_PUBLIC_DIRECT_BOOKING_LIVE", flags.directBooking ?? "");
  // An empty string is what an unset variable looks like to the flag check.
  if (flags.callbacks === undefined) delete process.env.NEXT_PUBLIC_CALLBACKS_LIVE;
  if (flags.directBooking === undefined) delete process.env.NEXT_PUBLIC_DIRECT_BOOKING_LIVE;
  const [{ buildSystemPrompt }, { ROOT_KNOWLEDGE }] = await Promise.all([
    import("./demo-prompt"),
    import("./knowledge"),
  ]);
  return {
    prompt: buildSystemPrompt("Med spa", "context") + "\n" + buildSystemPrompt(null, "context"),
    knowledge: ROOT_KNOWLEDGE,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the demo describes the product as built", () => {
  test("neither the prompt nor the knowledge tree promises texts or unrequested call-backs", async () => {
    const { prompt, knowledge } = await loadCopy({});
    for (const text of [prompt, knowledge]) {
      expect(text).not.toContain("texts a confirmation");
      expect(text).not.toContain("calls back missed numbers automatically");
    }
    // The positive claim the design gives verbatim, so a later edit cannot
    // quietly drop the desk hand-off and leave the demo saying nothing.
    expect(prompt).toContain("hands each to the clinic's front desk to confirm");
    expect(prompt).toContain("It never texts patients.");
    expect(knowledge).toContain("hands it to the clinic's own front desk");
    expect(knowledge).toContain("It sends no texts.");
  });

  test("the demo asks for a preferred time and backups, as every agent does", async () => {
    const { prompt, knowledge } = await loadCopy({});
    expect(prompt).toContain(
      "When taking a booking, ask for a preferred day or time and one or two backups.",
    );
    expect(prompt).toContain("a preferred time and two back-ups");
    expect(knowledge).toContain("with a preferred time and two back-ups");
  });

  test("call-backs and direct booking are absent while the flags are unset", async () => {
    const { prompt, knowledge } = await loadCopy({});
    for (const text of [prompt, knowledge]) {
      expect(text).not.toContain(CALLBACK_SENTENCE);
      expect(text).not.toContain(DIRECT_BOOKING_SENTENCE);
      expect(text).not.toMatch(/call-?back/i);
      expect(text).not.toMatch(/direct booking/i);
    }
  });

  test("a value other than \"true\" does not switch a sentence on", async () => {
    const { prompt, knowledge } = await loadCopy({ callbacks: "1", directBooking: "yes" });
    for (const text of [prompt, knowledge]) {
      expect(text).not.toContain(CALLBACK_SENTENCE);
      expect(text).not.toContain(DIRECT_BOOKING_SENTENCE);
    }
  });

  test("each flag switches on exactly its own sentence", async () => {
    const callbacksOnly = await loadCopy({ callbacks: "true" });
    for (const text of [callbacksOnly.prompt, callbacksOnly.knowledge]) {
      expect(text).toContain(CALLBACK_SENTENCE);
      expect(text).not.toContain(DIRECT_BOOKING_SENTENCE);
    }

    const directOnly = await loadCopy({ directBooking: "true" });
    for (const text of [directOnly.prompt, directOnly.knowledge]) {
      expect(text).not.toContain(CALLBACK_SENTENCE);
      expect(text).toContain(DIRECT_BOOKING_SENTENCE);
    }
  });
});
