import { describe, expect, test } from "vitest";
import { buildFooter, OPT_OUT_PHRASE, POSTAL_ADDRESS } from "../src/enrich/footer.ts";

const footer = (touch: number) => buildFooter({ senderName: "Sarah Whitfield", touch });

describe("the three things CAN-SPAM requires", () => {
  test("every touch identifies itself as a solicitation", () => {
    // The identification is required on every commercial message, not only the
    // first, so it changes wording rather than dropping off the later ones.
    for (const t of [1, 2, 3, 4, 9]) {
      expect(footer(t), `touch ${t}`).toMatch(/sales note/);
    }
  });

  test("every touch names a working way to decline", () => {
    for (const t of [1, 2, 3, 4]) {
      expect(footer(t)).toContain(`reply "${OPT_OUT_PHRASE}"`);
    }
  });

  test("every touch carries the postal address", () => {
    for (const t of [1, 2, 3, 4]) {
      expect(footer(t)).toContain(POSTAL_ADDRESS);
    }
    // A street, a city, a state and a ZIP. An address missing one of those is
    // not one mail arrives at, which is the actual test the statute applies.
    expect(POSTAL_ADDRESS).toMatch(/\d+ .+, .+, [A-Z]{2} \d{5}$/);
  });
});

describe("it has to survive being read by a person", () => {
  test("no em dashes, no semicolons", () => {
    expect(footer(1)).not.toMatch(/[—;]/);
  });

  test("it is four lines, not a legal block", () => {
    // A footer longer than the email undoes the point of a short email.
    expect(footer(1).split("\n")).toHaveLength(4);
  });

  test("the sender is named, because an unattributed footer identifies nobody", () => {
    expect(footer(1)).toContain("Sarah Whitfield");
    expect(footer(1)).toContain("healdesk");
  });
});
