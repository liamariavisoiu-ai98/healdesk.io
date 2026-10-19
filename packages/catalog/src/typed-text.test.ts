import { describe, expect, test } from "vitest";

import { isSafeTypedText } from "./typed-text";

/**
 * What a stranger may have put into an email we send to an address nobody
 * confirmed (Annex X5, P6): a practice's or a person's name, never a link,
 * an address or a number to call.
 */
describe("isSafeTypedText", () => {
  test.each([
    "Radiance Med Spa LLC",
    "Smith & Jones Dermatology, P.L.L.C.",
    "Dr. Ana Pérez-Núñez",
    "O'Brien’s Skin + Laser (Austin) #2",
    "Clínica Estética São Paulo",
    "Alex Chen",
    "Owner",
  ])("a name is safe: %s", (name) => {
    expect(isSafeTypedText(name)).toBe(true);
  });

  test.each([
    ["a link", "Visit https://evil.example now"],
    ["a domain", "Radiance.com Med Spa"],
    ["www.", "www evil www.example"],
    ["an address", "claim@prize-desk"],
    ["a path", "Smith/Jones"],
    ["a colon", "Act now: call us"],
    ["a phone number", "Call 5125550100"],
    ["markup", "<b>Radiance</b>"],
    ["a line break", "Radiance\nClick here"],
    ["quotes", 'The "best" spa'],
    ["empty", "   "],
  ])("%s is not: %s", (_why, name) => {
    expect(isSafeTypedText(name)).toBe(false);
  });

  test("the length is the caller's cap, in characters", () => {
    expect(isSafeTypedText("a".repeat(120), 120)).toBe(true);
    expect(isSafeTypedText("a".repeat(121), 120)).toBe(false);
    expect(isSafeTypedText(42)).toBe(false);
  });
});
