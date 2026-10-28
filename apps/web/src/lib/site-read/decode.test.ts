import { describe, expect, test } from "vitest";
import { decodeWindows1252, isWindows1252 } from "./decode";

describe("windows-1252 decoding by the WHATWG index", () => {
  test("curly quotes, dashes and the euro sign are the glyphs, not C1 controls", () => {
    const bytes = Uint8Array.from([0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x80]);
    expect(decodeWindows1252(bytes)).toBe("‘’“”–—€");
  });

  test("the five undefined bytes decode to the C1 controls of the same value", () => {
    const bytes = Uint8Array.from([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
    expect(decodeWindows1252(bytes)).toBe("\u0081\u008d\u008f\u0090\u009d");
  });

  test("ASCII and the Latin-1 range pass through", () => {
    expect(decodeWindows1252(Uint8Array.from([0x41, 0xe9, 0xff, 0xa0]))).toBe("Aéÿ ");
  });

  test("a long body decodes whole", () => {
    const bytes = new Uint8Array(20_000).fill(0x97);
    expect(decodeWindows1252(bytes)).toBe("—".repeat(20_000));
  });

  test.each(["windows-1252", "cp1252", "iso-8859-1", "latin1", "us-ascii", "ISO-8859-1", " Latin1 "])(
    "%s is windows-1252",
    (label) => expect(isWindows1252(label)).toBe(true),
  );

  test.each(["utf-8", "windows-1251", "iso-8859-2", "shift_jis", "utf-16le"])(
    "%s is not",
    (label) => expect(isWindows1252(label)).toBe(false),
  );
});
