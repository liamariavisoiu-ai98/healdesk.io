import { describe, expect, it } from "vitest";

import { chatGreeting } from "./clinic-prompts";
import { greetingLead } from "./greeting";

describe("the chat greeting", () => {
  it("opens, in the demo and in the homepage preview, by saying it is an AI assistant and naming the clinic", () => {
    expect(greetingLead("Peachy Studio")).toContain("Peachy Studio's AI assistant");
  });

  it("is the preview's line with the demo's notice after it, so the two cannot drift", () => {
    expect(chatGreeting("Peachy Studio")).toBe(`${greetingLead("Peachy Studio")} This is a demo, so please don't share real patient details.`);
  });
});
