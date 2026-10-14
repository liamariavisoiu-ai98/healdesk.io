import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { isSet, KEY_PRESENCE_NAMES, keyPresence, stripeModeOf } from "@/lib/ops/key-presence";

/**
 * keyPresence (lib/ops/key-presence.ts): what /admin/map asks the AWS host
 * about its keys. It may say yes or no per name and whether Stripe is on test
 * or live keys, and nothing else: no value, no length, nothing derived from a
 * secret beyond its public mode prefix.
 */

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const repo = join(__dirname, "..", "..", "..");

describe("keyPresence", () => {
  test("is a read: on the list, off the mutating half, so it writes no audit row", () => {
    expect(isOpName("keyPresence")).toBe(true);
    expect(isMutating("keyPresence")).toBe(false);
  });

  test("an empty value and the Parameter Store placeholder both count as unset", () => {
    expect(isSet(undefined)).toBe(false);
    expect(isSet("")).toBe(false);
    expect(isSet("   ")).toBe(false);
    expect(isSet("__unset__")).toBe(false);
    expect(isSet(" __unset__ ")).toBe(false);
    expect(isSet("re_abc")).toBe(true);
  });

  test("the Stripe mode comes from the public prefix only, and nothing else is read from a value", () => {
    expect(stripeModeOf("sk_test_123")).toBe("test");
    expect(stripeModeOf("rk_live_123")).toBe("live");
    expect(stripeModeOf("pk_live_123")).toBeNull();
    expect(stripeModeOf("whsec_123")).toBeNull();
    expect(stripeModeOf("__unset__")).toBeNull();
    expect(stripeModeOf(undefined)).toBeNull();
  });

  test("answers every listed name, and no value or length crosses", () => {
    const secret = "sk_live_THIS-MUST-NEVER-CROSS-0123456789";
    const source: Record<string, string> = {
      STRIPE_SECRET_KEY: secret,
      RESEND_API_KEY: "re_ALSO-NEVER-CROSSES",
      META_APP_SECRET: "__unset__",
      // Asked by nobody: a name off the list is never looked up.
      SOME_OTHER_SECRET: "nope",
    };

    const answer = keyPresence(source);
    expect(Object.keys(answer.present)).toEqual([...KEY_PRESENCE_NAMES]);
    expect(answer.present.STRIPE_SECRET_KEY).toBe(true);
    expect(answer.present.RESEND_API_KEY).toBe(true);
    expect(answer.present.META_APP_SECRET).toBe(false);
    expect(answer.present.ANTHROPIC_API_KEY).toBe(false);
    expect(answer.stripeMode).toBe("live");

    const wire = JSON.stringify(answer);
    expect(wire).not.toContain("THIS-MUST-NEVER-CROSS");
    expect(wire).not.toContain("ALSO-NEVER-CROSSES");
    expect(wire).not.toContain("SOME_OTHER_SECRET");
    expect(wire).not.toContain(String(secret.length));
  });

  test("the operation answers 200 with the same projection", async () => {
    const outcome = await runOperation("keyPresence", {}, OPERATOR);
    expect(outcome.status).toBe(200);
    const data = (outcome.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["present", "stripeMode"]);
  });

  /**
   * A name the web task is never given reads "missing" on a host where it is
   * perfectly in place, and the map would tell the owner to paste a key that
   * is already there. So every name asked about must be one Terraform hands
   * the web task: an app/* parameter (ssm.tf) or a name the stack sets as
   * plain environment (locals.tf, stack_environment_names).
   */
  test("asks only about names Terraform gives the web task", () => {
    const ssm = readFileSync(join(repo, "infra", "aws", "ssm.tf"), "utf8");
    const locals = readFileSync(join(repo, "infra", "aws", "locals.tf"), "utf8");

    const block = (source: string, start: RegExp): string => {
      const at = source.search(start);
      expect(at, String(start)).toBeGreaterThan(-1);
      const rest = source.slice(at);
      return rest.slice(0, rest.search(/\n\s*[\]}]\s*\n/));
    };
    const quoted = (text: string) => new Set([...text.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]!));

    const external = quoted(block(ssm, /external_parameter_names\s*=\s*\[/));
    const internalApp = new Set(
      [...block(ssm, /internal_parameter_paths\s*=\s*\{/).matchAll(/([A-Z][A-Z0-9_]+)\s*=\s*"app\//g)].map(
        (m) => m[1]!,
      ),
    );
    const plain = quoted(block(locals, /stack_environment_names\s*=\s*\[/));

    for (const name of KEY_PRESENCE_NAMES) {
      expect(external.has(name) || internalApp.has(name) || plain.has(name), `${name} reaches the web task`).toBe(true);
    }
  });
});
