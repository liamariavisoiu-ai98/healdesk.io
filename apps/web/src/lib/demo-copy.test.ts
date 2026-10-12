import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The demo must not describe a product that does not exist.
 *
 * docs/v1-product-spec.md is what v1 does. Sentences the prompt and the
 * knowledge tree used to carry — that the agent "texts a confirmation", that it
 * "calls back missed numbers automatically", that it reads revenue back out of
 * a point-of-sale — described things v1 deliberately does not do: it is
 * inbound only, has no SMS, and attribution is phase two. A prospect who heard
 * any of them from the demo would have bought something the product cannot
 * deliver.
 *
 * Two sentences used to sit behind build-time flags (NEXT_PUBLIC_CALLBACKS_LIVE,
 * NEXT_PUBLIC_DIRECT_BOOKING_LIVE). The spec settled both: no call-backs in
 * v1, and booking straight into the clinic's Google Calendar is the product.
 * The last test pins that setting either variable no longer changes a word.
 * The modules are loaded fresh for each case, because anything read at module
 * scope would otherwise carry whatever the environment was on first import.
 */

const CALLBACK_SENTENCE = "With the caller's spoken permission it can ring back to settle a time";
const DIRECT_BOOKING_ADDENDUM =
  "Clinics that accept the direct booking addendum let the phone assistant book straight in";

async function loadCopy(flags: { callbacks?: string; directBooking?: string } = {}) {
  vi.resetModules();
  if (flags.callbacks !== undefined) vi.stubEnv("NEXT_PUBLIC_CALLBACKS_LIVE", flags.callbacks);
  if (flags.directBooking !== undefined) {
    vi.stubEnv("NEXT_PUBLIC_DIRECT_BOOKING_LIVE", flags.directBooking);
  }
  const [{ buildSystemPrompt }, { ROOT_KNOWLEDGE }, { DEMO_AGENT }] = await Promise.all([
    import("./demo-prompt"),
    import("./knowledge"),
    import("./demo-agent"),
  ]);
  return {
    prompt: buildSystemPrompt("Med spa", "context") + "\n" + buildSystemPrompt(null, "context"),
    knowledge: ROOT_KNOWLEDGE,
    agent: DEMO_AGENT,
  };
}

// The first import of these modules also transforms them: 0.7s on a quiet
// machine, and past the 5s test timeout on a loaded one, where it failed the
// first two cases for time rather than for anything they check. It is paid
// once here, as setup with its own budget; each case's fresh load then only
// re-runs modules that are already transformed.
beforeAll(async () => {
  await loadCopy();
}, 30_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the demo describes v1 as the spec defines it", () => {
  test("neither the prompt nor the knowledge tree promises texts or call-backs", async () => {
    const { prompt, knowledge } = await loadCopy();
    for (const text of [prompt, knowledge]) {
      expect(text).not.toContain("texts a confirmation");
      expect(text).not.toContain("calls back missed numbers automatically");
      expect(text).not.toContain(CALLBACK_SENTENCE);
      expect(text).not.toMatch(/calls? (you|them) back within/i);
    }
    // The positive claims, so a later edit cannot quietly drop them and leave
    // the demo saying nothing about what it does not do.
    expect(prompt).toContain("It never texts patients");
    expect(prompt).toContain("It is inbound only.");
    expect(knowledge).toContain("It sends no texts.");
    expect(knowledge).toContain("It never contacts a patient first");
  });

  test("both say she books straight into the clinic's Google Calendar", async () => {
    const { prompt, knowledge } = await loadCopy();
    expect(prompt).toContain(
      "It checks live availability in the clinic's Google Calendar and books the appointment during the conversation.",
    );
    expect(prompt).toContain("Auto-confirm is on by default");
    expect(knowledge).toContain("Google Calendar is the only thing it writes to.");
    for (const text of [prompt, knowledge]) {
      expect(text).not.toContain(DIRECT_BOOKING_ADDENDUM);
      expect(text).not.toContain("hands each to the clinic's front desk to confirm");
    }
  });

  test("the demo offers two or three times, as the product's call flow does", async () => {
    const { prompt } = await loadCopy();
    expect(prompt).toContain("offer two or three specific times, never a long list");
  });

  test("no revenue attribution: that is phase two", async () => {
    const { prompt, knowledge } = await loadCopy();
    for (const text of [prompt, knowledge]) {
      expect(text).not.toMatch(/point-of-sale|closes the loop on revenue|collected revenue/i);
      expect(text).toMatch(/booked value/);
    }
  });

  test("setting the old flags changes nothing", async () => {
    const unset = await loadCopy();
    const set = await loadCopy({ callbacks: "true", directBooking: "true" });
    expect(set.prompt).toBe(unset.prompt);
    expect(set.knowledge).toBe(unset.knowledge);
  });
});

describe("the demo opens the way the product must", () => {
  test("the chat greeting says she is an AI assistant", async () => {
    const { agent } = await loadCopy();
    expect(agent.greeting).toMatch(/AI assistant/);
  });
});
