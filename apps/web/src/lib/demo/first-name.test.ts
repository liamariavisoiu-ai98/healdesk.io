import { demoFirstName } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { cleanFirstName } from "./first-name";

/**
 * The page's check of a first name and the routes' (`demoFirstName`) are two
 * copies of one rule, because the routes' cannot be bundled for the browser.
 * Whatever the page accepts, the server must keep as it is.
 */

describe("cleanFirstName", () => {
  test.each(["Sam", "Anne-Marie", "O’Brien", "O'Brien", "José", "Zoë", "李", "  Sam  "])("accepts %s", (typed) => {
    const clean = cleanFirstName(typed);
    expect(clean).toBe(typed.trim());
    expect(demoFirstName(typed)).toBe(clean);
  });

  test.each(["", "   ", "Sam Lee", "Sam1", "-Sam", "'Sam", "<b>", "Sam;", "x".repeat(41), 7, null, undefined, { a: 1 }])(
    "refuses %j",
    (typed) => {
      expect(cleanFirstName(typed)).toBeNull();
    },
  );

  test("accepts forty characters and no more", () => {
    expect(cleanFirstName("a".repeat(40))).toBe("a".repeat(40));
    expect(cleanFirstName("a".repeat(41))).toBeNull();
  });
});
