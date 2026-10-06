import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";

import { __setKeyWrapperForTests, type KmsClientLike } from "@/lib/crypto/kms";

/**
 * A key ARN of the shape HEALDESK_KMS_KEY_ID must have. The account and key id
 * are AWS's own documentation examples: no such key exists.
 */
export const TEST_KEY_ARN =
  "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

export type KmsCall = { command: string; keyId: string | undefined; keySpec?: string };

/**
 * A stand-in for KMS, given to AwsKmsKeyWrapper in place of KMSClient.
 *
 * It receives the real SDK's command objects, so a test reads exactly what KMS
 * would have been sent. Behind it, one key held in memory, with the two
 * properties of the real service the wrapper depends on: a ciphertext is bound
 * to the key that made it, and Decrypt refuses a KeyId that is not that key.
 * `fail` makes every call reject with an error of that name, the way the SDK
 * surfaces a service error; `hang` makes every call wait forever.
 */
export function fakeKms(
  keyArn: string = TEST_KEY_ARN,
  options: { fail?: string; hang?: boolean } = {},
): { client: KmsClientLike; calls: KmsCall[] } {
  const master = randomBytes(32);
  const calls: KmsCall[] = [];

  const wrap = (plaintext: Uint8Array): Uint8Array => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(Buffer.from(keyArn));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
  };

  const unwrap = (blob: Uint8Array): Uint8Array => {
    const raw = Buffer.from(blob);
    const decipher = createDecipheriv("aes-256-gcm", master, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(keyArn));
    decipher.setAuthTag(raw.subarray(12, 28));
    return new Uint8Array(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
  };

  const serviceError = (name: string): Error =>
    Object.assign(new Error(`stand-in KMS: ${name}`), { name });

  async function send(command: unknown): Promise<unknown> {
    if (options.hang) return new Promise(() => {});
    if (options.fail) throw serviceError(options.fail);

    if (command instanceof GenerateDataKeyCommand) {
      const { KeyId, KeySpec } = command.input;
      calls.push({ command: "GenerateDataKey", keyId: KeyId, keySpec: KeySpec });
      const dek = randomBytes(32);
      return { KeyId: keyArn, Plaintext: new Uint8Array(dek), CiphertextBlob: wrap(dek) };
    }
    if (command instanceof DecryptCommand) {
      calls.push({ command: "Decrypt", keyId: command.input.KeyId });
      if (command.input.KeyId !== keyArn) throw serviceError("IncorrectKeyException");
      return { KeyId: keyArn, Plaintext: unwrap(command.input.CiphertextBlob!) };
    }
    if (command instanceof EncryptCommand) {
      calls.push({ command: "Encrypt", keyId: command.input.KeyId });
      return { KeyId: keyArn, CiphertextBlob: wrap(command.input.Plaintext!) };
    }
    throw new Error("stand-in KMS: a command the wrapper should never send");
  }

  return { client: { send } as unknown as KmsClientLike, calls };
}

/**
 * Everything getKeyWrapper() and the SDK's client read from the environment
 * that a test here sets. tests/setup/env.ts has already removed the shell's
 * own AWS credentials and endpoints; they are on this list so that a test can
 * set placeholders, signed for a stand-in endpoint, and have them taken away
 * again afterwards.
 */
const KEY_ENV = [
  "HEALDESK_KMS_PROVIDER",
  "HEALDESK_KMS_KEY_ID",
  "NODE_ENV",
  "AWS_REGION",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_KMS",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
] as const;

export type KeyEnvironment = Partial<Record<(typeof KEY_ENV)[number], string | undefined>>;

let snapshot: Record<string, string | undefined> | undefined;

/**
 * Set the key's environment for one test: a value sets the variable,
 * `undefined` removes it. Call `restoreKeyEnvironment` (from afterEach) to put
 * back whatever tests/setup/env.ts left there.
 *
 * The wrapper is built once per process and cached, so the cache is cleared
 * on the way in and out: a test that sets a variable after something already
 * built a wrapper would otherwise be testing the old one.
 */
export function setKeyEnvironment(vars: KeyEnvironment): void {
  snapshot ??= Object.fromEntries(KEY_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __setKeyWrapperForTests(undefined);
}

export function restoreKeyEnvironment(): void {
  if (snapshot) {
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    snapshot = undefined;
  }
  __setKeyWrapperForTests(undefined);
}
