import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AwsKmsKeyWrapper } from "@/lib/crypto/kms";
import { getTransport } from "@/lib/reporting/deliver";

import nextConfig from "../next.config";

/**
 * The two AWS SDK clients, and what keeps them loadable in a production build.
 *
 * Until 6 October 2026 both were optional dependencies, installed nowhere and
 * imported through a `const` specifier. Turbopack folded the constant, found no
 * package, and compiled each import into an unconditional
 * `throw MODULE_NOT_FOUND` in the server chunk. Every production build therefore
 * had no KMS, so with getKeyWrapper() refusing the local wrapper in production
 * it could seal and open no secret, and it could never send through SES. Adding
 * the SDK to the image afterwards changed nothing, because the throw was in the
 * chunk.
 *
 * Three facts fixed it, and this file pins each:
 *
 *   1. both are dependencies of @healdesk/app, resolvable from it, so the
 *      build finds them;
 *   2. both are in next.config.ts's serverExternalPackages, so the chunk
 *      `require`s them from node_modules rather than bundling a copy;
 *   3. each wrapper loads its client through a literal specifier, lazily. The
 *      source is read for the literal, because a bundler that has to recover
 *      the name by folding a constant is the arrangement that failed. The stubs
 *      below are registered under exactly those names, so a stub answering is
 *      the proof of which package loads, and their load counters are the proof
 *      that nothing loads before it is used.
 *
 * Whether the chunks come out right is a fact about the build, not the source,
 * and a production build is where that was verified. These are the cheap
 * guards that fail first when one of the three is undone.
 */

const SDKS = ["@aws-sdk/client-kms", "@aws-sdk/client-sesv2"] as const;

const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as {
  dependencies: Record<string, string>;
};

/** What each stub saw. Hoisted, because vi.mock factories are lifted above imports. */
const wire = vi.hoisted(() => ({
  kms: { loads: 0, sent: [] as Array<{ command: string; input: Record<string, unknown> }> },
  ses: {
    loads: 0,
    configs: [] as Array<Record<string, unknown>>,
    sent: [] as Array<{ command: string; input: Record<string, unknown> }>,
  },
}));

vi.mock("@aws-sdk/client-kms", () => {
  wire.kms.loads += 1;
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GenerateDataKeyCommand extends Command {}
  class DecryptCommand extends Command {}
  class EncryptCommand extends Command {}

  // A fake KMS whose "wrapping" is a visible prefix, so unwrap can be checked.
  const PREFIX = Buffer.from("kms-stub:");
  return {
    GenerateDataKeyCommand,
    DecryptCommand,
    EncryptCommand,
    KMSClient: class {
      async send(command: Command) {
        wire.kms.sent.push({ command: command.constructor.name, input: command.input });
        if (command instanceof GenerateDataKeyCommand) {
          const dek = Buffer.alloc(32, 7);
          return { Plaintext: dek, CiphertextBlob: Buffer.concat([PREFIX, dek]) };
        }
        if (command instanceof DecryptCommand) {
          return { Plaintext: (command.input.CiphertextBlob as Buffer).subarray(PREFIX.length) };
        }
        return { CiphertextBlob: Buffer.concat([PREFIX, command.input.Plaintext as Buffer]) };
      }
    },
  };
});

vi.mock("@aws-sdk/client-sesv2", () => {
  wire.ses.loads += 1;
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetConfigurationSetCommand extends Command {}
  class SendEmailCommand extends Command {}
  return {
    GetConfigurationSetCommand,
    SendEmailCommand,
    SESv2Client: class {
      constructor(config: Record<string, unknown>) {
        wire.ses.configs.push(config);
      }
      async send(command: Command) {
        wire.ses.sent.push({ command: command.constructor.name, input: command.input });
        return command instanceof GetConfigurationSetCommand
          ? { DeliveryOptions: { TlsPolicy: "REQUIRE" } }
          : { MessageId: "ses-stub-0001" };
      }
    },
  };
});

describe("the build can resolve both clients and keeps them external", () => {
  test.each(SDKS)("%s is a dependency, resolvable from apps/app, and external", (name) => {
    expect(manifest.dependencies[name], `${name} in dependencies`).toBeDefined();
    expect(() => createRequire(packageJson).resolve(name)).not.toThrow();
    expect(nextConfig.serverExternalPackages).toContain(name);
  });

  test.each([
    ["src/lib/crypto/kms.ts", "@aws-sdk/client-kms"],
    ["src/lib/reporting/deliver.ts", "@aws-sdk/client-sesv2"],
  ])("%s imports %s by a literal specifier", (file, name) => {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    expect(source).toContain(`await import("${name}")`);
  });
});

describe("AwsKmsKeyWrapper", () => {
  test("loads @aws-sdk/client-kms on first use, not before, and once", async () => {
    const wrapper = new AwsKmsKeyWrapper("alias/healdesk-test");
    expect(wire.kms.loads).toBe(0);

    const { dek, wrapped } = await wrapper.generateDek();
    expect(wire.kms.loads).toBe(1);
    expect(wrapped.keyVersion).toBe("kms:alias/healdesk-test");

    expect((await wrapper.unwrapDek(wrapped)).equals(dek)).toBe(true);
    await wrapper.wrapExisting(dek);
    expect(wire.kms.loads).toBe(1);

    expect(wire.kms.sent.map((s) => s.command)).toEqual([
      "GenerateDataKeyCommand",
      "DecryptCommand",
      "EncryptCommand",
    ]);
    expect(wire.kms.sent[0]!.input).toEqual({ KeyId: "alias/healdesk-test", KeySpec: "AES_256" });
    expect(wire.kms.sent[1]!.input.KeyId).toBe("alias/healdesk-test");
  });
});

describe("SesTransport", () => {
  const KEYS = [
    "HEALDESK_EMAIL_TRANSPORT",
    "HEALDESK_SES_CONFIGURATION_SET",
    "HEALDESK_EMAIL_FROM",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.HEALDESK_EMAIL_TRANSPORT = "ses";
    process.env.HEALDESK_SES_CONFIGURATION_SET = "healdesk-phi";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("loads @aws-sdk/client-sesv2 only once SES is used, with the bounded client", async () => {
    const transport = getTransport("may-carry-phi");
    expect(transport.name).toBe("ses");
    expect(wire.ses.loads).toBe(0);

    const result = await transport.send(
      { to: "owner@clinic.test", clinicId: "c1", clinicName: "Radiance Med Spa" },
      { subject: "Hello", text: "Hello.", html: "", phiClass: "may-carry-phi" },
    );

    expect(result).toEqual({ status: "sent", messageId: "ses-stub-0001" });
    expect(wire.ses.loads).toBe(1);
    expect(wire.ses.sent.map((s) => s.command)).toEqual([
      "GetConfigurationSetCommand",
      "SendEmailCommand",
    ]);
    expect(wire.ses.configs[0]).toMatchObject({
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 20_000 },
    });
  });
});
