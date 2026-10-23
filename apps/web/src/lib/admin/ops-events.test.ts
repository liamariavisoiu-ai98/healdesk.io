import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { OPS_EVENTS, isOpsEvent } from "./ops-events";

/**
 * The mirrored event list is the apps/app list, name for name. The test
 * reads `OPS_EVENTS` out of apps/app's source rather than importing it:
 * apps/web must not import from apps/app (the PHI boundary), and a copy that
 * drifts would let an alert arrive with no tab and no runbook anchor.
 */

const NOTIFY = join(__dirname, "..", "..", "..", "..", "app", "src", "lib", "ops", "notify.ts");

function appsAppEvents(): string[] {
  const source = readFileSync(NOTIFY, "utf8");
  const block = source.match(/export const OPS_EVENTS = \[([\s\S]*?)\] as const;/);
  const body = block?.[1];
  if (body === undefined) throw new Error("apps/app's OPS_EVENTS block was not found");
  return [...body.replace(/\/\/[^\n]*/g, "").matchAll(/"([a-z0-9_]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

describe("the mirrored ops event list", () => {
  test("is apps/app's list, in full and with nothing extra", () => {
    const theirs = appsAppEvents();
    expect(theirs.length).toBeGreaterThan(50);
    expect([...OPS_EVENTS].sort()).toEqual([...theirs].sort());
  });

  test("names are unique and the guard accepts only them", () => {
    expect(new Set(OPS_EVENTS).size).toBe(OPS_EVENTS.length);
    expect(isOpsEvent("transcript_undelivered")).toBe(true);
    expect(isOpsEvent("Transcript undelivered")).toBe(false);
    expect(isOpsEvent("")).toBe(false);
    expect(isOpsEvent(null)).toBe(false);
  });
});
