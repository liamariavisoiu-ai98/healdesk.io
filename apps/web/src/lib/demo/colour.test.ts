import { describe, expect, it } from "vitest";

import { readableOn } from "./colour";

/**
 * The title on a clinic's colour has to be readable whatever the clinic
 * chose: the personalised demo's header and the homepage preview's chat
 * widget both put text on it.
 */
describe("readableOn", () => {
  it("puts white on a dark brand and dark ink on a light one", () => {
    expect(readableOn("#172a3a")).toBe("#ffffff");
    expect(readableOn("#0a7cff")).toBe("#ffffff");
    expect(readableOn("#e62627")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#172a3a");
    expect(readableOn("#f5d90a")).toBe("#172a3a");
    expect(readableOn("#ffd1b8")).toBe("#172a3a");
  });

  it("judges by luminance, not by how bright the hex looks: a saturated yellow is light, a saturated blue is dark", () => {
    expect(readableOn("#ffcc00")).toBe("#172a3a");
    expect(readableOn("#0000ff")).toBe("#ffffff");
  });

  it("reads upper case, and falls back to dark ink for what is not a six-digit colour", () => {
    expect(readableOn("#0A7CFF")).toBe("#ffffff");
    expect(readableOn(" #ffffff ")).toBe("#172a3a");
    expect(readableOn("red")).toBe("#172a3a");
    expect(readableOn("#fff")).toBe("#172a3a");
    expect(readableOn("")).toBe("#172a3a");
  });
});
