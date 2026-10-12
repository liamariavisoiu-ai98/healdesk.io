import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";

import type { CredentialIdentity, SealedPayload } from "@/lib/crypto/envelope";
import { __setKeyWrapperForTests, type KmsClientLike } from "@/lib/crypto/kms";

/**
 * A key ARN of the shape HEALDESK_KMS_KEY_ID must have. The account and key id
 * are AWS's own documentation examples: no such key exists.
 */
export const TEST_KEY_ARN =
  "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

/** One request as the stand-in received it. `encryptionContext` only when one was sent. */
export type KmsCall = {
  command: string;
  keyId: string | undefined;
  keySpec?: string;
  encryptionContext?: Record<string, string>;
};

/**
 * A stand-in for KMS, given to AwsKmsKeyWrapper in place of KMSClient.
 *
 * It receives the real SDK's command objects, so a test reads exactly what KMS
 * would have been sent. Behind it, one key held in memory, with the three
 * properties of the real service the wrapper depends on: a ciphertext is bound
 * to the key that made it; Decrypt refuses a KeyId that is not that key; and a
 * ciphertext is bound to the encryption context it was made under, so Decrypt
 * with any other context, or none, is refused as KMS refuses it, with
 * InvalidCiphertextException. Like KMS, the context's order does not matter
 * and its case does. `fail` makes every call reject with an error of that
 * name, the way the SDK surfaces a service error; `hang` makes every call wait
 * forever.
 */
export function fakeKms(
  keyArn: string = TEST_KEY_ARN,
  options: { fail?: string; hang?: boolean } = {},
): { client: KmsClientLike; calls: KmsCall[] } {
  const master = randomBytes(32);
  const calls: KmsCall[] = [];

  const serviceError = (name: string): Error =>
    Object.assign(new Error(`stand-in KMS: ${name}`), { name });

  const boundTo = (context: Record<string, string> | undefined): Buffer =>
    Buffer.from(
      JSON.stringify([keyArn, Object.entries(context ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))]),
    );

  const wrap = (plaintext: Uint8Array, context: Record<string, string> | undefined): Uint8Array => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(boundTo(context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
  };

  const unwrap = (blob: Uint8Array, context: Record<string, string> | undefined): Uint8Array => {
    const raw = Buffer.from(blob);
    const decipher = createDecipheriv("aes-256-gcm", master, raw.subarray(0, 12));
    decipher.setAAD(boundTo(context));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
      return new Uint8Array(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
    } catch {
      throw serviceError("InvalidCiphertextException");
    }
  };

  const record = (
    command: string,
    input: { KeyId?: string; KeySpec?: string; EncryptionContext?: Record<string, string> },
  ) =>
    calls.push({
      command,
      keyId: input.KeyId,
      ...(input.KeySpec ? { keySpec: input.KeySpec } : {}),
      ...(input.EncryptionContext ? { encryptionContext: { ...input.EncryptionContext } } : {}),
    });

  async function send(command: unknown): Promise<unknown> {
    if (options.hang) return new Promise(() => {});
    if (options.fail) throw serviceError(options.fail);

    if (command instanceof GenerateDataKeyCommand) {
      record("GenerateDataKey", command.input);
      const dek = randomBytes(32);
      return {
        KeyId: keyArn,
        Plaintext: new Uint8Array(dek),
        CiphertextBlob: wrap(dek, command.input.EncryptionContext),
      };
    }
    if (command instanceof DecryptCommand) {
      record("Decrypt", command.input);
      if (command.input.KeyId !== keyArn) throw serviceError("IncorrectKeyException");
      return {
        KeyId: keyArn,
        Plaintext: unwrap(command.input.CiphertextBlob!, command.input.EncryptionContext),
      };
    }
    if (command instanceof EncryptCommand) {
      record("Encrypt", command.input);
      return {
        KeyId: keyArn,
        CiphertextBlob: wrap(command.input.Plaintext!, command.input.EncryptionContext),
      };
    }
    throw new Error("stand-in KMS: a command the wrapper should never send");
  }

  return { client: { send } as unknown as KmsClientLike, calls };
}

/**
 * An envelope as seal() wrote it before lock labels (aad_version 1), for
 * proving that such envelopes still open: the payload under the AAD
 * `v1|clinic:…|credential:…`, and its data key wrapped with no label. Either
 * by a local KEK exactly as LocalKeyWrapper wrapped one then (iv, tag and body,
 * no AAD), or by a KMS stand-in sent no encryption context.
 * tests/lock-labels.test.ts also opens one the pre-label code itself sealed,
 * which is what says this reproduces that format rather than imagines it.
 */
export async function sealAsVersionOne(
  plaintext: string,
  identity: CredentialIdentity,
  wrapUnder: { kekBase64: string } | { kms: KmsClientLike; keyArn?: string },
): Promise<SealedPayload> {
  const dek = randomBytes(32);
  let wrappedDek: string;
  let keyVersion: string;

  if ("kekBase64" in wrapUnder) {
    const kek = Buffer.from(wrapUnder.kekBase64, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    wrappedDek = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    keyVersion = `local-${createHash("sha256").update(kek).digest("hex").slice(0, 8)}`;
  } else {
    const keyArn = wrapUnder.keyArn ?? TEST_KEY_ARN;
    const result = await wrapUnder.kms.send(new EncryptCommand({ KeyId: keyArn, Plaintext: dek }));
    wrappedDek = Buffer.from(result.CiphertextBlob!).toString("base64url");
    keyVersion = `kms:${keyArn}`;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(`v1|clinic:${identity.clinicId}|credential:${identity.credentialId}`));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: body.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    wrappedDek,
    keyVersion,
    aadVersion: 1,
  };
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
