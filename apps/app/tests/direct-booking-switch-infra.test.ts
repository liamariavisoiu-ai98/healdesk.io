import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { currentDirectBookingAddendum } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

/**
 * DB-1 §4.2: the two release flags kept equal by a test.
 *
 * Counsel's release of the Direct booking addendum lives twice: in the
 * catalog (`approvedByCounsel`, which the running build's
 * directBookingOpen() reads) and in Terraform (`direct_booking_addendum_released`,
 * which `direct_booking_enabled` needs before it may set
 * HEALDESK_DIRECT_BOOKING_ENABLED on a task). The addendum version lives
 * twice too: the catalog's and `direct_booking_addendum_version`, which
 * becomes HEALDESK_DIRECT_BOOKING_ADDENDUM. If they drift the app fails
 * closed anyway, but this makes releasing the addendum one commit that edits
 * both, and turning the switch on in production.tfvars impossible before it.
 *
 * Reads infra/aws as text, like one-off-tasks.test.ts: no Terraform needed.
 */

const INFRA = fileURLToPath(new URL("../../../infra/aws/", import.meta.url));
const variablesTf = readFileSync(`${INFRA}variables.tf`, "utf8");
const productionTfvars = readFileSync(`${INFRA}production.tfvars`, "utf8");

/** The body of `variable "<name>" { ... }`, matched by braces; throws when the variable is missing. */
function variableBlock(name: string): string {
  const head = new RegExp(`^variable\\s+"${name}"\\s*\\{`, "m").exec(variablesTf);
  if (!head) throw new Error(`variables.tf has no variable "${name}"`);
  let depth = 0;
  for (let i = head.index + head[0].length - 1; i < variablesTf.length; i++) {
    const ch = variablesTf[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return variablesTf.slice(head.index, i + 1);
  }
  throw new Error(`variable "${name}" is not closed`);
}

/** The variable's top-level `default = ...` value, as written. */
function defaultOf(name: string): string {
  const match = /^\s{2}default\s*=\s*(.+?)\s*$/m.exec(variableBlock(name));
  if (!match) throw new Error(`variable "${name}" has no default`);
  return match[1]!;
}

/** The value production.tfvars assigns, or null when it leaves the default. Comments ignored. */
function tfvar(name: string): string | null {
  const lines = productionTfvars.split("\n").map((line) => line.replace(/\s*(#|\/\/).*$/, ""));
  const found = lines
    .map((line) => new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line))
    .filter((m): m is RegExpExecArray => m !== null);
  expect(found.length, `${name} is assigned at most once`).toBeLessThanOrEqual(1);
  return found[0]?.[1] ?? null;
}

function bool(value: string, name: string): boolean {
  if (value !== "true" && value !== "false") throw new Error(`${name} is ${value}, not a bool literal`);
  return value === "true";
}

const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1");

describe("the direct-booking release flags, catalog and Terraform", () => {
  const addendum = currentDirectBookingAddendum();

  test("the variables the switch is built from exist and default to off", () => {
    expect(bool(defaultOf("direct_booking_enabled"), "direct_booking_enabled default")).toBe(false);
    // The release variable may default to true only once the catalog says so.
    const releasedDefault = bool(defaultOf("direct_booking_addendum_released"), "released default");
    if (releasedDefault) expect(addendum.approvedByCounsel).toBe(true);
    // The switch is refused unless the addendum is released.
    expect(variableBlock("direct_booking_enabled")).toMatch(
      /condition\s*=\s*!var\.direct_booking_enabled\s*\|\|\s*var\.direct_booking_addendum_released/,
    );
  });

  test("production's addendum release equals the catalog's approvedByCounsel", () => {
    const value = tfvar("direct_booking_addendum_released") ?? defaultOf("direct_booking_addendum_released");
    expect(bool(value, "direct_booking_addendum_released")).toBe(addendum.approvedByCounsel === true);
  });

  test("the addendum version Terraform deploys is the catalog's current one", () => {
    expect(unquote(defaultOf("direct_booking_addendum_version"))).toBe(addendum.version);
    const set = tfvar("direct_booking_addendum_version");
    if (set !== null) expect(unquote(set)).toBe(addendum.version);
  });

  test("production.tfvars turns the switch on only with the addendum released", () => {
    const enabled = bool(tfvar("direct_booking_enabled") ?? defaultOf("direct_booking_enabled"), "direct_booking_enabled");
    if (enabled) expect(addendum.approvedByCounsel).toBe(true);
    // Today, with counsel's addendum unreleased, the switch is off in production.
    if (addendum.approvedByCounsel !== true) expect(enabled).toBe(false);
  });
});
